(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const Base = Agent.LiteratureProvider;

  function cleanAbstract(value) {
    return String(value || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  class CrossrefProvider extends Base {
    constructor(options = {}) { super("crossref", options); this.baseURL = String(options.baseURL || "https://api.crossref.org").replace(/\/$/, ""); }

    normalize(work) {
      const dates = work?.published?.["date-parts"]?.[0] || work?.issued?.["date-parts"]?.[0] || [];
      const links = Array.isArray(work?.link) ? work.link : [];
      const pdfLink = links.find(row => /pdf/i.test(String(row?.["content-type"] || row?.format || "")) || /\.pdf(?:$|[?#])/i.test(String(row?.URL || row?.url || "")));
      const openAccess = Boolean(
        work?.is_oa
        || work?.isOpenAccess
        || (Array.isArray(work?.license) && work.license.length)
        || (work?.["free-to-read"] && (Array.isArray(work["free-to-read"]) ? work["free-to-read"].length : true))
      );
      return this.normalizeBase({
        candidateID: work?.DOI,
        title: Array.isArray(work?.title) ? work.title[0] : work?.title,
        authors: work?.author,
        year: dates[0], date: dates.join("-"),
        venue: Array.isArray(work?.["container-title"]) ? work["container-title"][0] : work?.["container-title"],
        publisher: work?.publisher,
        abstract: cleanAbstract(work?.abstract),
        doi: work?.DOI,
        url: work?.URL,
        referenceCount: Array.isArray(work?.reference) ? work.reference.length : 0,
        bestOALocation: pdfLink ? { pdfURL: pdfLink.URL || pdfLink.url || "", source: "Crossref" } : null,
        openAccess
      }, "crossref");
    }

    async search(options = {}) {
      const params = new URLSearchParams({ "query.bibliographic": String(options.query || ""), rows: String(Math.min(100, Math.max(1, Number(options.limit || 25)))), offset: String(Math.max(0, Number(options.offset || 0))) });
      const data = await this.run(() => this.requestJSON(`${this.baseURL}/works?${params.toString()}`, { signal: options.signal, headers: { Accept: "application/json", ...(options.mailto ? { "User-Agent": `LitMTrans/2.0 (mailto:${options.mailto})` } : {}) } }));
      return { results: (data?.message?.items || []).map(row => this.normalize(row)), total: Number(data?.message?.["total-results"] || 0) || 0 };
    }

    async resolveDOI(doi, options = {}) {
      const value = String(doi || "").replace(/^https?:\/\/doi\.org\//i, "");
      const data = await this.run(() => this.requestJSON(`${this.baseURL}/works/${encodeURIComponent(value)}`, { signal: options.signal }));
      return data?.message ? this.normalize(data.message) : null;
    }
  }

  Agent.CrossrefProvider = CrossrefProvider;
})(this);
