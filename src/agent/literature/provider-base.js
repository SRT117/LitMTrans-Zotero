(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function text(value) { return String(value ?? "").trim(); }
  function year(value) { const match = text(value).match(/\b(18|19|20|21)\d{2}\b/); return match ? Number(match[0]) : null; }

  class LiteratureProvider {
    constructor(name, options = {}) {
      this.name = name;
      this.options = options;
      this.requestJSONImpl = options.requestJSON || null;
      this.requestTextImpl = options.requestText || null;
      this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 12000));
      this.failureCount = 0;
      this.openUntil = 0;
    }

    async requestJSON(url, requestOptions = {}) {
      if (this.requestJSONImpl) return this.requestJSONImpl(url, requestOptions);
      if (LitMTrans.HTTP?.requestJSON) return LitMTrans.HTTP.requestJSON("GET", url, { timeout: this.timeoutMs, headers: requestOptions.headers || {}, signal: requestOptions.signal });
      const response = await global.fetch(url, { method: "GET", headers: { Accept: "application/json", ...(requestOptions.headers || {}) }, signal: requestOptions.signal });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      return response.json();
    }

    async requestText(url, requestOptions = {}) {
      if (this.requestTextImpl) return this.requestTextImpl(url, requestOptions);
      if (LitMTrans.HTTP?.request) {
        const response = await LitMTrans.HTTP.request("GET", url, { timeout: this.timeoutMs, headers: { Accept: "application/xml,text/plain,*/*", ...(requestOptions.headers || {}) }, signal: requestOptions.signal, accept: "application/xml,text/plain,*/*" });
        return response.text();
      }
      const response = await global.fetch(url, { method: "GET", headers: requestOptions.headers || {}, signal: requestOptions.signal });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      return response.text();
    }

    async run(operation, options = {}) {
      const now = Date.now();
      if (this.openUntil > now) throw Object.assign(new Error(`${this.name} provider circuit open`), { code: "PROVIDER_CIRCUIT_OPEN" });
      const attempts = Math.max(1, Number(options.attempts || 2));
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const value = await operation(attempt);
          this.failureCount = 0;
          return value;
        }
        catch (error) {
          lastError = error;
          if (Number(error?.status) === 429 || Number(error?.status) >= 500 || !error?.status) {
            if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, Math.min(500 * attempt, 1200)));
            continue;
          }
          break;
        }
      }
      this.failureCount += 1;
      if (this.failureCount >= 3) this.openUntil = Date.now() + 30000;
      throw lastError || new Error(`${this.name} provider failed`);
    }

    status(error = null) {
      return { status: error ? (Number(error.status) === 429 ? "rate_limited" : "error") : "ok", error: error ? text(error.message || error) : "" };
    }

    normalizeAuthors(rows = []) {
      return (Array.isArray(rows) ? rows : []).map(row => {
        if (typeof row === "string") return { name: text(row) };
        const name = text(row?.name || row?.author?.display_name || [row?.given, row?.family].filter(Boolean).join(" ") || row?.display_name);
        return name ? { name, firstName: text(row?.given || row?.firstName), lastName: text(row?.family || row?.lastName) } : null;
      }).filter(Boolean);
    }

    normalizeBase(record = {}, source = this.name) {
      const ids = record.identifiers || {};
      const title = text(record.title || record.metadata?.title);
      return {
        schemaVersion: 1,
        candidateID: text(record.candidateID || ids.doi || ids.arxiv || ids.pmid || `${source}:${title.toLocaleLowerCase()}`),
        local: { inZotero: false, hasFullText: false, parsed: false },
        metadata: {
          title,
          authors: this.normalizeAuthors(record.authors || record.author || record.metadata?.authors),
          year: Number(record.year || year(record.date || record.published)) || null,
          date: text(record.date || record.published),
          venue: text(record.venue || record.metadata?.venue),
          journal: text(record.journal),
          publisher: text(record.publisher),
          language: text(record.language)
        },
        identifiers: {
          doi: text(ids.doi || record.doi).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase(),
          arxiv: text(ids.arxiv || record.arxiv).replace(/^arxiv:/i, "").toLowerCase(),
          pmid: text(ids.pmid || record.pmid),
          isbn: text(ids.isbn || record.isbn),
          url: text(ids.url || record.url)
        },
        summary: { abstract: text(record.abstract || record.summary || record.metadata?.abstract) },
        discovery: {
          topics: Array.isArray(record.topics) ? record.topics.map(text).filter(Boolean) : [],
          keywords: Array.isArray(record.keywords) ? record.keywords.map(text).filter(Boolean) : [],
          concepts: Array.isArray(record.concepts) ? record.concepts.map(text).filter(Boolean) : [],
          citationCount: Number(record.citationCount ?? record.citations ?? 0) || 0,
          referenceCount: Number(record.referenceCount ?? record.references ?? 0) || 0,
          openAccess: Boolean(record.openAccess),
          bestOALocation: record.bestOALocation || null
        },
        provenance: { metadataSources: [source], lastUpdated: new Date().toISOString() },
        evidenceLevel: "metadata"
      };
    }
  }

  Agent.LiteratureProvider = LiteratureProvider;
  Agent.LiteratureProviderHelpers = { text, year };
})(this);
