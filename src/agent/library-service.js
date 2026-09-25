(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function valueOf(value) {
    return value && typeof value.then === "function" ? value : Promise.resolve(value);
  }

  function itemID(item) {
    return Number(item?.id || item?.itemID || 0) || 0;
  }

  function libraryID(item) {
    return Number(item?.libraryID || 0) || 0;
  }

  function parentID(item) {
    return Number(item?.parentID || item?.parentItemID || 0) || 0;
  }

  function itemKey(item) {
    return String(item?.key || "");
  }

  function isAttachment(item) {
    try { return Boolean(item?.isAttachment?.()); }
    catch (_) { return String(item?.itemType || "") === "attachment"; }
  }

  function isNote(item) {
    try { return Boolean(item?.isNote?.()); }
    catch (_) { return String(item?.itemType || "") === "note"; }
  }

  function isRegular(item) {
    try { return Boolean(item?.isRegularItem?.()); }
    catch (_) { return !isAttachment(item) && !isNote(item); }
  }

  function field(item, name) {
    try { return String(item?.getField?.(name) ?? ""); }
    catch (_) { return String(item?.[name] ?? ""); }
  }

  function normalizeDate(value) {
    const text = String(value || "").trim();
    const match = text.match(/\b(\d{4})\b/);
    return match ? match[1] : "";
  }

  function creatorName(creator) {
    if (!creator) return "";
    if (creator.name) return String(creator.name).trim();
    return [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim();
  }

  function creatorRows(item) {
    let creators = [];
    try { creators = item?.getCreators?.() || []; }
    catch (_) { creators = Array.isArray(item?.creators) ? item.creators : []; }
    return (Array.isArray(creators) ? creators : []).map(creator => ({
      name: creatorName(creator),
      firstName: String(creator?.firstName || ""),
      lastName: String(creator?.lastName || ""),
      creatorType: String(creator?.creatorType || "")
    })).filter(row => row.name);
  }

  function tags(item) {
    try {
      return (item?.getTags?.() || []).map(tag => String(tag?.tag || tag || "").trim()).filter(Boolean);
    }
    catch (_) { return []; }
  }

  function collectionIDs(item) {
    try { return (item?.getCollections?.() || []).map(Number).filter(Number.isFinite); }
    catch (_) { return Array.isArray(item?.collections) ? item.collections.map(Number).filter(Number.isFinite) : []; }
  }

  function noteRows(item) {
    let ids = [];
    try { ids = item?.getNotes?.(false) || []; }
    catch (_) { ids = []; }
    if (!Array.isArray(ids)) ids = Object.values(ids || {});
    return ids.map(value => typeof value === "number" ? global.Zotero?.Items?.get?.(value) : value).filter(Boolean);
  }

  function attachmentRows(item) {
    let ids = [];
    try { ids = item?.getAttachments?.(false) || []; }
    catch (_) { ids = []; }
    if (!Array.isArray(ids)) ids = Object.values(ids || {});
    return ids.map(value => typeof value === "number" ? global.Zotero?.Items?.get?.(value) : value).filter(Boolean);
  }

  function collectionRowsForItem(item) {
    return collectionIDs(item).map(id => {
      try { return global.Zotero?.Collections?.get?.(id); }
      catch (_) { return null; }
    }).filter(Boolean);
  }

  function searchFieldValues(item, fieldName) {
    const key = String(fieldName || "").replace(/[-_ ]/g, "").toLocaleLowerCase();
    if (["creator", "creators", "author"].includes(key)) return creatorRows(item).flatMap(row => [row.name, row.firstName, row.lastName]).filter(Boolean);
    if (["tag", "tags"].includes(key)) return tags(item);
    if (["collection", "collections"].includes(key)) return collectionRowsForItem(item).flatMap(row => [row.name, row.key, row.id, row.collectionID]).filter(value => value !== undefined && value !== null).map(String);
    if (["attachment", "attachments"].includes(key)) return attachmentRows(item).flatMap(row => [row.key, row.attachmentFilename, row.attachmentContentType, field(row, "title"), field(row, "url")]).filter(Boolean);
    if (["note", "notes"].includes(key)) return noteRows(item).flatMap(row => [row.key, row.getNote?.(), row.note]).filter(Boolean).map(String);
    if (["abstract", "abstractnote"].includes(key)) return [field(item, "abstractNote")];
    if (["publication", "publicationtitle", "journal"].includes(key)) return [field(item, "publicationTitle"), field(item, "journalAbbreviation")].filter(Boolean);
    if (key === "doi") return [field(item, "DOI")];
    if (key === "isbn") return [field(item, "ISBN")];
    if (["itemtype", "type"].includes(key)) return [String(item?.itemType || item?.getItemType?.() || "")];
    if (key === "year") return [normalizeDate(field(item, "date"))];
    if (["date", "issued"].includes(key)) return [field(item, "date")];
    if (["dateadded", "added"].includes(key)) return [String(item?.dateAdded || "")];
    if (["datemodified", "modified"].includes(key)) return [String(item?.dateModified || "")];
    if (key === "fulltext") return [item?.fulltext, item?.fullText, item?.fulltextText, field(item, "extra")].filter(Boolean).map(String);
    if (key === "url") return [field(item, "url")];
    if (key === "language") return [field(item, "language")];
    if (key === "rights") return [field(item, "rights")];
    if (key === "extra") return [field(item, "extra")];
    if (key === "title") return [field(item, "title")];
    return [field(item, fieldName) || String(item?.[fieldName] || "")].filter(Boolean);
  }

  function searchOperatorMatch(actualValues, operator, expected) {
    const values = Array.isArray(actualValues) ? actualValues : [actualValues];
    const normalizedOperator = String(operator || "contains").replace(/[ _-]/g, "").toLocaleLowerCase();
    const expectedValues = Array.isArray(expected) ? expected.map(String) : String(expected ?? "").split(",").map(value => value.trim()).filter(Boolean);
    const wanted = String(expected ?? "").toLocaleLowerCase();
    const compareOne = actual => {
      const value = String(actual ?? "");
      const lower = value.toLocaleLowerCase();
      if (["exists", "present"].includes(normalizedOperator)) return Boolean(value.trim());
      if (["notexists", "absent"].includes(normalizedOperator)) return !value.trim();
      if (["equals", "equal", "is", "exact"].includes(normalizedOperator)) return lower === wanted;
      if (["notequals", "isnot", "not"].includes(normalizedOperator)) return lower !== wanted;
      if (["startswith", "prefix"].includes(normalizedOperator)) return lower.startsWith(wanted);
      if (["endswith", "suffix"].includes(normalizedOperator)) return lower.endsWith(wanted);
      if (["regex", "matches"].includes(normalizedOperator)) {
        try { return new RegExp(String(expected), "i").test(value); }
        catch (_) { return false; }
      }
      if (["gt", "greaterthan", "after"].includes(normalizedOperator)) return (Number(value) || Date.parse(value) || 0) > (Number(expected) || Date.parse(String(expected)) || 0);
      if (["gte", "greaterthanorequal", "onorafter"].includes(normalizedOperator)) return (Number(value) || Date.parse(value) || 0) >= (Number(expected) || Date.parse(String(expected)) || 0);
      if (["lt", "lessthan", "before"].includes(normalizedOperator)) return (Number(value) || Date.parse(value) || 0) < (Number(expected) || Date.parse(String(expected)) || 0);
      if (["lte", "lessthanorequal", "onorbefore"].includes(normalizedOperator)) return (Number(value) || Date.parse(value) || 0) <= (Number(expected) || Date.parse(String(expected)) || 0);
      if (["in", "oneof"].includes(normalizedOperator)) return expectedValues.some(value => value.toLocaleLowerCase() === lower);
      if (["notin", "noneof"].includes(normalizedOperator)) return expectedValues.every(value => value.toLocaleLowerCase() !== lower);
      return lower.includes(wanted);
    };
    if (["notcontains", "doesnotcontain"].includes(normalizedOperator)) return values.every(value => !String(value ?? "").toLocaleLowerCase().includes(wanted));
    if (["notequals", "isnot", "not", "notin", "noneof", "notexists", "absent"].includes(normalizedOperator)) return values.every(compareOne);
    return values.some(compareOne);
  }

  function normalizeFieldQueries(value, operators = {}) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(query => ({ field: query?.field || query?.name, operator: query?.operator || operators?.[query?.field || query?.name] || "contains", value: query?.value ?? query?.query })).filter(query => query.field && query.value !== undefined);
    if (typeof value !== "object") return [];
    return Object.entries(value).map(([fieldName, query]) => {
      if (query && typeof query === "object" && !Array.isArray(query)) return { field: fieldName, operator: query.operator || operators?.[fieldName] || "contains", value: query.value ?? query.query ?? query.expected };
      return { field: fieldName, operator: operators?.[fieldName] || "contains", value: query };
    }).filter(query => query.value !== undefined);
  }

  function fieldQueriesMatch(item, options = {}) {
    const operators = options.operators && typeof options.operators === "object" ? options.operators : {};
    const queries = normalizeFieldQueries(options.fieldQueries, operators);
    if (!queries.length) return true;
    const matches = queries.map(query => searchOperatorMatch(searchFieldValues(item, query.field), query.operator, query.value));
    const logic = String(options.queryLogic || options.logic || options.operators?.logic || "and").toLocaleLowerCase();
    return logic === "or" ? matches.some(Boolean) : matches.every(Boolean);
  }

  function booleanOption(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "string") return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
    return Boolean(value);
  }

  function rangeValues(value, separator = "-") {
    if (value === undefined || value === null || value === "") return [null, null];
    const parts = String(value).split(separator, 2).map(part => String(part || "").trim());
    if (parts.length !== 2) return [null, null];
    return [parts[0] || null, parts[1] || null];
  }

  function cleanNoteText(value) {
    return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  async function saveWithNotifier(entity) {
    const coordinator = Agent.getZoteroWriteCoordinator?.();
    if (coordinator) return coordinator.saveEntity(entity);
    throw new C.AgentError("WRITE_COORDINATOR_UNAVAILABLE", "Zotero 写入协调器尚未初始化", { recoverable: true, suggestedAction: "retry" });
  }

  class LibraryService {
    constructor(controller) {
      this.controller = controller;
      this.statusProvider = null;
      this.writeCoordinator = Agent.getZoteroWriteCoordinator?.({ logger: message => controller?.log?.(message) }) || null;
    }

    async saveEntity(entity) {
      if (this.writeCoordinator) return this.writeCoordinator.saveEntity(entity);
      return saveWithNotifier(entity);
    }

    async libraries() {
      const api = global.Zotero?.Libraries;
      let rows = [];
      try { rows = await valueOf(api?.getAll?.() || []); }
      catch (_) { rows = []; }
      if (!Array.isArray(rows)) rows = Object.values(rows || {});
      if (!rows.length && api?.userLibrary) rows = [api.userLibrary];
      return rows.filter(Boolean).map(library => ({
        libraryID: libraryID(library),
        id: libraryID(library),
        key: String(library?.key || ""),
        name: String(library?.name || library?.libraryName || (library?.libraryID === 1 ? "My Library" : "")),
        type: String(library?.type || (library?.libraryID === 1 ? "user" : "group")),
        editable: library?.editable !== false,
        filesEditable: library?.filesEditable !== false,
        readOnly: library?.editable === false
      })).filter(row => row.libraryID);
    }

    async getLibrary(ref) {
      const wanted = Number(ref?.libraryID ?? ref?.id ?? ref) || 0;
      const rows = await this.libraries();
      const row = rows.find(item => item.libraryID === wanted || (ref && String(item.key) === String(ref)));
      if (!row) throw new C.AgentError("LIBRARY_NOT_FOUND", `未找到文献库 ${ref}`, { recoverable: false });
      return row;
    }

    async allItems(libraryIDValue, options = {}) {
      const api = global.Zotero?.Items;
      let rows = [];
      try {
        if (typeof api?.getAll === "function") {
          const requested = Number(libraryIDValue) || 0;
          const libraries = requested ? [requested] : (await this.libraries()).map(row => row.libraryID).filter(Boolean);
          if (libraries.length) {
            for (const id of libraries) {
              const part = await valueOf(api.getAll(id, Boolean(options.includeDeleted), true));
              rows.push(...(Array.isArray(part) ? part : Object.values(part || {})));
            }
          }
          else rows = await valueOf(api.getAll(undefined, Boolean(options.includeDeleted), true));
        }
      }
      catch (_) { rows = []; }
      if (!Array.isArray(rows)) rows = Object.values(rows || {});
      rows = rows.map(row => typeof row === "number" ? global.Zotero.Items.get(row) : row).filter(Boolean);
      return rows.filter(item => options.includeDeleted || !item.deleted);
    }

    async resolveItem(ref, options = {}) {
      if (ref && typeof ref === "object" && (ref.id || ref.key || ref.itemID)) {
        if (typeof ref.getField === "function") return ref;
        ref = ref.itemID || ref.id || ref.key;
      }
      const text = String(ref ?? "").trim();
      const numeric = Number(text);
      if (numeric && global.Zotero?.Items?.get) {
        const item = global.Zotero.Items.get(numeric);
        if (item && !item.deleted) return item;
      }
      const doc = this.controller?.storage?.parseDocumentID?.(text);
      if (doc && global.Zotero?.Items?.getByLibraryAndKey) {
        const found = global.Zotero.Items.getByLibraryAndKey(doc.libraryID, doc.key);
        const item = typeof found === "number" ? global.Zotero.Items.get(found) : found;
        if (item && !item.deleted) return item;
      }
      const library = options.libraryID ? Number(options.libraryID) : 0;
      if (library && global.Zotero?.Items?.getByLibraryAndKey) {
        const found = global.Zotero.Items.getByLibraryAndKey(library, text);
        const item = typeof found === "number" ? global.Zotero.Items.get(found) : found;
        if (item && !item.deleted) return item;
      }
      const rows = await this.allItems(library || undefined, { includeDeleted: false });
      const item = rows.find(row => String(row.key || "") === text || String(row.itemID || row.id || "") === text);
      if (item) return item;
      throw new C.AgentError("ITEM_NOT_FOUND", `未找到 Zotero 条目 ${text}`, { recoverable: false });
    }

    async resolveAttachment(itemOrRef) {
      const item = typeof itemOrRef === "object" ? itemOrRef : await this.resolveItem(itemOrRef);
      if (isAttachment(item)) return item;
      try {
        const best = await valueOf(item?.getBestAttachment?.());
        const resolved = typeof best === "number" ? global.Zotero.Items.get(best) : best;
        if (resolved) return resolved;
      }
      catch (_) {}
      const ids = item?.getAttachments?.() || [];
      const rows = (Array.isArray(ids) ? ids : []).map(id => global.Zotero.Items.get(id)).filter(Boolean);
      const preferred = rows.find(row => String(row.attachmentContentType || "").toLowerCase() === "application/pdf")
        || rows.find(row => LitMTrans.Constants?.SUPPORTED_INPUT_EXTENSIONS?.has?.(LitMTrans.Utils.extension(row.attachmentFilename || "")))
        || rows[0];
      if (!preferred) throw new C.AgentError("ATTACHMENT_NOT_FOUND", "该条目没有可用附件", { recoverable: false });
      return preferred;
    }

    async attachmentFor(item) {
      try { return await this.resolveAttachment(item); }
      catch (_) { return null; }
    }

    async collectionRows(libraryIDValue = 0) {
      const api = global.Zotero?.Collections;
      let rows = [];
      try {
        if (libraryIDValue && typeof api?.getByLibrary === "function") rows = await valueOf(api.getByLibrary(Number(libraryIDValue)) || []);
        else if (typeof api?.getAll === "function") rows = await valueOf(api.getAll() || []);
      }
      catch (_) { rows = []; }
      if (!Array.isArray(rows)) rows = Object.values(rows || {});
      rows = rows.map(row => typeof row === "number" ? api.get(row) : row).filter(Boolean);
      return rows.filter(row => !libraryIDValue || libraryID(row) === Number(libraryIDValue));
    }

    async nativeSearch(options = {}) {
      const Search = global.Zotero?.Search;
      if (typeof Search !== "function") return null;
      const libraryIDs = Number(options.libraryID || 0)
        ? [Number(options.libraryID)]
        : (await this.libraries()).map(row => row.libraryID).filter(Boolean);
      const conditions = [];
      const add = (condition, operator, value) => {
        if (value !== undefined && value !== null && String(value).trim() !== "") conditions.push([condition, operator, String(value)]);
      };
      add("quicksearch-everything", "contains", options.query);
      add("title", "contains", options.title);
      add("creator", "contains", options.creator);
      add("abstractNote", "contains", options.abstract);
      add("DOI", "is", options.DOI);
      add("ISBN", "is", options.ISBN);
      add("publicationTitle", "contains", options.publication);
      add("language", "is", options.language);
      add("rights", "contains", options.rights);
      add("url", "contains", options.url);
      add("extra", "contains", options.extra);
      add("itemType", "is", options.itemType);
      if (options.collection) {
        let collectionValue = String(options.collection);
        try {
          const collectionRows = await this.collectionRows(Number(options.libraryID || 0));
          const wanted = collectionValue.toLocaleLowerCase();
          const found = collectionRows.find(row => String(row.id || row.collectionID || "") === collectionValue
            || String(row.key || "").toLocaleLowerCase() === wanted
            || String(row.name || row.getName?.() || "").toLocaleLowerCase() === wanted);
          if (found) collectionValue = String(itemID(found));
        }
        catch (_) {}
        add("collection", "is", collectionValue);
      }
      add("tag", "is", options.tag);
      if (!conditions.length) return null;
      const found = [];
      try {
        for (const id of libraryIDs) {
          const search = new Search();
          search.libraryID = id;
          for (const [condition, operator, value] of conditions) search.addCondition(condition, operator, value);
          const ids = await valueOf(search.search());
          for (const value of Array.isArray(ids) ? ids : Object.values(ids || {})) {
            const item = typeof value === "number" ? global.Zotero.Items.get(value) : value;
            if (item) found.push(item);
          }
        }
        return [...new Map(found.map(item => [itemID(item), item])).values()];
      }
      catch (_) {
        return null;
      }
    }

    async fulltextSearch(options = {}) {
      const query = typeof options.fulltext === "string" ? options.fulltext.trim() : "";
      if (!query || typeof global.Zotero?.Search !== "function") return null;
      const requestedMode = String(options.fulltextMode || "both").toLowerCase();
      const mode = ["attachment", "note", "both"].includes(requestedMode) ? requestedMode : "both";
      const operator = String(options.fulltextOperator || "contains").toLowerCase() === "exact" ? "is" : "contains";
      const libraryIDs = Number(options.libraryID || 0)
        ? [Number(options.libraryID)]
        : (await this.libraries()).map(row => row.libraryID).filter(Boolean);
      const matched = new Set();
      const search = async (itemType, condition, targetParent = true) => {
        for (const libraryIDValue of libraryIDs) {
          const instance = new global.Zotero.Search();
          instance.libraryID = libraryIDValue;
          instance.addCondition("itemType", "is", itemType);
          instance.addCondition(condition, operator, query);
          const values = await valueOf(instance.search());
          for (const value of Array.isArray(values) ? values : Object.values(values || {})) {
            const item = typeof value === "number" ? global.Zotero.Items?.get?.(value) : value;
            if (!item) continue;
            const target = targetParent ? (parentID(item) || itemID(item)) : itemID(item);
            if (target) matched.add(target);
          }
        }
      };
      try {
        if (mode === "attachment" || mode === "both") await search("attachment", "fulltextContent", true);
        if (mode === "note" || mode === "both") await search("note", "note", true);
        return matched;
      }
      catch (_) {
        return null;
      }
    }

    collectionPath(collection, byID) {
      const parts = [];
      const seen = new Set();
      let current = collection;
      while (current && !seen.has(itemID(current))) {
        seen.add(itemID(current));
        const name = String(current.name || current.getName?.() || "").trim();
        if (name) parts.unshift(name);
        const parent = Number(current.parentID || 0);
        current = parent ? byID.get(parent) : null;
      }
      return parts.join(" > ");
    }

    async listCollections(options = {}) {
      const rows = await this.collectionRows(Number(options.libraryID || 0));
      const byID = new Map(rows.map(row => [itemID(row), row]));
      const query = String(options.query || options.search || "").trim().toLocaleLowerCase();
      return rows.map(collection => {
        const formatted = Agent.CollectionFormatter?.formatCollectionBrief(collection, byID) || {
          id: itemID(collection), collectionID: itemID(collection), key: String(collection.key || ""),
          libraryID: libraryID(collection), name: String(collection.name || collection.getName?.() || ""),
          parentID: Number(collection.parentID || 0) || null, path: this.collectionPath(collection, byID)
        };
        return { ...formatted, editable: collection.editable !== false };
      }).filter(row => !query || `${row.name} ${row.path}`.toLocaleLowerCase().includes(query));
    }

    async resolveCollection(ref, options = {}) {
      const text = String(ref?.collectionID ?? ref?.id ?? ref?.key ?? ref ?? "").trim();
      const numeric = Number(text);
      const rows = await this.listCollections({ libraryID: options.libraryID });
      const found = rows.find(row => (numeric && row.id === numeric) || row.key === text || row.path === text || row.name === text);
      if (!found) throw new C.AgentError("COLLECTION_NOT_FOUND", `未找到 Collection ${text}`, { recoverable: false });
      const collection = global.Zotero.Collections?.get?.(found.id) || found;
      return { ...found, object: collection };
    }

    async getCollection(ref, options = {}) {
      const resolved = await this.resolveCollection(ref, options);
      const rows = await this.collectionRows(Number(options.libraryID || resolved.libraryID || 0));
      const byID = new Map(rows.map(row => [itemID(row), row]));
      const collection = resolved.object;
      let formatted;
      if (options.tree) formatted = Agent.CollectionFormatter?.formatCollectionTree(collection, byID);
      else if (options.details || options.includeItems || options.includeSubcollections) {
        formatted = await Agent.CollectionFormatter?.formatCollectionDetails(collection, options, byID);
      }
      else formatted = Agent.CollectionFormatter?.formatCollection(collection, byID);
      return { ...(formatted || resolved), editable: collection?.editable !== false };
    }

    async getCollectionItems(ref, options = {}) {
      const collection = await this.resolveCollection(ref, options);
      let ids = [];
      try {
        ids = await valueOf(collection.object?.getChildItems?.(Boolean(options.includeTrashed)) || []);
      }
      catch (_) { ids = []; }
      if (!Array.isArray(ids)) ids = Object.values(ids || {});
      let items = ids.map(id => typeof id === "number" ? global.Zotero.Items.get(id) : id).filter(Boolean);
      if (!options.includeAttachments) items = items.filter(isRegular);
      const offset = Math.max(0, Number(options.offset || 0));
      const limit = Math.max(1, Number(options.limit || 100));
      const sliced = items.slice(offset, offset + limit);
      const result = [];
      for (const item of sliced) result.push(await this.itemRecord(item, { includeStatus: options.includeStatus !== false }));
      const collectionInfo = { ...collection };
      delete collectionInfo.object;
      return { collection: collectionInfo, total: items.length, offset, limit, nextOffset: offset + sliced.length < items.length ? offset + sliced.length : null, items: result };
    }

    async collectAllCollectionItems(ref, options = {}) {
      const pageSize = Math.max(1, Number(options.pageSize || options.limit || 100));
      const items = [];
      let offset = 0;
      let collection = null;
      let total = 0;
      while (true) {
        const page = await this.getCollectionItems(ref, { ...options, offset, limit: pageSize });
        collection = page.collection;
        total = Number(page.total || total || 0);
        items.push(...(page.items || []));
        if (page.nextOffset == null || !page.items?.length) break;
        if (page.nextOffset <= offset) break;
        offset = page.nextOffset;
      }
      return { collection, total, offset: 0, limit: pageSize, nextOffset: null, items };
    }

    async itemRecord(item, options = {}) {
      const attachment = await this.attachmentFor(item);
      const parent = isAttachment(item) ? (parentID(item) ? global.Zotero.Items.get(parentID(item)) : null) : item;
      const source = parent || item;
      const formatted = Agent.ItemFormatter?.formatItem(source, {
        developer: options.developer === true,
        includePaths: options.includePaths === true
      }) || {};
      const attachments = [];
      try {
        const ids = source?.getAttachments?.() || [];
        for (const id of Array.isArray(ids) ? ids : []) {
          const row = global.Zotero.Items.get(id);
          if (row) attachments.push({ id: itemID(row), key: itemKey(row), fileName: String(row.attachmentFilename || ""), contentType: String(row.attachmentContentType || "") });
        }
      }
      catch (_) {}
      const collections = [];
      for (const id of collectionIDs(source)) {
        try {
          const row = global.Zotero.Collections?.get?.(id);
          if (row) collections.push({ id, key: String(row.key || ""), name: String(row.name || row.getName?.() || "") });
        }
        catch (_) {}
      }
      const output = {
        ...formatted,
        id: itemID(source),
        key: itemKey(source),
        libraryID: libraryID(source),
        itemType: String(source?.itemType || source?.getItemType?.() || ""),
        title: field(source, "title") || String(source?.getDisplayTitle?.() || ""),
        abstract: field(source, "abstractNote"),
        creators: creatorRows(source),
        creator: creatorRows(source).map(row => row.name).join(", "),
        date: field(source, "date"),
        year: normalizeDate(field(source, "date")),
        DOI: field(source, "DOI"),
        ISBN: field(source, "ISBN"),
        publication: field(source, "publicationTitle"),
        journal: field(source, "journalAbbreviation"),
        url: field(source, "url"),
        tags: tags(source),
        collections,
        attachmentKey: attachment ? itemKey(attachment) : "",
        attachmentID: attachment ? itemID(attachment) : 0,
        documentID: attachment
          ? (this.controller.storage.documentID?.(attachment) || `${libraryID(attachment)}-${itemKey(attachment)}`)
          : "",
        attachments: Array.isArray(formatted.attachments) && formatted.attachments.length ? formatted.attachments : attachments,
        dateAdded: String(source?.dateAdded || ""),
        dateModified: String(source?.dateModified || "")
      };
      if (options.includeFields || options.detail === "full") {
        const fields = {};
        try {
          const typeID = Number(source?.itemTypeID || global.Zotero.ItemTypes?.getID?.(source?.itemType)) || 0;
          const fieldIDs = global.Zotero.ItemFields?.getItemTypeFields?.(typeID) || [];
          for (const fieldID of fieldIDs) {
            const name = global.Zotero.ItemFields?.getName?.(fieldID) || global.Zotero.ItemFields?.getFieldNameFromID?.(fieldID) || "";
            if (!name || /(?:path|fileName|attachmentPath)/i.test(name)) continue;
            const value = field(source, name);
            if (value) fields[name] = value;
          }
        }
        catch (_) {}
        output.fields = fields;
      }
      if (options.includeStatus && attachment && this.statusProvider) {
        try { output.litmtrans = await this.statusProvider(attachment); }
        catch (error) { output.litmtrans = { error: String(error?.message || error) }; }
      }
      return C.redact(output);
    }

    matches(item, options = {}) {
      const query = String(options.query || "").trim().toLocaleLowerCase();
      const creator = creatorRows(item).map(row => row.name).join(" ");
      const tagsText = tags(item).join(" ");
      const haystack = [field(item, "title"), field(item, "abstractNote"), field(item, "DOI"), field(item, "ISBN"), field(item, "publicationTitle"), field(item, "language"), field(item, "rights"), field(item, "url"), field(item, "extra"), creator, tagsText, ...searchFieldValues(item, "attachments"), ...searchFieldValues(item, "notes"), ...searchFieldValues(item, "fulltext")].join(" ").toLocaleLowerCase();
      if (query && !haystack.includes(query)) return false;
      const contains = (fieldName, value) => !value || searchOperatorMatch(searchFieldValues(item, fieldName), "contains", value);
      const equals = (fieldName, value) => !value || searchOperatorMatch(searchFieldValues(item, fieldName), "equals", value);
      if (!contains("title", options.title)) return false;
      if (!contains("creator", options.creator)) return false;
      if (!equals("DOI", options.DOI)) return false;
      if (!equals("ISBN", options.ISBN)) return false;
      if (!contains("publication", options.publication)) return false;
      if (!contains("abstract", options.abstract)) return false;
      if (!equals("language", options.language)) return false;
      if (!contains("rights", options.rights) || !contains("url", options.url) || !contains("extra", options.extra)) return false;
      if (options.itemType && !equals("itemType", options.itemType)) return false;

      const operatorMatch = (fieldName, value, operator) => !value || searchOperatorMatch(searchFieldValues(item, fieldName), operator || "contains", value);
      if (options.titleOperator && !operatorMatch("title", options.title, options.titleOperator)) return false;
      if (options.creatorOperator && !operatorMatch("creator", options.creator, options.creatorOperator)) return false;
      if (options.publicationTitleOperator && !operatorMatch("publication", options.publicationTitle, options.publicationTitleOperator)) return false;
      if (options.abstractOperator && !operatorMatch("abstract", options.abstractText, options.abstractOperator)) return false;

      const wantedTags = options.tags ?? options.tag;
      if (wantedTags) {
        const requestedTags = (Array.isArray(wantedTags) ? wantedTags : String(wantedTags).split(","))
          .map(value => String(value || "").trim()).filter(Boolean);
        const tagValues = searchFieldValues(item, "tags");
        const tagOperator = options.tagMatch || "contains";
        const matchedTags = requestedTags.filter(value => searchOperatorMatch(tagValues, tagOperator, value));
        const tagMode = String(options.tagMode || "any").toLowerCase();
        if ((tagMode === "all" && matchedTags.length !== requestedTags.length)
          || (tagMode === "none" && matchedTags.length > 0)
          || (tagMode !== "all" && tagMode !== "none" && matchedTags.length === 0)) return false;
      }
      const year = Number(normalizeDate(field(item, "date")));
      if (options.year && year !== Number(options.year)) return false;
      if (options.yearFrom && (!year || year < Number(options.yearFrom))) return false;
      if (options.yearTo && (!year || year > Number(options.yearTo))) return false;
      if (options.yearRange) {
        const [from, to] = rangeValues(options.yearRange);
        if (from && (!year || year < Number(from))) return false;
        if (to && (!year || year > Number(to))) return false;
      }
      if (options.dateFrom && (!field(item, "date") || Date.parse(field(item, "date")) < Date.parse(String(options.dateFrom)))) return false;
      if (options.dateTo && (!field(item, "date") || Date.parse(field(item, "date")) > Date.parse(String(options.dateTo)))) return false;
      const attachmentQuery = options.attachmentQuery ?? (typeof options.attachments === "string" ? options.attachments : null);
      const hasAttachment = attachmentRows(item).length > 0;
      if (options.hasAttachment !== undefined && booleanOption(options.hasAttachment) !== hasAttachment) return false;
      if (booleanOption(options.attachments, false) && !hasAttachment) return false;
      if (attachmentQuery && !searchOperatorMatch(searchFieldValues(item, "attachments"), "contains", attachmentQuery)) return false;
      const noteQuery = options.noteQuery ?? (typeof options.notes === "string" ? options.notes : null);
      const hasNote = noteRows(item).length > 0;
      if (options.hasNote !== undefined && booleanOption(options.hasNote) !== hasNote) return false;
      if (booleanOption(options.notes, false) && !hasNote) return false;
      if (noteQuery && !searchOperatorMatch(searchFieldValues(item, "notes"), "contains", noteQuery)) return false;
      if (options.fulltext !== undefined && options.fulltext !== false) {
        if (typeof options.fulltext === "string") {
          const values = searchFieldValues(item, "fulltext");
          if (values.length && !searchOperatorMatch(values, options.fulltextOperator || "contains", options.fulltext)) return false;
          if (!values.length && !options.fulltextSearchResolved) return false;
        }
        if (options.fulltext === true && !searchFieldValues(item, "fulltext").length && !attachmentRows(item).length && !noteRows(item).length) return false;
      }
      if (options.collection && !searchOperatorMatch(searchFieldValues(item, "collection"), "contains", options.collection)) return false;
      const dateMatches = (value, from, to) => {
        if (from == null && to == null) return true;
        const timestamp = Date.parse(String(value || ""));
        if (!Number.isFinite(timestamp)) return false;
        if (from != null && timestamp < Date.parse(String(from))) return false;
        if (to != null && timestamp > Date.parse(String(to))) return false;
        return true;
      };
      let [dateAddedFrom, dateAddedTo] = [options.dateAddedFrom, options.dateAddedTo];
      if (options.dateAddedRange) [dateAddedFrom, dateAddedTo] = String(options.dateAddedRange).split(",").map(value => value.trim());
      if (options.dateAdded && !options.dateAddedRange && !dateAddedFrom && !dateAddedTo) [dateAddedFrom, dateAddedTo] = [options.dateAdded, options.dateAdded];
      let [dateModifiedFrom, dateModifiedTo] = [options.dateModifiedFrom, options.dateModifiedTo];
      if (options.dateModifiedRange) [dateModifiedFrom, dateModifiedTo] = String(options.dateModifiedRange).split(",").map(value => value.trim());
      if (options.dateModified && !options.dateModifiedRange && !dateModifiedFrom && !dateModifiedTo) [dateModifiedFrom, dateModifiedTo] = [options.dateModified, options.dateModified];
      if (!dateMatches(item?.dateAdded, dateAddedFrom, dateAddedTo)) return false;
      if (!dateMatches(item?.dateModified, dateModifiedFrom, dateModifiedTo)) return false;
      if (options.numPages || options.numPagesRange) {
        const pages = Number(field(item, "numPages")) || 0;
        if (options.numPages && pages !== Number(options.numPages)) return false;
        if (options.numPagesRange) {
          const [from, to] = rangeValues(options.numPagesRange);
          if (from && pages < Number(from)) return false;
          if (to && pages > Number(to)) return false;
        }
      }
      if (!fieldQueriesMatch(item, options)) return false;
      return true;
    }

    relevance(item, options = {}) {
      const query = String(options.query || options.q || "").trim().toLocaleLowerCase();
      if (!query) return 0;
      const weighted = [
        ["title", 12], ["creator", 8], ["abstract", 5], ["publication", 4], ["tags", 3],
        ["DOI", 3], ["ISBN", 3], ["extra", 2], ["fulltext", 1]
      ];
      let score = 0;
      for (const [name, weight] of weighted) {
        for (const value of searchFieldValues(item, name)) {
          const lower = String(value || "").toLocaleLowerCase();
          if (lower === query) score += weight * 3;
          else if (lower.includes(query)) score += weight;
        }
      }
      return score;
    }

    async searchItems(options = {}) {
      const normalized = {
        ...options,
        query: options.query ?? options.q,
        key: options.key ?? options.itemKey,
        tags: options.tags ?? options.tag,
        DOI: options.DOI ?? options.doi,
        ISBN: options.ISBN ?? options.isbn,
        publication: options.publication ?? options.publicationTitle,
        abstract: options.abstract ?? options.abstractText,
        sortBy: options.sortBy ?? options.sort,
        sortOrder: options.sortOrder ?? options.direction,
        fulltextSearchResolved: false
      };
      const library = Number(normalized.libraryID || 0);
      const fulltextIDs = await this.fulltextSearch(normalized);
      if (fulltextIDs instanceof Set) normalized.fulltextSearchResolved = true;
      let items = await this.nativeSearch(normalized);
      if (!items) items = await this.allItems(library || undefined, { includeDeleted: false });
      if (fulltextIDs instanceof Set) items = items.filter(item => fulltextIDs.has(itemID(item)) || fulltextIDs.has(parentID(item)));
      if (normalized.key) items = items.filter(item => String(item.key || "") === String(normalized.key) || String(item.id || item.itemID || "") === String(normalized.key));
      const explicitType = String(normalized.itemType || "").toLowerCase();
      if (!explicitType) {
        if (!booleanOption(normalized.includeAttachments, false)) items = items.filter(item => !isAttachment(item));
        if (!booleanOption(normalized.includeNotes, false)) items = items.filter(item => !isNote(item));
      }
      items = items.filter(item => this.matches(item, normalized));
      const sortBy = String(normalized.sortBy || "dateModified");
      const direction = String(normalized.sortOrder || "desc").toLowerCase() === "asc" ? 1 : -1;
      const sortValue = item => {
        if (sortBy === "relevance") return this.relevance(item, normalized);
        if (sortBy === "creator") return creatorRows(item).map(row => row.name).join(", ");
        if (sortBy === "title") return field(item, "title");
        return String(item?.[sortBy] || field(item, sortBy) || "");
      };
      items.sort((left, right) => {
        const a = sortValue(left);
        const b = sortValue(right);
        if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) * direction;
      });
      const offset = Math.max(0, Number(normalized.offset || 0));
      const limit = Math.max(1, Math.min(500, Number(normalized.limit || 50)));
      const rows = [];
      for (const item of items.slice(offset, offset + limit)) {
        const row = await this.itemRecord(item, { includeStatus: normalized.includeStatus !== false });
        if (sortBy === "relevance" || normalized.includeRelevance) row.relevance = this.relevance(item, normalized);
        rows.push(row);
      }
      return { total: items.length, offset, limit, nextOffset: offset + rows.length < items.length ? offset + rows.length : null, items: rows, query: normalized.query || "", sort: sortBy, direction: direction === 1 ? "asc" : "desc" };
    }

    async createCollection(values = {}) {
      const libraryIDValue = Number(values.libraryID || 1);
      const collection = new global.Zotero.Collection();
      collection.libraryID = libraryIDValue;
      collection.name = String(values.name || values.title || "").trim();
      if (!collection.name) throw new C.AgentError("INVALID_COLLECTION", "Collection 名称不能为空", { recoverable: false });
      if (values.parentID) collection.parentID = Number(values.parentID);
      await this.saveEntity(collection);
      return this.collectionRecord(collection);
    }

    collectionRecord(collection) {
      return Agent.CollectionFormatter?.formatCollection(collection) || {
        id: itemID(collection), collectionID: itemID(collection), key: String(collection?.key || ""),
        libraryID: libraryID(collection), name: String(collection?.name || collection?.getName?.() || ""),
        parentID: Number(collection?.parentID || 0) || null
      };
    }

    async updateCollection(ref, values = {}) {
      const resolved = await this.resolveCollection(ref);
      const collection = resolved.object;
      if (values.name != null) collection.name = String(values.name).trim();
      if (values.parentID !== undefined) collection.parentID = Number(values.parentID) || 0;
      await this.saveEntity(collection);
      return this.collectionRecord(collection);
    }

    async addItemsToCollection(ref, itemRefs = []) {
      const collection = await this.resolveCollection(ref);
      const items = [];
      for (const refItem of Array.isArray(itemRefs) ? itemRefs : [itemRefs]) {
        const item = await this.resolveItem(refItem);
        const ids = item.getCollections?.() || [];
        if (!ids.includes(collection.id)) item.setCollections?.([...ids, collection.id]);
        await this.saveEntity(item);
        items.push({ key: itemKey(item), id: itemID(item) });
      }
      return { collection: this.collectionRecord(collection.object), items };
    }

    async removeItemsFromCollection(ref, itemRefs = []) {
      const collection = await this.resolveCollection(ref);
      const items = [];
      for (const refItem of Array.isArray(itemRefs) ? itemRefs : [itemRefs]) {
        const item = await this.resolveItem(refItem);
        const ids = (item.getCollections?.() || []).filter(id => Number(id) !== Number(collection.id));
        item.setCollections?.(ids);
        await this.saveEntity(item);
        items.push({ key: itemKey(item), id: itemID(item) });
      }
      return { collection: this.collectionRecord(collection.object), items };
    }

    async addTags(ref, values = []) {
      const item = await this.resolveItem(ref);
      const requested = (Array.isArray(values) ? values : [values]).map(value => String(value || "").trim()).filter(Boolean);
      for (const tag of requested) item.addTag?.(tag);
      await this.saveEntity(item);
      return this.itemRecord(item, { includeStatus: false });
    }

    async removeTags(ref, values = []) {
      const item = await this.resolveItem(ref);
      const requested = new Set((Array.isArray(values) ? values : [values]).map(value => String(value || "").trim()).filter(Boolean));
      for (const tag of requested) item.removeTag?.(tag);
      await this.saveEntity(item);
      return this.itemRecord(item, { includeStatus: false });
    }

    async updateItemMetadata(ref, values = {}) {
      const item = await this.resolveItem(ref);
      const allowed = new Set(["title", "abstractNote", "date", "DOI", "ISBN", "publicationTitle", "journalAbbreviation", "url", "volume", "issue", "pages", "publisher", "language"]);
      for (const [key, value] of Object.entries(values || {})) {
        if (!allowed.has(key)) continue;
        item.setField?.(key, String(value ?? ""));
      }
      if (values.creators || values.author || values.authors) {
        const rawCreators = values.creators ?? values.authors ?? values.author;
        const normalized = Agent.ImportHelpers?.normalizeCreators?.(rawCreators, "author");
        if (Array.isArray(normalized) && typeof item.setCreators === "function") {
          item.setCreators(normalized);
        }
      }
      await this.saveEntity(item);
      return this.itemRecord(item, { includeStatus: false });
    }

    async createNote(ref, values = {}) {
      const parent = await this.resolveItem(ref);
      const note = new global.Zotero.Item("note");
      note.libraryID = libraryID(parent);
      note.parentID = itemID(parent);
      note.setNote?.(String(values.note ?? values.content ?? ""));
      if (values.tags) for (const tag of Array.isArray(values.tags) ? values.tags : [values.tags]) note.addTag?.(String(tag));
      await this.saveEntity(note);
      return this.itemRecord(note, { includeStatus: false });
    }

    async updateNote(ref, values = {}) {
      const note = await this.resolveItem(ref);
      if (!isNote(note)) throw new C.AgentError("NOT_NOTE", "目标条目不是 Note", { recoverable: false });
      if (values.note !== undefined || values.content !== undefined) note.setNote?.(String(values.note ?? values.content ?? ""));
      await this.saveEntity(note);
      return this.itemRecord(note, { includeStatus: false });
    }

    async deleteItem(ref) {
      const item = await this.resolveItem(ref);
      item.deleted = true;
      await this.saveEntity(item);
      return { deleted: true, id: itemID(item), key: itemKey(item), movedToTrash: true };
    }

    async createAnnotation(values = {}) {
      const attachment = await this.resolveAttachment(values.attachment || values.attachmentKey || values.item || values.itemKey);
      const annotation = new global.Zotero.Item("annotation");
      annotation.libraryID = libraryID(attachment);
      annotation.parentID = itemID(attachment);
      const fields = {
        annotationType: values.type || values.annotationType || "highlight",
        annotationText: values.text || values.annotationText || "",
        annotationComment: values.comment || values.annotationComment || "",
        annotationColor: values.color || values.annotationColor || "#ffd400",
        annotationPageLabel: values.pageLabel || String(values.page || ""),
        annotationPosition: typeof values.position === "string" ? values.position : JSON.stringify(values.position || { pageIndex: Math.max(0, Number(values.page || 1) - 1), rects: values.rects || values.rect ? [values.rect || values.rects] : [] })
      };
      for (const [key, value] of Object.entries(fields)) if (value !== "") annotation.setField?.(key, String(value));
      if (values.tags) for (const tag of Array.isArray(values.tags) ? values.tags : [values.tags]) annotation.addTag?.(String(tag));
      await this.saveEntity(annotation);
      return this.itemRecord(annotation, { includeStatus: false });
    }

    async updateAnnotation(ref, values = {}) {
      const annotation = await this.resolveItem(ref);
      const isAnnotationItem = String(annotation?.itemType || annotation?.getItemType?.() || "") === "annotation" || annotation?.isAnnotation?.();
      if (!isAnnotationItem) throw new C.AgentError("NOT_ANNOTATION", "目标条目不是 PDF Annotation", { recoverable: false });
      const fields = {
        annotationText: values.text ?? values.annotationText,
        annotationComment: values.comment ?? values.annotationComment,
        annotationColor: values.color ?? values.annotationColor,
        annotationPageLabel: values.pageLabel ?? (values.page == null ? undefined : String(values.page)),
        annotationPosition: values.position == null ? undefined : (typeof values.position === "string" ? values.position : JSON.stringify(values.position))
      };
      for (const [key, value] of Object.entries(fields)) if (value !== undefined) annotation.setField?.(key, String(value));
      if (values.tags) {
        for (const tag of annotation.getTags?.() || []) annotation.removeTag?.(tag.tag || tag);
        for (const tag of Array.isArray(values.tags) ? values.tags : [values.tags]) annotation.addTag?.(String(tag));
      }
      await this.saveEntity(annotation);
      return this.itemRecord(annotation, { includeStatus: false });
    }

    async listAnnotations(ref, options = {}) {
      const resolvedTarget = await this.resolveItem(ref);
      const noteTarget = isNote(resolvedTarget) ? resolvedTarget : null;
      const attachment = noteTarget
        ? (parentID(noteTarget) ? global.Zotero.Items.get(parentID(noteTarget)) : noteTarget)
        : await this.resolveAttachment(resolvedTarget);
      let rows = [];
      if (noteTarget) rows = [noteTarget];
      else {
        try {
          const annotations = await valueOf(attachment.getAnnotations?.() || []);
          rows = (Array.isArray(annotations) ? annotations : Object.values(annotations || {})).map(id => typeof id === "number" ? global.Zotero.Items.get(id) : id).filter(Boolean);
        }
        catch (_) {}
        if (global.Zotero.Items.getByParent) {
          try { rows = await valueOf(global.Zotero.Items.getByParent(itemID(attachment)) || rows); }
          catch (_) {}
        }
      }
      rows = rows.filter(item => noteTarget ? isNote(item) : String(item.itemType || item.getItemType?.() || "") === "annotation" || item.isAnnotation?.());
      let attachmentStatus = null;
      if (options.includeStatus !== false && this.statusProvider) {
        try { attachmentStatus = await this.statusProvider(attachment); }
        catch (_) { attachmentStatus = null; }
      }
      const documentID = this.controller?.storage?.documentID?.(attachment) || `${libraryID(attachment)}-${itemKey(attachment)}`;
      const normalized = rows.map(item => Agent.AnnotationFormatter?.normalize(item, {
        parent: attachment,
        attachmentKey: itemKey(attachment),
        documentID,
        litmtrans: attachmentStatus
      }) || this.itemRecord(item, { includeStatus: false }));
      const filtered = normalized.filter(row => Agent.AnnotationFormatter?.matches?.(row, options) !== false);
      const sorted = Agent.AnnotationFormatter?.sort?.(filtered, options.sort || "dateModified", options.direction || "desc") || filtered;
      return Agent.AnnotationFormatter?.paginate?.(sorted, options) || sorted;
    }
  }

  Agent.LibraryService = LibraryService;
  Agent.LibraryHelpers = { itemID, libraryID, parentID, itemKey, isAttachment, isRegular, field, tags, collectionIDs, saveWithNotifier };
})(this);
