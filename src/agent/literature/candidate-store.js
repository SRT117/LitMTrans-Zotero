(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function joinPath(...parts) {
    try { return global.PathUtils?.join?.(...parts) || parts.filter(Boolean).join("/"); }
    catch (_) { return parts.filter(Boolean).join("/"); }
  }

  function now() { return new Date().toISOString(); }

  class CandidateStore {
    constructor(storage, options = {}) {
      this.storage = storage;
      this.path = options.path || joinPath(storage?.root || "", "literature", "external-cache.json");
      this.rows = {};
      this.updatedAt = "";
    }

    async init() {
      const saved = await this.storage?.readJSON?.(this.path, null);
      if (saved?.schemaVersion === 1 && saved.records && typeof saved.records === "object") {
        this.rows = saved.records;
        this.updatedAt = String(saved.updatedAt || "");
      }
      return { count: Object.keys(this.rows).length, updatedAt: this.updatedAt };
    }

    key(provider, identifier) {
      const id = String(identifier || "").trim().toLowerCase();
      return `${String(provider || "unknown").trim().toLowerCase()}:${id}`;
    }

    candidateIdentifier(candidate) {
      const ids = candidate?.identifiers || {};
      return String(candidate?.candidateID || ids.doi || ids.arxiv || ids.pmid || candidate?.local?.documentID || candidate?.metadata?.title || "").trim();
    }

    get(provider, identifier, options = {}) {
      const row = this.rows[this.key(provider, identifier)];
      if (!row) return null;
      const ttl = Math.max(0, Number(options.ttlMs || 0));
      const age = Date.now() - (Date.parse(row.retrievedAt) || 0);
      if (ttl && age <= ttl) return { ...row.value, _cache: { status: "fresh", retrievedAt: row.retrievedAt, ageMs: age } };
      if (options.allowStale !== false) return { ...row.value, _cache: { status: "stale", retrievedAt: row.retrievedAt, ageMs: age } };
      return null;
    }

    async set(provider, identifier, value, metadata = {}) {
      const key = this.key(provider, identifier);
      this.rows[key] = {
        provider: String(provider || ""), identifier: String(identifier || ""),
        retrievedAt: now(), etag: String(metadata.etag || ""), updated: String(metadata.updated || ""),
        value
      };
      this.updatedAt = now();
      await this.persist();
      return value;
    }

    getCandidate(identifier, options = {}) {
      const wanted = String(identifier || "").trim().toLowerCase();
      if (!wanted) return null;
      const direct = this.rows[this.key("candidate", wanted)];
      if (direct) return { ...direct.value, _cache: { status: "candidate", retrievedAt: direct.retrievedAt } };
      for (const row of Object.values(this.rows)) {
        if (String(row?.identifier || "").trim().toLowerCase() === wanted) return { ...row.value, _cache: { status: "candidate", retrievedAt: row.retrievedAt } };
      }
      return null;
    }

    async setCandidates(candidates = []) {
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const identifier = this.candidateIdentifier(candidate);
        if (!identifier) continue;
        const key = this.key("candidate", identifier);
        this.rows[key] = { provider: "candidate", identifier, retrievedAt: now(), etag: "", updated: "", value: candidate };
      }
      this.updatedAt = now();
      await this.persist();
      return { count: Array.isArray(candidates) ? candidates.length : 0 };
    }

    async persist() {
      await this.storage?.ensureDir?.(joinPath(this.storage?.root || "", "literature"));
      await this.storage?.writeJSON?.(this.path, { schemaVersion: 1, updatedAt: this.updatedAt, records: this.rows });
    }

    async clear() {
      this.rows = {};
      this.updatedAt = now();
      await this.storage?.removeFile?.(this.path);
      return { cleared: true };
    }

    stats() { return { path: this.path, count: Object.keys(this.rows).length, updatedAt: this.updatedAt }; }
  }

  Agent.CandidateStore = CandidateStore;
})(this);
