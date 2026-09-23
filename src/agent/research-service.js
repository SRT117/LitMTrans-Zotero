(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  class ResearchService {
    constructor(storage) {
      this.storage = storage;
      this.root = PathUtils.join(storage.root, "research");
      this.archiveRoot = PathUtils.join(this.root, ".archive");
    }

    safeID(value) {
      const raw = String(value || "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      return raw.slice(0, 96) || `artifact-${Date.now()}`;
    }

    path(id) {
      return PathUtils.join(this.root, `${this.safeID(id)}.json`);
    }

    async init() {
      await this.storage.ensureDir(this.root);
      await this.storage.ensureDir(this.archiveRoot);
    }

    async list(options = {}) {
      const rows = [];
      for (const file of await this.storage.list(this.root)) {
        if (PathUtils.filename(file) === ".archive") continue;
        const info = await this.storage.stat(file);
        if (!info || info.type === "directory" || !/\.json$/i.test(file)) continue;
        const value = await this.storage.readJSON(file, null);
        if (!value?.id) continue;
        if (options.type && String(value.type) !== String(options.type)) continue;
        rows.push(C.redact({
          id: String(value.id), type: String(value.type || "analysis"), title: String(value.title || ""), origin: String(value.origin || ""),
          documentIDs: Array.isArray(value.documentIDs) ? value.documentIDs : [], evidenceCount: Array.isArray(value.evidence) ? value.evidence.length : 0,
          createdAt: value.createdAt, updatedAt: value.updatedAt
        }));
      }
      return rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, Math.min(200, Number(options.limit || 100)));
    }

    async get(id) {
      const value = await this.storage.readJSON(this.path(id), null);
      if (!value) throw new C.AgentError("RESEARCH_ARTIFACT_NOT_FOUND", `未找到研究资产 ${id}`, { recoverable: false });
      return C.redact(value);
    }

    normalize(values = {}, existing = null) {
      const now = C.now();
      const id = this.safeID(values.id || existing?.id || `artifact-${Date.now()}`);
      const documentIDs = [...new Set((Array.isArray(values.documentIDs) ? values.documentIDs : (existing?.documentIDs || [])).map(String).filter(Boolean))];
      const evidence = Array.isArray(values.evidence) ? values.evidence : (Array.isArray(existing?.evidence) ? existing.evidence : []);
      return C.redact({
        id,
        type: String(values.type || existing?.type || "analysis").slice(0, 40),
        title: String(values.title ?? existing?.title ?? "").trim().slice(0, 200),
        origin: String(values.origin || existing?.origin || "agent").slice(0, 80),
        documentIDs,
        evidence: evidence.slice(0, 1000),
        content: String(values.content ?? existing?.content ?? ""),
        metadata: values.metadata && typeof values.metadata === "object" ? values.metadata : (existing?.metadata || {}),
        createdAt: String(existing?.createdAt || now),
        updatedAt: now
      });
    }

    async create(values = {}) {
      await this.init();
      const value = this.normalize(values);
      const target = this.path(value.id);
      if (await this.storage.exists(target)) throw new C.AgentError("RESEARCH_ARTIFACT_EXISTS", `研究资产 ${value.id} 已存在`, { recoverable: false });
      await this.storage.writeJSON(target, value);
      return value;
    }

    async update(id, values = {}) {
      const existing = await this.get(id);
      const next = this.normalize({ ...values, id: existing.id }, existing);
      await this.storage.writeJSON(this.path(existing.id), next);
      return next;
    }

    async remove(id) {
      const existing = await this.get(id);
      const source = this.path(existing.id);
      const archive = PathUtils.join(this.archiveRoot, `${this.safeID(existing.id)}-${Date.now()}.json`);
      await this.storage.copyFile(source, archive);
      await this.storage.removeFile(source);
      return { deleted: true, archived: archive, id: existing.id };
    }
  }

  Agent.ResearchService = ResearchService;
})(this);
