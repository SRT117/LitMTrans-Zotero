(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function joinPath(...parts) {
    try { return global.PathUtils?.join?.(...parts) || parts.filter(Boolean).join("/"); }
    catch (_) { return parts.filter(Boolean).join("/"); }
  }
  function id() { return LitMTrans.Utils?.randomID?.("review") || `review-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function now() { return new Date().toISOString(); }
  function evidenceLevel(value) {
    const allowed = new Set(["metadata", "abstract", "full-text-block", "figure", "table", "formula"]);
    return allowed.has(String(value || "")) ? String(value) : "metadata";
  }

  function normalizeEvidence(row = {}) {
    const level = evidenceLevel(row.evidenceLevel || row.level);
    const locator = row.locator || {};
    const output = {
      id: String(row.id || id()),
      paperID: String(row.paperID || row.documentID || row.itemKey || ""),
      evidenceLevel: level,
      claim: String(row.claim || ""),
      quote: String(row.quote || row.snippet || "").slice(0, 4000),
      documentID: String(row.documentID || locator.documentID || ""),
      page: Number(row.page || locator.page || 0) || null,
      blockID: String(row.blockID || locator.blockID || ""),
      sourceFingerprint: String(row.sourceFingerprint || locator.sourceFingerprint || ""),
      citation: row.citation || null,
      createdAt: String(row.createdAt || now())
    };
    if (["full-text-block", "figure", "table", "formula"].includes(level) && (!output.documentID || (!output.page && !output.blockID))) {
      throw new C.AgentError("EVIDENCE_LOCATOR_REQUIRED", "全文证据必须带 documentID 以及 page 或 blockID 定位信息", { recoverable: false });
    }
    return output;
  }

  function normalizeFinding(row = {}, type = "finding") {
    const evidenceIDs = Array.isArray(row.evidenceIDs) ? row.evidenceIDs.map(String).filter(Boolean)
      : Array.isArray(row.evidence) ? row.evidence.map(value => typeof value === "object" ? value.id : value).map(String).filter(Boolean) : [];
    return {
      ...row,
      id: String(row.id || id()),
      type: String(row.type || type),
      statement: String(row.statement || row.description || row.claim || ""),
      evidenceIDs,
      evidenceSemantics: String(row.evidenceSemantics || (type === "gap" ? "coverage-gap" : "conflict-claim")),
      supportStatus: String(row.supportStatus || (evidenceIDs.length ? "supported" : "needs-evidence")),
      createdAt: String(row.createdAt || now())
    };
  }

  function matrixRow(card, extra = {}) {
    return {
      paper: { candidateID: card?.candidateID || Agent.LiteratureRanking?.identifier(card), title: card?.metadata?.title || "", year: card?.metadata?.year || null },
      year: card?.metadata?.year || null,
      researchQuestion: String(extra.researchQuestion || ""),
      method: String(extra.method || ""),
      data: String(extra.data || extra.dataset || ""),
      variables: String(extra.variables || ""),
      mainFindings: String(extra.mainFindings || ""),
      limitations: String(extra.limitations || ""),
      keyEvidence: Array.isArray(extra.keyEvidence) ? extra.keyEvidence : [],
      citation: extra.citation || null,
      evidenceLevel: extra.evidenceLevel || "metadata"
    };
  }

  class ReviewWorkspaceService {
    constructor(controller, options = {}) {
      this.controller = controller;
      this.storage = controller?.storage || options.storage;
      this.discovery = options.discovery || controller?.agent?.facade?.literature || null;
      this.root = joinPath(this.storage?.root || "", "agent", "review-workspaces");
      this.memory = new Map();
    }

    path(workspaceID) { return joinPath(this.root, `${String(workspaceID || "").replace(/[^A-Za-z0-9_-]/g, "")}.json`); }

    async load(workspaceID) {
      const key = String(workspaceID || "");
      if (!key) return null;
      if (this.memory.has(key)) return this.memory.get(key);
      const row = await this.storage?.readJSON?.(this.path(key), null);
      if (row?.id) this.memory.set(key, row);
      return row || null;
    }

    async save(workspace) {
      workspace.updatedAt = now();
      this.memory.set(workspace.id, workspace);
      await this.storage?.ensureDir?.(this.root);
      await this.storage?.writeJSON?.(this.path(workspace.id), workspace);
      return workspace;
    }

    blank(args = {}) {
      const timestamp = now();
      return {
        schemaVersion: 1,
        id: String(args.id || id()),
        question: String(args.question || args.query || ""),
        scope: args.scope || {},
        createdAt: timestamp,
        updatedAt: timestamp,
        candidatePool: [], includedPapers: [], excludedPapers: [],
        literatureMatrix: [], topicClusters: [], methodMatrix: [],
        claims: [], evidenceLedger: [], conflictLedger: [], gapLedger: [],
        citationGraph: { nodes: [], edges: [] },
        coverage: { candidateCount: 0, includedCount: 0, evidenceCount: 0, byLevel: {} },
        bibliography: [], draftArtifacts: [],
        analysis: { status: "external-agent-required", generated: false }
      };
    }

    async create(args = {}) {
      const workspace = this.blank(args);
      if (args.candidatePool || args.candidates) workspace.candidatePool = (args.candidatePool || args.candidates || []).slice(0, 500);
      if (args.includedPapers) workspace.includedPapers = [...new Set(args.includedPapers.map(String))];
      workspace.coverage = this.coverage(workspace);
      return this.save(workspace);
    }

    async refresh(args = {}) {
      const workspace = await this.load(args.id || args.workspaceID);
      if (!workspace) throw new C.AgentError("REVIEW_WORKSPACE_NOT_FOUND", "未找到综述工作区", { recoverable: false });
      if (this.discovery && workspace.question) {
        const result = await this.discovery.search({ query: workspace.question, limit: args.limit || 30, shortlistLimit: args.shortlistLimit || 30, includeGraph: true, external: args.external !== false });
        workspace.candidatePool = result.items || [];
        workspace.citationGraph = result.graph || workspace.citationGraph;
        workspace.coverage = this.coverage(workspace);
      }
      return this.save(workspace);
    }

    async update(args = {}) {
      const workspace = await this.load(args.id || args.workspaceID);
      if (!workspace) throw new C.AgentError("REVIEW_WORKSPACE_NOT_FOUND", "未找到综述工作区", { recoverable: false });
      if (Array.isArray(args.includePapers)) workspace.includedPapers = [...new Set(args.includePapers.map(String))];
      if (Array.isArray(args.excludePapers)) workspace.excludedPapers = [...new Set(args.excludePapers.map(String))];
      if (Array.isArray(args.literatureMatrix)) workspace.literatureMatrix = args.literatureMatrix.map(row => {
        const candidateID = String(row?.candidateID || row?.paperID || row?.paper?.candidateID || "");
        const card = (workspace.candidatePool || []).find(item => String(item?.candidateID || Agent.LiteratureRanking?.identifier(item) || "") === candidateID);
        return card ? matrixRow(card, row) : { ...row };
      });
      if (Array.isArray(args.topicClusters)) workspace.topicClusters = args.topicClusters;
      if (Array.isArray(args.methodMatrix)) workspace.methodMatrix = args.methodMatrix;
      if (Array.isArray(args.claims)) workspace.claims = args.claims;
      if (Array.isArray(args.evidence)) workspace.evidenceLedger.push(...args.evidence.map(normalizeEvidence));
      if (Array.isArray(args.gaps)) workspace.gapLedger.push(...args.gaps.map(row => normalizeFinding(row, "gap")));
      if (Array.isArray(args.conflicts)) workspace.conflictLedger.push(...args.conflicts.map(row => normalizeFinding(row, "conflict")));
      workspace.coverage = this.coverage(workspace);
      return this.save(workspace);
    }

    async addEvidence(workspaceID, rows = []) { return this.update({ id: workspaceID, evidence: rows }); }

    coverage(workspace) {
      const byLevel = {};
      for (const row of workspace.evidenceLedger || []) byLevel[row.evidenceLevel] = Number(byLevel[row.evidenceLevel] || 0) + 1;
      return { candidateCount: (workspace.candidatePool || []).length, includedCount: (workspace.includedPapers || []).length, evidenceCount: (workspace.evidenceLedger || []).length, byLevel };
    }

    async status(args = {}) {
      const workspace = await this.load(args.id || args.workspaceID);
      if (!workspace) throw new C.AgentError("REVIEW_WORKSPACE_NOT_FOUND", "未找到综述工作区", { recoverable: false });
      return { id: workspace.id, question: workspace.question, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, coverage: this.coverage(workspace), candidateCount: workspace.candidatePool.length, includedCount: workspace.includedPapers.length, evidenceCount: workspace.evidenceLedger.length };
    }

    async read(args = {}) {
      const workspace = await this.load(args.id || args.workspaceID);
      if (!workspace) throw new C.AgentError("REVIEW_WORKSPACE_NOT_FOUND", "未找到综述工作区", { recoverable: false });
      if (args.section && Object.prototype.hasOwnProperty.call(workspace, args.section)) return { id: workspace.id, section: args.section, value: workspace[args.section] };
      return workspace;
    }

    async export(args = {}) {
      const workspace = await this.read(args);
      const format = String(args.format || "json").toLowerCase();
      if (format === "markdown" || format === "md") {
        const lines = [`# ${workspace.question || "Literature Review"}`, "", `- 候选文献：${workspace.candidatePool.length}`, `- 纳入文献：${workspace.includedPapers.length}`, "", "## Literature Matrix", ""];
        for (const row of workspace.literatureMatrix) lines.push(`- ${row.paper?.title || "未命名文献"}（${row.year || ""}）：${row.mainFindings || ""}`);
        lines.push("", "## Evidence Ledger", "");
        for (const row of workspace.evidenceLedger) lines.push(`- [${row.evidenceLevel}] ${row.quote || row.claim} (${row.documentID || row.paperID || ""})`);
        return { workspaceID: workspace.id, format: "markdown", text: lines.join("\n") };
      }
      return { workspaceID: workspace.id, format: "json", text: JSON.stringify(workspace, null, 2) };
    }

    static matrixRow(card, extra) { return matrixRow(card, extra); }
    static normalizeEvidence(row) { return normalizeEvidence(row); }
  }

  Agent.ReviewWorkspaceService = ReviewWorkspaceService;
  Agent.ReviewWorkspaceHelpers = { normalizeEvidence, normalizeFinding, matrixRow, evidenceLevel };
})(this);
