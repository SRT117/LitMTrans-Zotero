(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const Base = Agent.LiteratureProvider;

  function fullTextRows(row) {
    const value = row?.fullTextUrlList?.fullTextUrl;
    return Array.isArray(value) ? value : (value ? [value] : []);
  }

  function isPDF(row) {
    const format = String(row?.documentStyle || row?.format || row?.type || row?.mimeType || "").toLowerCase();
    const url = String(row?.url || "");
    return format.includes("pdf") || /\.pdf(?:$|[?#])/i.test(url) || /\/pdf(?:$|[/?#])/i.test(url);
  }

  class EuropePMCProvider extends Base {
    constructor(options = {}) { super("europePMC", options); this.baseURL = String(options.baseURL || "https://www.ebi.ac.uk/europepmc/webservices/rest").replace(/\/$/, ""); }

    normalize(row) {
      const urls = fullTextRows(row);
      const pdf = urls.find(isPDF);
      const landing = urls.find(candidate => !isPDF(candidate));
      const landingPageURL = landing?.url || (row?.pmcid ? `https://europepmc.org/articles/${row.pmcid}` : (row?.doi ? `https://europepmc.org/article/MED/${row.pmid || row.id}` : ""));
      return this.normalizeBase({
        candidateID: row?.id || row?.pmcid,
        title: row?.title,
        authors: row?.authorString ? row.authorString.split(/,\s*/).map(name => ({ name })) : row?.authorList?.author,
        year: row?.pubYear,
        date: row?.firstPublicationDate,
        venue: row?.journalTitle,
        abstract: row?.abstractText,
        doi: row?.doi,
        pmid: row?.pmid,
        url: landingPageURL,
        openAccess: Boolean(row?.isOpenAccess || row?.pmcid),
        bestOALocation: pdf || landingPageURL ? { ...(pdf ? { pdfURL: pdf.url } : {}), ...(landingPageURL ? { landingPageURL } : {}), source: "Europe PMC" } : null,
        citationCount: row?.citedByCount
      }, "europepmc");
    }

    async search(options = {}) {
      const params = new URLSearchParams({ query: String(options.query || ""), format: "json", pageSize: String(Math.min(100, Math.max(1, Number(options.limit || 25)))), page: String(Math.floor(Math.max(0, Number(options.offset || 0)) / Math.max(1, Number(options.limit || 25))) + 1) });
      const data = await this.run(() => this.requestJSON(`${this.baseURL}/search?${params.toString()}`, { signal: options.signal }));
      return { results: (data?.resultList?.result || []).map(row => this.normalize(row)), total: Number(data?.hitCount || 0) || 0 };
    }
  }

  Agent.EuropePMCProvider = EuropePMCProvider;
})(this);
