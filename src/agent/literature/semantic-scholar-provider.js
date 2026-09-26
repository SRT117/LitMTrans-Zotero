(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const Base = Agent.LiteratureProvider;

  class SemanticScholarProvider extends Base {
    constructor(options = {}) {
      super("semanticScholar", options);
      this.baseURL = String(options.baseURL || "https://api.semanticscholar.org/graph/v1").replace(/\/$/, "");
      this.recommendationsBase = String(options.recommendationsBase || "https://api.semanticscholar.org/recommendations/v1").replace(/\/$/, "");
    }

    normalize(paper) {
      const external = paper?.externalIds || {};
      const record = this.normalizeBase({
        candidateID: paper?.paperId,
        title: paper?.title,
        authors: paper?.authors,
        year: paper?.year,
        venue: paper?.venue,
        journal: paper?.journal?.name,
        abstract: paper?.abstract,
        doi: external.DOI,
        arxiv: external.ArXiv,
        pmid: external.PubMed,
        url: paper?.url,
        citationCount: paper?.citationCount,
        referenceCount: paper?.referenceCount,
        openAccess: Boolean(paper?.openAccessPdf?.url),
        bestOALocation: paper?.openAccessPdf?.url ? { pdfURL: paper.openAccessPdf.url, source: "semantic-scholar" } : null,
        concepts: (paper?.s2FieldsOfStudy || []).map(row => row?.category || row)
      }, "semantic-scholar");
      record.references = (paper?.references || []).map(row => this.normalize(row));
      record.citations = (paper?.citations || []).map(row => this.normalize(row));
      return record;
    }

    fields() { return "paperId,title,abstract,authors,year,venue,journal,externalIds,url,citationCount,referenceCount,openAccessPdf,s2FieldsOfStudy"; }

    seedIdentifier(seed) {
      const ids = seed?.identifiers || {};
      const candidateID = String(seed?.candidateID || "").trim();
      if (ids.doi) return `DOI:${String(ids.doi).replace(/^doi:\s*/i, "")}`;
      if (ids.arxiv) return `ARXIV:${String(ids.arxiv).replace(/^arxiv:\s*/i, "")}`;
      if (ids.pmid) return `PMID:${String(ids.pmid).replace(/^pmid:\s*/i, "")}`;
      return candidateID.replace(/^https?:\/\/api\.semanticscholar\.org\/paper\//i, "");
    }

    async search(options = {}) {
      const params = new URLSearchParams({ query: String(options.query || ""), limit: String(Math.min(100, Math.max(1, Number(options.limit || 25)))), offset: String(Math.max(0, Number(options.offset || 0))), fields: this.fields() });
      const data = await this.run(() => this.requestJSON(`${this.baseURL}/paper/search?${params.toString()}`, { signal: options.signal, headers: options.apiKey ? { "x-api-key": options.apiKey } : {} }));
      return { results: (data?.data || []).map(row => this.normalize(row)), total: Number(data?.total || 0) || 0, nextOffset: data?.next ? Number(options.offset || 0) + Number(options.limit || 25) : null };
    }

    async expand(seed, mode = "recommend", options = {}) {
      const id = this.seedIdentifier(seed);
      if (!id) return { results: [] };
      const encoded = encodeURIComponent(id);
      const limit = Math.min(100, Math.max(1, Number(options.limit || 20)));
      const endpoint = mode === "citations" || mode === "references"
        ? `${this.baseURL}/paper/${encoded}/${mode}?limit=${limit}&fields=${this.fields()}`
        : `${this.recommendationsBase}/papers/forpaper/${encoded}?limit=${limit}&fields=${this.fields()}`;
      const data = await this.run(() => this.requestJSON(endpoint, { signal: options.signal, headers: options.apiKey ? { "x-api-key": options.apiKey } : {} }));
      const rows = mode === "citations"
        ? (data?.data || []).map(row => row?.citingPaper || row).filter(Boolean)
        : mode === "references"
          ? (data?.data || []).map(row => row?.citedPaper || row).filter(Boolean)
          : (data?.recommendedPapers || data?.recommended || data?.data || []).filter(Boolean);
      return { results: rows.map(row => this.normalize(row)) };
    }
  }

  Agent.SemanticScholarProvider = SemanticScholarProvider;
})(this);
