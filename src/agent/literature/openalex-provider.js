(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const Base = Agent.LiteratureProvider;
  const H = Agent.LiteratureProviderHelpers;

  function abstractFromInvertedIndex(value) {
    if (!value || typeof value !== "object") return "";
    const words = [];
    for (const [word, positions] of Object.entries(value)) for (const position of Array.isArray(positions) ? positions : []) words[Number(position)] = word;
    return words.filter(Boolean).join(" ");
  }

  class OpenAlexProvider extends Base {
    constructor(options = {}) { super("openalex", options); this.baseURL = String(options.baseURL || "https://api.openalex.org").replace(/\/$/, ""); }

    formalWorkID(value) {
      const text = String(value || "").trim();
      const match = text.match(/(?:openalex\.org\/works\/)?(W\d+)$/i);
      return match ? `W${match[1].slice(1)}` : "";
    }

    normalize(work) {
      const location = work?.best_oa_location || work?.primary_location || {};
      const ids = work?.ids || {};
      const record = this.normalizeBase({
        candidateID: work?.id,
        title: work?.title,
        authors: (work?.authorships || []).map(row => row.author),
        year: work?.publication_year,
        date: work?.publication_date,
        venue: work?.primary_location?.source?.display_name || work?.host_venue?.display_name,
        publisher: work?.primary_location?.source?.host_organization_name,
        abstract: abstractFromInvertedIndex(work?.abstract_inverted_index),
        doi: work?.doi || ids.doi,
        openAccess: Boolean(work?.open_access?.is_oa),
        bestOALocation: location?.pdf_url || location?.landing_page_url ? { pdfURL: location.pdf_url || "", landingPageURL: location.landing_page_url || "", source: location.source?.display_name || "" } : null,
        citationCount: work?.cited_by_count,
        referenceCount: Array.isArray(work?.referenced_works) ? work.referenced_works.length : 0,
        topics: (work?.topics || []).map(row => row.display_name || row),
        keywords: (work?.keywords || []).map(row => row.display_name || row),
        concepts: (work?.concepts || []).map(row => row.display_name || row),
        url: work?.id || work?.primary_location?.landing_page_url
      }, "openalex");
      record.references = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
      return record;
    }

    async search(options = {}) {
      const params = new URLSearchParams();
      if (options.query) params.set("search", String(options.query));
      params.set("per-page", String(Math.min(100, Math.max(1, Number(options.limit || 25)))));
      const filters = [];
      if (options.yearFrom) filters.push(`from_publication_date:${options.yearFrom}-01-01`);
      if (options.yearTo) filters.push(`to_publication_date:${options.yearTo}-12-31`);
      if (options.openAccessOnly) filters.push("is_oa:true");
      if (filters.length) params.set("filter", filters.join(","));
      const page = Math.max(1, Math.floor(Number(options.offset || 0) / Math.max(1, Number(options.limit || 25))) + 1);
      params.set("page", String(page));
      const data = await this.run(() => this.requestJSON(`${this.baseURL}/works?${params.toString()}`, { signal: options.signal }));
      return { results: (data?.results || []).map(work => this.normalize(work)), total: Number(data?.meta?.count || 0) || 0, nextCursor: data?.meta?.next_cursor || null };
    }

    async resolveWorkID(seed, options = {}) {
      const ids = seed?.identifiers || {};
      const direct = this.formalWorkID(seed?.candidateID) || this.formalWorkID(ids.openalex) || this.formalWorkID(ids.url);
      if (direct) return direct;
      const filters = [];
      if (ids.doi) filters.push(`doi:${String(ids.doi).replace(/^doi:\s*/i, "")}`);
      else if (ids.pmid) filters.push(`ids.pmid:${String(ids.pmid).replace(/^pmid:\s*/i, "")}`);
      if (!filters.length) return "";
      const params = new URLSearchParams({ filter: filters.join(","), "per-page": "1" });
      const data = await this.run(() => this.requestJSON(`${this.baseURL}/works?${params.toString()}`, { signal: options.signal }));
      return this.formalWorkID(data?.results?.[0]?.id);
    }

    async hydrateWorkIDs(ids, options = {}) {
      const unique = [...new Set((ids || []).map(value => this.formalWorkID(value)).filter(Boolean))];
      const limit = 50;
      const rows = [];
      for (let index = 0; index < unique.length; index += limit) {
        const chunk = unique.slice(index, index + limit);
        const params = new URLSearchParams({ filter: `openalex_id:${chunk.join("|")}`, "per-page": String(chunk.length) });
        const data = await this.run(() => this.requestJSON(`${this.baseURL}/works?${params.toString()}`, { signal: options.signal }));
        rows.push(...(data?.results || []).map(work => this.normalize(work)));
      }
      return rows;
    }

    async expand(seed, mode = "citations", options = {}) {
      const id = await this.resolveWorkID(seed, options);
      if (!id) return { results: [] };
      const limit = Math.min(100, Math.max(1, Number(options.limit || 20)));
      if (mode === "citations") {
        const params = new URLSearchParams({ filter: `cites:${id}`, "per-page": String(limit) });
        const data = await this.run(() => this.requestJSON(`${this.baseURL}/works?${params.toString()}`, { signal: options.signal }));
        return { results: (data?.results || []).map(work => this.normalize(work)) };
      }
      const data = await this.run(() => this.requestJSON(`${this.baseURL}/works/${encodeURIComponent(id)}`, { signal: options.signal }));
      const ids = mode === "references" ? data?.referenced_works : data?.related_works;
      return { results: await this.hydrateWorkIDs(Array.isArray(ids) ? ids.slice(0, limit) : [], options) };
    }
  }

  Agent.OpenAlexProvider = OpenAlexProvider;
})(this);
