(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;
  const H = Agent.PaperCardHelpers;

  function joinPath(...parts) {
    try { return global.PathUtils?.join?.(...parts) || parts.filter(Boolean).join("/"); }
    catch (_) { return parts.filter(Boolean).join("/"); }
  }

  function lower(value) { return String(value ?? "").toLocaleLowerCase(); }

  function isAbsolutePath(value) {
    const text = String(value || "");
    return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/");
  }

  class GeckoSQLiteAdapter {
    constructor(connection) { this.connection = connection; }

    async execute(sql, params = []) {
      if (typeof this.connection.executeCached === "function") return this.connection.executeCached(sql, params);
      return this.connection.execute(sql, params);
    }

    rowValue(row, name) {
      try { return row?.getResultByName?.(name); }
      catch (_) { return row?.[name]; }
    }

    async queryAsync(sql, params = []) {
      const rows = await this.execute(sql, params);
      if (!Array.isArray(rows)) return [];
      if (/SELECT\s+identity\s*,\s*payload/i.test(sql)) return rows.map(row => ({ identity: this.rowValue(row, "identity"), payload: this.rowValue(row, "payload") }));
      if (/SELECT\s+identity\s+/i.test(sql)) return rows.map(row => ({ identity: this.rowValue(row, "identity") }));
      if (/SELECT\s+type\s*,\s*sql\s+FROM\s+sqlite_master/i.test(sql)) return rows.map(row => ({ type: this.rowValue(row, "type"), sql: this.rowValue(row, "sql") }));
      return rows;
    }

    async valueQueryAsync(sql, params = []) {
      const rows = await this.execute(sql, params);
      return Array.isArray(rows) && rows[0] ? this.rowValue(rows[0], "value") : null;
    }

    async executeTransaction(callback) {
      if (typeof this.connection.executeTransaction === "function") return this.connection.executeTransaction(callback);
      return callback();
    }

    async closeDatabase() { await this.connection.close?.(); }
  }

  async function openSQLite(path) {
    const DBConnection = global.Zotero?.DBConnection;
    if (typeof DBConnection === "function") return new DBConnection(path);
    try {
      const imported = global.ChromeUtils?.importESModule?.("resource://gre/modules/Sqlite.sys.mjs");
      const Sqlite = imported?.Sqlite || global.Sqlite;
      if (typeof Sqlite?.openConnection !== "function") return null;
      return new GeckoSQLiteAdapter(await Sqlite.openConnection({ path }));
    }
    catch (_) { return null; }
  }

  function tokens(value) {
    return lower(value).split(/[^\p{L}\p{N}]+/u).map(token => token.trim()).filter(token => token.length > 1);
  }

  function sourceSignature(items = []) {
    let hash = 2166136261;
    const rows = [];
    for (const item of items) {
      if (!isRegularItem(item) || item?.deleted) continue;
      rows.push(`${item?.libraryID || 0}:${item?.key || item?.id || ""}:${item?.dateModified || ""}:${item?.version || ""}`);
    }
    rows.sort();
    const text = rows.join("|");
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${rows.length}:${hash >>> 0}`;
  }

  function cardValues(card) {
    const metadata = card?.metadata || {};
    const ids = card?.identifiers || {};
    const discovery = card?.discovery || {};
    return {
      title: lower(metadata.title),
      abstract: lower(card?.summary?.abstract),
      authors: lower((metadata.authors || []).map(row => row.name || row).join(" ")),
      venue: lower([metadata.venue, metadata.journal, metadata.publisher].filter(Boolean).join(" ")),
      tags: lower((card?.zotero?.tags || []).join(" ")),
      topics: lower((discovery.topics || []).join(" ")),
      keywords: lower([...(discovery.keywords || []), ...(discovery.concepts || [])].join(" ")),
      identifiers: lower([ids.doi, ids.arxiv, ids.pmid, ids.isbn, ids.url].filter(Boolean).join(" "))
    };
  }

  function isRegularItem(item) {
    try { return item?.isRegularItem?.() !== false && !item?.isAttachment?.() && !item?.isNote?.() && !item?.isAnnotation?.() && String(item?.itemType || "") !== "attachment"; }
    catch (_) { return !["attachment", "note", "annotation"].includes(String(item?.itemType || "")); }
  }

  class PaperCardIndex {
    constructor(controller, library, options = {}) {
      this.controller = controller;
      this.library = library;
      this.storage = controller?.storage || options.storage;
      this.path = options.path || joinPath(this.storage?.root || "", "literature-index.json");
      this.sqlitePath = options.sqlitePath || joinPath(this.storage?.root || "", "literature-index.sqlite");
      this.rows = [];
      this.updatedAt = "";
      this.sourceSignature = "";
      this.lastSourceCheckAt = 0;
      this.stale = true;
      this.backend = "json-fallback";
      this.sqliteMode = null;
      this.sqliteReason = "not-probed";
      this.sqlite = null;
      this.sqliteReady = false;
      this.fullTextReads = 0;
      this.statusForAttachment = options.statusForAttachment || null;
      this.cardFactory = options.cardFactory || (item => Agent.PaperCard.fromItem(item, {
        storage: this.storage,
        statusForAttachment: this.statusForAttachment
      }));
    }

    async tryInitializeSQLite() {
      if (this.sqliteReady) return Boolean(this.sqlite);
      this.sqliteReady = true;
      if (!isAbsolutePath(this.sqlitePath)) { this.sqliteReason = "path-not-absolute"; return false; }
      let database = null;
      try {
        database = await openSQLite(this.sqlitePath);
        if (!database) { this.sqliteReason = "sqlite-api-unavailable"; return false; }
        await database.queryAsync(`CREATE TABLE IF NOT EXISTS paper_cards (
          identity TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        )`);
        await database.queryAsync(`CREATE TABLE IF NOT EXISTS paper_card_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`);
        this.sqlite = database;
        let ftsBackend = "sqlite-scan";
        let sqliteMode = "scan";
        let fts5Error = null;
        const existingFTS = await database.queryAsync("SELECT type, sql FROM sqlite_master WHERE name = ?", ["paper_cards_fts"]);
        const existingFTSSQL = String(existingFTS?.[0]?.sql || "").toLowerCase();
        if (/using\s+fts5/.test(existingFTSSQL)) { ftsBackend = "sqlite-fts5"; sqliteMode = "fts5"; }
        else if (/using\s+fts4/.test(existingFTSSQL)) { ftsBackend = "sqlite-fts4"; sqliteMode = "fts4"; }
        else if (existingFTSSQL) { ftsBackend = "sqlite-scan"; sqliteMode = "scan"; }
        else try {
          await database.queryAsync(`CREATE VIRTUAL TABLE IF NOT EXISTS paper_cards_fts USING fts5(
            identity UNINDEXED,
            title,
            abstract,
            authors,
            venue,
            tags,
            topics,
            keywords,
            identifiers
          )`);
          ftsBackend = "sqlite-fts5";
          sqliteMode = "fts5";
        }
        catch (error) {
          fts5Error = error;
          try {
            await database.queryAsync(`CREATE VIRTUAL TABLE IF NOT EXISTS paper_cards_fts USING fts4(
              identity,
              title,
              abstract,
              authors,
              venue,
              tags,
              topics,
              keywords,
              identifiers
            )`);
            ftsBackend = "sqlite-fts4";
            sqliteMode = "fts4";
          }
          catch (fts4Error) {
            await database.queryAsync(`CREATE TABLE IF NOT EXISTS paper_cards_fts (
              identity TEXT PRIMARY KEY,
              title TEXT,
              abstract TEXT,
              authors TEXT,
              venue TEXT,
              tags TEXT,
              topics TEXT,
              keywords TEXT,
              identifiers TEXT
            )`);
            ftsBackend = "sqlite-scan";
            sqliteMode = "scan";
            fts5Error = fts4Error;
          }
        }
        this.backend = ftsBackend;
        this.sqliteMode = sqliteMode;
        this.sqliteReason = fts5Error ? `fts5-fts4-unavailable-using-sqlite-scan: ${String(fts5Error?.message || fts5Error)}` : "available";

        const records = await database.queryAsync("SELECT identity, payload FROM paper_cards");
        if (Array.isArray(records) && records.length) {
          this.rows = records.map(record => {
            try { return JSON.parse(record.payload); }
            catch (_) { return null; }
          }).filter(Boolean);
          try {
            this.updatedAt = String(await database.valueQueryAsync("SELECT value FROM paper_card_meta WHERE key = ?", ["updatedAt"]) || "");
            this.sourceSignature = String(await database.valueQueryAsync("SELECT value FROM paper_card_meta WHERE key = ?", ["sourceSignature"]) || "");
          } catch (_) {}
          this.stale = false;
        }
        return true;
      } catch (error) {
        try { await database?.closeDatabase?.(); } catch (_) {}
        this.sqlite = null;
        this.backend = "json-fallback";
        this.sqliteMode = null;
        this.sqliteReason = String(error?.message || error);
        try { this.controller?.log?.(`PaperCard SQLite 索引不可用，回退 JSON：${error?.message || error}`); } catch (_) {}
        return false;
      }
    }

    async writeSQLiteCards() {
      if (!this.sqlite) return false;
      const write = async () => {
        await this.sqlite.queryAsync("DELETE FROM paper_cards");
        await this.sqlite.queryAsync("DELETE FROM paper_cards_fts");
        for (const card of this.rows) {
          const identity = Agent.PaperCard.identity(card) || `${card?.local?.libraryID || 0}:${card?.local?.itemKey || ""}`;
          const values = cardValues(card);
          await this.sqlite.queryAsync("INSERT INTO paper_cards(identity, payload) VALUES (?, ?)", [identity, JSON.stringify(card)]);
          await this.sqlite.queryAsync(`INSERT INTO paper_cards_fts(identity, title, abstract, authors, venue, tags, topics, keywords, identifiers)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            identity,
            values.title,
            values.abstract,
            values.authors,
            values.venue,
            values.tags,
            values.topics,
            values.keywords,
            values.identifiers
          ]);
        }
        await this.sqlite.queryAsync("DELETE FROM paper_card_meta WHERE key = ?", ["updatedAt"]);
        await this.sqlite.queryAsync("INSERT INTO paper_card_meta(key, value) VALUES (?, ?)", ["updatedAt", this.updatedAt]);
        await this.sqlite.queryAsync("DELETE FROM paper_card_meta WHERE key = ?", ["sourceSignature"]);
        await this.sqlite.queryAsync("INSERT INTO paper_card_meta(key, value) VALUES (?, ?)", ["sourceSignature", this.sourceSignature]);
      };
      if (typeof this.sqlite.executeTransaction === "function") await this.sqlite.executeTransaction(write);
      else await write();
      return true;
    }

    async writeJSONSnapshot() {
      await this.storage?.ensureDir?.(this.storage?.root || "");
      await this.storage?.writeJSON?.(this.path, {
        schemaVersion: 1,
        backend: this.backend,
        sourceOfTruth: ["zotero-metadata", "litmtrans-document-storage", "external-metadata-cache"],
        ftsFields: ["title", "abstract", "authors", "venue", "tags", "topics", "keywords", "identifiers"],
        updatedAt: this.updatedAt,
        sourceSignature: this.sourceSignature,
        cards: this.rows
      });
    }

    async init() {
      const sqliteAvailable = await this.tryInitializeSQLite();
      if (sqliteAvailable && !this.stale && this.rows.length) {
        return { backend: this.backend, cardCount: this.rows.length, updatedAt: this.updatedAt };
      }
      const saved = await this.storage?.readJSON?.(this.path, null);
      if (saved?.schemaVersion === 1 && Array.isArray(saved.cards)) {
        this.rows = saved.cards.filter(Boolean);
        this.updatedAt = String(saved.updatedAt || "");
        this.sourceSignature = String(saved.sourceSignature || "");
        this.backend = sqliteAvailable ? this.backend : String(saved.backend || "json-fallback");
        this.stale = false;
        if (sqliteAvailable) await this.writeSQLiteCards();
      }
      return { backend: this.backend, cardCount: this.rows.length, updatedAt: this.updatedAt };
    }

    markStale() { this.stale = true; }

    async rebuild(options = {}) {
      await this.tryInitializeSQLite();
      const items = Array.isArray(options.items)
        ? options.items
        : await this.library?.allItems?.(options.libraryID, { includeDeleted: false }) || [];
      this.sourceSignature = sourceSignature(items);
      const cards = [];
      for (const item of items) {
        if (!isRegularItem(item) || item.deleted) continue;
        try { cards.push(await this.cardFactory(item)); }
        catch (error) { try { this.controller?.log?.(`PaperCard 构建失败：${error?.message || error}`); } catch (_) {} }
      }
      const deduped = new Map();
      for (const card of cards) {
        const key = Agent.PaperCard.identity(card) || `${card?.local?.libraryID || 0}:${card?.local?.itemKey || ""}`;
        if (!deduped.has(key)) deduped.set(key, card);
      }
      this.rows = [...deduped.values()];
      this.updatedAt = new Date().toISOString();
      this.lastSourceCheckAt = Date.now();
      this.backend = this.sqlite ? (this.sqliteMode === "fts5" ? "sqlite-fts5" : this.sqliteMode === "fts4" ? "sqlite-fts4" : "sqlite-scan") : "json-fallback";
      if (this.sqlite) await this.writeSQLiteCards();
      await this.writeJSONSnapshot();
      this.stale = false;
      return { rebuilt: true, backend: this.backend, cardCount: this.rows.length, updatedAt: this.updatedAt, sqlitePath: this.sqlitePath };
    }

    async ensureFresh(options = {}) {
      if (this.stale || (!this.rows.length && options.rebuildIfEmpty !== false)) await this.rebuild(options);
      else if (options.recheckSource !== false && this.library?.allItems && Date.now() - this.lastSourceCheckAt >= 2000) {
        this.lastSourceCheckAt = Date.now();
        const items = await this.library.allItems(options.libraryID, { includeDeleted: false });
        if (sourceSignature(items) !== this.sourceSignature) await this.rebuild({ ...options, items });
      }
      return this.rows;
    }

    async upsert(card) {
      if (!card) return null;
      const identity = Agent.PaperCard.identity(card);
      const index = this.rows.findIndex(row => Agent.PaperCard.identity(row) === identity);
      if (index >= 0) {
        const previous = this.rows[index];
        const previousStatus = previous?.litmtrans || {};
        const nextStatus = { ...previousStatus, ...(card.litmtrans || {}) };
        for (const key of ["hasAttachment", "parsed", "streamTranslation", "layoutTranslation"]) {
          if (previousStatus[key] === true && card.litmtrans?.[key] === false) nextStatus[key] = true;
        }
        for (const key of ["figureCount", "tableCount", "formulaCount"]) {
          if (nextStatus[key] === null || nextStatus[key] === undefined) nextStatus[key] = previousStatus[key] ?? null;
        }
        card.litmtrans = nextStatus;
        this.rows[index] = card;
      }
      else this.rows.push(card);
      this.updatedAt = new Date().toISOString();
      this.stale = false;
      if (this.sqlite) await this.writeSQLiteCards();
      await this.writeJSONSnapshot();
      return card;
    }

    async updateDocumentStatus(identifier, status = {}, options = {}) {
      const wanted = identifier || options.documentID || options.itemKey || options.attachmentKey;
      let card = this.findByIdentifier(wanted);
      if (!card && options.item) {
        try {
          card = await this.cardFactory(options.item);
          if (card) this.rows.push(card);
        }
        catch (_) {}
      }
      if (!card) return null;
      card.local = { ...(card.local || {}) };
      if (options.documentID) card.local.documentID = String(options.documentID);
      if (options.itemKey) card.local.itemKey = String(options.itemKey);
      if (options.attachmentKey !== undefined) card.local.attachmentKey = String(options.attachmentKey || "");
      card.litmtrans = { ...(card.litmtrans || {}), ...status };
      card.litmtrans.hasAttachment = status.hasAttachment !== undefined ? Boolean(status.hasAttachment) : card.litmtrans.hasAttachment !== false;
      if (status.hasAttachment === false) {
        card.litmtrans.parsed = false;
        card.litmtrans.parseStale = false;
        card.litmtrans.streamTranslation = false;
        card.litmtrans.layoutTranslation = false;
        card.litmtrans.layoutSource = false;
        card.litmtrans.parsedAt = "";
        card.litmtrans.streamTranslationStale = false;
        card.litmtrans.streamTranslationUpdatedAt = "";
        card.litmtrans.layoutTranslationStale = false;
        card.litmtrans.layoutTranslationUpdatedAt = "";
        for (const key of ["pageCount", "blockCount", "figureCount", "tableCount", "formulaCount"]) card.litmtrans[key] = null;
      }
      if (status.parsed === false) {
        card.litmtrans.parsedAt = "";
        card.litmtrans.parseStale = false;
      }
      if (status.streamTranslation === false) {
        card.litmtrans.streamTranslationStale = false;
        card.litmtrans.streamTranslationUpdatedAt = "";
      }
      if (status.layoutTranslation === false) {
        card.litmtrans.layoutTranslationStale = false;
        card.litmtrans.layoutTranslationUpdatedAt = "";
      }
      if (status.layoutSource === false) card.litmtrans.layoutSource = false;
      card.provenance = { ...(card.provenance || {}), metadataSources: [...new Set([...(card.provenance?.metadataSources || []), "litmtrans"])], lastUpdated: new Date().toISOString() };
      this.updatedAt = new Date().toISOString();
      this.stale = false;
      if (this.sqlite) await this.writeSQLiteCards();
      await this.writeJSONSnapshot();
      return card;
    }

    async removeDocument(identifier, options = {}) {
      const wanted = identifier || options.documentID || options.itemKey || options.attachmentKey;
      const before = this.rows.length;
      this.rows = this.rows.filter(card => !this.findByIdentifierInCard(card, wanted));
      if (this.rows.length === before) return { removed: false, identifier: wanted || "" };
      this.updatedAt = new Date().toISOString();
      this.stale = false;
      if (this.sqlite) await this.writeSQLiteCards();
      await this.writeJSONSnapshot();
      return { removed: true, identifier: wanted || "" };
    }

    findByIdentifierInCard(card, identifier) {
      const wanted = lower(identifier).replace(/^doi:\s*/, "").replace(/^arxiv:\s*/, "").replace(/^pmid:\s*/, "");
      if (!wanted) return false;
      const ids = card?.identifiers || {};
      return [ids.doi, ids.arxiv, ids.pmid, ids.isbn, card?.local?.documentID, card?.local?.itemKey, card?.local?.itemID, card?.local?.parentItemID, card?.local?.attachmentID, card?.local?.attachmentKey, card?.candidateID]
        .some(value => lower(value).replace(/^doi:\s*/, "").replace(/^arxiv:\s*/, "").replace(/^pmid:\s*/, "") === wanted);
    }

    async removeDocumentStatus(identifier, options = {}) {
      return this.updateDocumentStatus(identifier, { hasAttachment: false }, options);
    }

    async ftsCandidates(queryTokens) {
      if (!this.sqlite || !queryTokens.length) return this.rows;
      if (this.backend === "sqlite-scan") return this.rows;
      try {
        const match = queryTokens.map(token => `"${String(token).replace(/"/g, '""')}"*`).join(" AND ");
        const records = await this.sqlite.queryAsync("SELECT identity FROM paper_cards_fts WHERE paper_cards_fts MATCH ?", [match]);
        const identities = new Set((records || []).map(record => String(record.identity || "")));
        return this.rows.filter(card => identities.has(Agent.PaperCard.identity(card)));
      } catch (error) {
        try { this.controller?.log?.(`PaperCard FTS 查询失败，回退内存评分：${error?.message || error}`); } catch (_) {}
        return this.rows;
      }
    }

    findByIdentifier(identifier) {
      const wanted = lower(identifier).replace(/^doi:\s*/, "").replace(/^arxiv:\s*/, "").replace(/^pmid:\s*/, "");
      return this.rows.find(card => {
        const ids = card?.identifiers || {};
        return [ids.doi, ids.arxiv, ids.pmid, ids.isbn, card?.local?.documentID, card?.local?.itemKey, card?.local?.itemID, card?.local?.parentItemID, card?.local?.attachmentID, card?.local?.attachmentKey, card?.candidateID]
          .some(value => lower(value).replace(/^doi:\s*/, "").replace(/^arxiv:\s*/, "").replace(/^pmid:\s*/, "") === wanted);
      }) || null;
    }

    async search(options = {}) {
      await this.ensureFresh(options);
      const query = lower(options.query || options.q || "").trim();
      const queryTokens = tokens(query);
      const authorQuery = lower(options.author || options.authors || "").trim();
      const topicQuery = lower(options.topic || "").trim();
      const venueQuery = lower(options.venue || "").trim();
      const yearFrom = Number(options.yearFrom || 0) || 0;
      const yearTo = Number(options.yearTo || 0) || 0;
      const tagQuery = lower(options.tag || "").trim();
      const collectionQuery = String(options.collection || "").trim();
      const rows = [];
      const candidates = await this.ftsCandidates(queryTokens);
      for (const card of candidates) {
        const values = cardValues(card);
        const rowYear = Number(card?.metadata?.year || 0) || 0;
        if (yearFrom && (!rowYear || rowYear < yearFrom)) continue;
        if (yearTo && (!rowYear || rowYear > yearTo)) continue;
        if (authorQuery && !values.authors.includes(authorQuery)) continue;
        if (topicQuery && !(values.topics.includes(topicQuery) || values.keywords.includes(topicQuery) || values.abstract.includes(topicQuery))) continue;
        if (venueQuery && !values.venue.includes(venueQuery)) continue;
        if (tagQuery && !values.tags.includes(tagQuery)) continue;
        if (collectionQuery && !(card.zotero?.collections || []).map(String).includes(collectionQuery)) continue;
        if (options.openAccessOnly && card.discovery?.openAccess !== true) continue;
        let score = 0;
        if (queryTokens.length) {
          for (const token of queryTokens) {
            if (values.title.includes(token)) score += 8;
            if (values.abstract.includes(token)) score += 4;
            if (values.authors.includes(token)) score += 3;
            if (values.venue.includes(token)) score += 2;
            if (values.tags.includes(token) || values.topics.includes(token) || values.keywords.includes(token)) score += 2;
            if (values.identifiers.includes(token)) score += 5;
          }
          if (!score) continue;
          score /= queryTokens.length;
        }
        const citationCount = Number(card.discovery?.citationCount || 0) || 0;
        score += Math.min(3, Math.log10(citationCount + 1));
        rows.push({ ...card, local: { ...(card.local || {}), inZotero: true }, score: Number(score.toFixed(4)), matchLevel: "metadata" });
      }
      rows.sort((left, right) => right.score - left.score || String(left.metadata?.title || "").localeCompare(String(right.metadata?.title || "")));
      const offset = Math.max(0, Number(options.offset || 0) || 0);
      const limit = Math.min(200, Math.max(1, Number(options.limit || 50) || 50));
      const items = rows.slice(offset, offset + limit);
      return {
        backend: this.backend,
        source: "local",
        evidenceLevel: "metadata",
        query: options.query || options.q || "",
        indexUpdatedAt: this.updatedAt,
        total: rows.length,
        offset,
        limit,
        nextOffset: offset + items.length < rows.length ? offset + items.length : null,
        items
      };
    }

    stats() {
      return { backend: this.backend, sqliteMode: this.sqliteMode, path: this.path, sqlitePath: this.sqlitePath, sqliteAvailable: Boolean(this.sqlite), sqliteReason: this.sqliteReason, cardCount: this.rows.length, updatedAt: this.updatedAt, sourceSignature: this.sourceSignature, stale: this.stale, fullTextReads: this.fullTextReads };
    }

    async shutdown() {
      try { await this.sqlite?.closeDatabase?.(); } catch (_) {}
      this.sqlite = null;
    }
  }

  Agent.PaperCardIndex = PaperCardIndex;
})(this);
