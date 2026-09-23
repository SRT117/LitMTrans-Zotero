(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const Base = Agent.LiteratureProvider;

  function canonicalArxivID(value) {
    const raw = String(value || "").trim().replace(/^arxiv:/i, "");
    const match = raw.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?([^?#/]+?)(?:\.pdf)?$/i);
    return String(match?.[1] || raw).replace(/v\d+$/i, "");
  }

  function tag(xml, name) {
    const match = String(xml || "").match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() : "";
  }

  class ArxivProvider extends Base {
    constructor(options = {}) { super("arxiv", options); this.baseURL = String(options.baseURL || "https://export.arxiv.org/api/query"); }

    normalize(entry) {
      const id = canonicalArxivID(entry?.id || entry?.arxiv);
      const absURL = id ? `https://arxiv.org/abs/${id}` : "";
      const pdfURL = id ? `https://arxiv.org/pdf/${id}.pdf` : String(entry?.pdfURL || "");
      return this.normalizeBase({ candidateID: id, title: entry?.title, abstract: entry?.summary, date: entry?.published, year: entry?.published?.slice?.(0, 4), authors: entry?.authors, url: absURL, arxiv: id, doi: entry?.doi, venue: "arXiv", openAccess: true, bestOALocation: pdfURL ? { pdfURL, landingPageURL: absURL, source: "arXiv" } : null }, "arxiv");
    }

    parse(xml) {
      return [...String(xml || "").matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(match => {
        const block = match[1];
        const authors = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map(row => ({ name: row[1].trim() }));
        const pdf = [...block.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)].map(row => row[1]).find(url => /pdf/i.test(url));
        return { id: tag(block, "id"), title: tag(block, "title"), summary: tag(block, "summary"), published: tag(block, "published"), authors, pdfURL: pdf, doi: tag(block, "arxiv:doi") || tag(block, "doi") };
      }).map(row => this.normalize(row));
    }

    async search(options = {}) {
      const params = new URLSearchParams({ search_query: `all:${String(options.query || "")}`, start: String(Math.max(0, Number(options.offset || 0))), max_results: String(Math.min(100, Math.max(1, Number(options.limit || 25)))) });
      const xml = await this.run(() => this.requestText(`${this.baseURL}?${params.toString()}`, { signal: options.signal }));
      return { results: this.parse(xml), total: Number(tag(xml, "opensearch:totalResults") || 0) || 0 };
    }
  }

  Agent.ArxivProvider = ArxivProvider;
})(this);
