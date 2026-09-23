(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function lower(value) { return String(value || "").trim().toLowerCase(); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }

  class LiteratureDiscoveryService {
    constructor(controller, options = {}) {
      this.controller = controller;
      this.library = options.library || null;
      this.index = options.index || new Agent.PaperCardIndex(controller, this.library, { statusForAttachment: options.statusForAttachment });
      this.cache = options.cache || new Agent.CandidateStore(controller?.storage);
      const providerOptions = options.providerOptions || {};
      this.providers = options.providers || {
        openalex: new Agent.OpenAlexProvider(providerOptions.openalex || {}),
        semanticScholar: new Agent.SemanticScholarProvider(providerOptions.semanticScholar || {}),
        crossref: new Agent.CrossrefProvider(providerOptions.crossref || {}),
        arxiv: new Agent.ArxivProvider(providerOptions.arxiv || {}),
        europepmc: new Agent.EuropePMCProvider(providerOptions.europepmc || {})
      };
      this.initialized = false;
    }

    async init() {
      if (this.initialized) return;
      await this.cache.init?.();
      await this.index.init?.();
      this.initialized = true;
    }

    async shutdown() {
      await this.index.shutdown?.();
      this.initialized = false;
    }

    providerList(options = {}) {
      const names = Object.keys(this.providers);
      return names.map(name => this.providers[name] || this.providers[Object.keys(this.providers).find(key => lower(key) === name)]).filter(Boolean);
    }

    async resolveCandidate(identifier) {
      if (identifier && typeof identifier === "object") {
        const direct = identifier.candidateID || identifier.identifiers?.doi || identifier.identifiers?.arxiv || identifier.identifiers?.pmid || identifier.local?.documentID || identifier.local?.itemKey;
        if (direct) return (await this.resolveCandidate(direct)) || identifier;
        return identifier;
      }
      const local = this.index.findByIdentifier(identifier);
      if (local) return local;
      return this.cache.getCandidate?.(identifier) || null;
    }

    seedCardFromIdentifier(identifier) {
      const value = String(identifier || "").trim();
      const normalized = value.replace(/^doi:\s*/i, "");
      const identifiers = {};
      if (/^10\.\d{4,9}\//i.test(normalized)) identifiers.doi = normalized;
      else if (/^(?:arxiv:)?[0-9]{4}\.\d{4,5}(?:v\d+)?$/i.test(value)) identifiers.arxiv = value.replace(/^arxiv:/i, "");
      else if (/^pmid:\s*\d+$/i.test(value) || /^\d{5,9}$/.test(value)) identifiers.pmid = value.replace(/^pmid:\s*/i, "");
      return {
        schemaVersion: 1,
        candidateID: value,
        local: { inZotero: false, hasFullText: false, parsed: false },
        metadata: { title: "", authors: [], year: null, date: "", venue: "", journal: "", publisher: "", language: "" },
        identifiers,
        summary: { abstract: "" },
        discovery: { topics: [], keywords: [], concepts: [], citationCount: 0, referenceCount: 0, openAccess: false, bestOALocation: null },
        provenance: { metadataSources: ["seed"], lastUpdated: new Date().toISOString() },
        evidenceLevel: "metadata"
      };
    }

    async resolveSeeds(options = {}) {
      const values = [
        ...(Array.isArray(options.seedCandidateIDs) ? options.seedCandidateIDs : []),
        ...(Array.isArray(options.seedCards) ? options.seedCards : []),
        options.seedCard
      ].filter(value => value !== undefined && value !== null && value !== "");
      const seeds = [];
      for (const value of values) {
        const resolved = await this.resolveCandidate(value);
        const seed = resolved || (typeof value === "object" ? value : this.seedCardFromIdentifier(value));
        if (seed && !seeds.some(row => Agent.LiteratureRanking.identifier(row) === Agent.LiteratureRanking.identifier(seed))) seeds.push(seed);
      }
      return seeds;
    }

    matchesPostFilter(candidate, options = {}) {
      const year = Number(candidate?.metadata?.year || 0) || 0;
      const yearFrom = Number(options.yearFrom || 0) || 0;
      const yearTo = Number(options.yearTo || 0) || 0;
      if (yearFrom && (!year || year < yearFrom)) return false;
      if (yearTo && (!year || year > yearTo)) return false;
      if (options.openAccessOnly && candidate?.discovery?.openAccess !== true) return false;
      const authorNeedles = [options.author, options.authors].flatMap(value => Array.isArray(value) ? value : String(value || "").split(/[,;]+/)).map(lower).filter(Boolean);
      const authors = (candidate?.metadata?.authors || []).map(row => lower(row?.name || [row?.firstName, row?.lastName].filter(Boolean).join(" "))).join(" ");
      if (authorNeedles.some(needle => !authors.includes(needle))) return false;
      const venueNeedle = lower(options.venue);
      const venue = lower([candidate?.metadata?.venue, candidate?.metadata?.journal, candidate?.metadata?.publisher].filter(Boolean).join(" "));
      if (venueNeedle && !venue.includes(venueNeedle)) return false;
      const topicNeedles = [options.topic, options.topics].flatMap(value => Array.isArray(value) ? value : String(value || "").split(/[,;]+/)).map(lower).filter(Boolean);
      const topicText = lower([
        candidate?.metadata?.title,
        candidate?.summary?.abstract,
        ...(candidate?.discovery?.topics || []),
        ...(candidate?.discovery?.keywords || []),
        ...(candidate?.discovery?.concepts || [])
      ].join(" "));
      if (topicNeedles.some(needle => !topicText.includes(needle))) return false;
      return true;
    }

    async runProvider(provider, method, options) {
      const key = `${provider.name}:${method}:${JSON.stringify({ query: options.query, yearFrom: options.yearFrom, yearTo: options.yearTo, limit: options.providerLimit || options.limit, mode: options.mode, seed: options.seed })}`;
      const cached = this.cache.get(provider.name, key, { ttlMs: Number(options.cacheTtlMs || 6 * 60 * 60 * 1000), allowStale: true });
      if (cached?.results) return { ...cached, cached: true };
      try {
        const value = method === "expand" ? await provider.expand(options.seed, options.mode, options) : await provider.search(options);
        await this.cache.set(provider.name, key, value);
        return { ...value, cached: false };
      }
      catch (error) {
        const stale = this.cache.get(provider.name, key, { allowStale: true });
        if (stale?.results) return { ...stale, cached: true, stale: true, providerError: String(error?.message || error) };
        throw error;
      }
    }

    mergeLocalMetadata(candidate, local) {
      if (!local) return { ...candidate, local: { ...(candidate.local || {}), inZotero: false } };
      return {
        ...candidate,
        local: { ...(candidate.local || {}), ...(local.local || {}), inZotero: true, hasFullText: Boolean(local.litmtrans?.hasAttachment || local.local?.attachmentKey), parsed: Boolean(local.litmtrans?.parsed) },
        zotero: local.zotero,
        litmtrans: local.litmtrans,
        provenance: { ...(candidate.provenance || {}), metadataSources: [...new Set([...(candidate.provenance?.metadataSources || []), "zotero"])] }
      };
    }

    async search(options = {}) {
      await this.init();
      const mode = ["search", "recommend", "citations", "references"].includes(String(options.mode || "search")) ? String(options.mode || "search") : "search";
      const query = String(options.query || options.q || "").trim();
      const seeds = await this.resolveSeeds(options);
      if (mode === "search" && !query) throw new C.AgentError("LITERATURE_QUERY_REQUIRED", "文献检索需要研究问题或关键词", { recoverable: false });
      if (mode !== "search" && !seeds.length) throw new C.AgentError("LITERATURE_SEED_REQUIRED", "推荐、引用和参考文献扩展需要 seedCandidateIDs 或 seedCards", { recoverable: false });
      const stage1Limit = Math.min(200, Math.max(1, Number(options.localLimit || 100)));
      const local = query ? await this.index.search({ ...options, query, limit: stage1Limit, offset: 0 }) : { items: [] };
      const externalAllowed = options.external !== false;
      const providerRows = {};
      const allCandidates = [...(local.items || [])];
      if (externalAllowed) {
        const providers = this.providerList(options);
        const settled = await Promise.all(providers.map(async provider => {
          try {
            const providerSeeds = mode === "search" ? [null] : seeds;
            const results = [];
            for (const seed of providerSeeds) {
              const method = mode === "search" ? "search" : "expand";
              const result = await this.runProvider(provider, method, { ...options, query, mode, seed, providerLimit: Math.min(50, Number(options.providerLimit || options.limit || 25)) });
              providerRows[provider.name] = result.stale ? "stale-cache" : (result.cached ? "cached" : "ok");
              if (Array.isArray(result.results)) results.push(...result.results);
            }
            return results;
          }
          catch (error) {
            providerRows[provider.name] = provider.status(error).status;
            return [];
          }
        }));
        for (const rows of settled) allCandidates.push(...rows);
      }
      const deduped = Agent.LiteratureRanking.dedupe(allCandidates).map(candidate => {
        const localCard = this.index.findByIdentifier(Agent.LiteratureRanking.identifier(candidate))
          || this.index.rows.find(card => Agent.LiteratureRanking.normalizeTitle(card?.metadata?.title) === Agent.LiteratureRanking.normalizeTitle(candidate?.metadata?.title));
        const merged = this.mergeLocalMetadata(candidate, localCard);
        return { ...merged, score: Agent.LiteratureRanking.scoreCandidate(merged, query, { preferLocal: true }) };
      }).filter(candidate => this.matchesPostFilter(candidate, options));
      deduped.sort((left, right) => right.score - left.score || String(left.metadata?.title || "").localeCompare(String(right.metadata?.title || "")));
      await this.cache.setCandidates?.(deduped);
      const offset = Math.max(0, Number(options.offset || 0) || 0);
      const limit = Math.min(100, Math.max(1, Number(options.limit || 20) || 20));
      const shortlistLimit = Math.min(30, Math.max(1, Number(options.shortlistLimit || 30) || 30));
      const shortlist = deduped.slice(0, shortlistLimit);
      const graph = new Agent.LiteratureGraph();
      for (const card of shortlist) graph.addPaper(card, { references: card.references || [] });
      const result = {
        query,
        mode,
        source: "auto",
        backend: this.index.backend,
        evidenceLevel: "metadata",
        providers: providerRows,
        stages: {
          metadataCandidates: allCandidates.length,
          rankedCandidates: deduped.length,
          shortlist: shortlist.length,
          fullTextRead: 0
        },
        total: deduped.length,
        offset,
        limit,
        nextOffset: offset + limit < deduped.length ? offset + limit : null,
        items: deduped.slice(offset, offset + limit),
        shortlist,
        graph: options.includeGraph ? graph.snapshot() : undefined
      };
      if (options.includeEvidence && this.controller?.agent?.facade?.corpus) {
        const evidence = [];
        for (const card of shortlist.slice(0, Math.min(20, Number(options.evidenceLimit || 10)))) {
          if (!card.local?.parsed || !card.local?.documentID) continue;
          const blocksPerPaper = Math.min(8, Math.max(3, Number(options.blocksPerPaper || 5) || 5));
          const found = await this.controller.agent.facade.corpus.search({ query, limit: blocksPerPaper, perDocumentLimit: blocksPerPaper, documentID: card.local.documentID, parsedOnly: true });
          for (const row of found?.results || []) {
            if (!row.page && !row.blockID) continue;
            evidence.push({ ...row, evidenceLevel: row.type === "figure" ? "figure" : row.type === "table" ? "table" : row.type === "formula" ? "formula" : "full-text-block", documentID: card.local.documentID, sourceFingerprint: row.sourceFingerprint || "" });
          }
        }
        result.evidence = evidence;
        result.stages.fullTextRead = evidence.length;
      }
      return result;
    }

    async rebuildIndex(options = {}) { return this.index.rebuild(options); }
    async updateDocumentStatus(documentID, status = {}, options = {}) {
      await this.init();
      return this.index.updateDocumentStatus(documentID, status, options);
    }
    async removeDocumentStatus(documentID, options = {}) {
      await this.init();
      return this.index.removeDocumentStatus(documentID, options);
    }
    indexStats() { return this.index.stats(); }
    providerHealth() { return Object.fromEntries(Object.entries(this.providers).map(([name, provider]) => [name, provider.status()])); }
    cacheStats() { return this.cache.stats(); }
  }

  Agent.LiteratureDiscoveryService = LiteratureDiscoveryService;
})(this);
