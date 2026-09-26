(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value == null ? null : value);
  }

  function list(value) {
    return [...new Set((Array.isArray(value) ? value : [value]).map(item => String(item || "").trim()).filter(Boolean))].sort();
  }

  function countMap(value) {
    const output = {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, count] of Object.entries(value)) {
        const normalized = String(key || "").trim();
        const numeric = Math.max(0, Number(count) || 0);
        if (normalized && numeric) output[normalized] = numeric;
      }
    }
    return output;
  }

  function normalizePlan(plan = {}) {
    const services = list(plan.services);
    const documentIDs = list(plan.documentIDs).slice(0, 2000);
    const providers = list(plan.providers || plan.provider);
    const models = list(plan.models || plan.model);
    const serviceCounts = countMap(plan.serviceCounts);
    const documentCount = documentIDs.length || Math.max(0, Number(plan.documentCount || 0) || 0);
    const parseCount = Math.max(0, Number(plan.parseCount || 0) || 0);
    const translateCount = Math.max(0, Number(plan.translateCount || 0) || 0);
    return {
      services,
      provider: String(plan.provider || "").trim(),
      providers,
      model: String(plan.model || "").trim(),
      models,
      serviceCounts,
      documentCount,
      parseCount,
      translateCount,
      operation: String(plan.operation || "external").trim(),
      allowedOperations: list(plan.allowedOperations || plan.operation),
      estimatedScope: String(plan.estimatedScope || "").trim(),
      unresolvedDocumentScope: plan.unresolvedDocumentScope === true,
      documentIDs
    };
  }

  function randomToken(prefix) {
    return LitMTrans.Utils?.randomID?.(prefix) || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  class ExternalApprovalService {
    constructor(storage) {
      this.storage = storage;
      this.root = PathUtils.join(storage.root, "agent");
      this.path = PathUtils.join(this.root, "approvals.json");
      this.rows = new Map();
      this.requestStates = new Map();
      this.persistChain = Promise.resolve();
    }

    async init() {
      await this.storage.ensureDir(this.root);
      const rows = await this.storage.readJSON(this.path, []);
      for (const row of Array.isArray(rows) ? rows : []) if (row?.approvalID) this.rows.set(String(row.approvalID), row);
      await this.persist();
    }

    plan(plan) {
      const normalized = normalizePlan(plan);
      return { ...normalized, planHash: LitMTrans.Utils?.hashString?.(stable(normalized)) || stable(normalized) };
    }

    public(row) {
      if (!row) return null;
      return C.redact({
        approvalID: row.approvalID,
        planHash: row.planHash,
        status: row.status,
        plan: row.plan,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        approvedAt: row.approvedAt || ""
      });
    }

    async persist() {
      this.persistChain = this.persistChain.catch(() => {}).then(() => this.storage.writeJSON(this.path, [...this.rows.values()].slice(-200)));
      return this.persistChain;
    }

    compatible(parentPlan, childPlan) {
      const parent = normalizePlan(parentPlan);
      const child = normalizePlan(childPlan);
      const parentServices = new Set(parent.services);
      if (child.services.some(service => !parentServices.has(service))) return false;
      if (!parent.unresolvedDocumentScope && child.documentIDs.some(documentID => !parent.documentIDs.includes(documentID))) return false;
      if (!parent.unresolvedDocumentScope && child.documentIDs.length > parent.documentIDs.length) return false;
      if (child.documentCount > parent.documentCount) return false;
      const operations = new Set([...parent.allowedOperations, parent.operation]);
      if (child.operation && !operations.has(child.operation) && !operations.has("batch")) return false;

      const parentProviders = new Set(parent.providers.length ? parent.providers : (parent.provider ? [parent.provider] : []));
      const childProviders = child.providers.length ? child.providers : (child.provider ? [child.provider] : []);
      if (childProviders.some(provider => parentProviders.size && !parentProviders.has(provider))) return false;
      const parentModels = new Set(parent.models.length ? parent.models : (parent.model ? [parent.model] : []));
      const childModels = child.models.length ? child.models : (child.model ? [child.model] : []);
      if (childModels.some(model => parentModels.size && !parentModels.has(model))) return false;

      for (const [service, count] of Object.entries(child.serviceCounts)) {
        if (count > Number(parent.serviceCounts[service] || 0)) return false;
      }
      if (child.parseCount > parent.parseCount && parent.parseCount > 0) return false;
      if (child.translateCount > parent.translateCount && parent.translateCount > 0) return false;
      return true;
    }

    find(approvalID) {
      const row = this.rows.get(String(approvalID || ""));
      if (!row) return null;
      if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) {
        row.status = "expired";
        return null;
      }
      return row;
    }

    required(row) {
      const details = {
        approvalID: row.approvalID,
        planHash: row.planHash,
        services: row.plan.services,
        provider: row.plan.provider,
        model: row.plan.model,
        documentCount: row.plan.documentCount,
        operation: row.plan.operation,
        estimatedScope: row.plan.estimatedScope,
        plan: row.plan,
        expiresAt: row.expiresAt
      };
      return new C.AgentError("EXTERNAL_SERVICE_APPROVAL_REQUIRED", "即将调用已配置的外部服务，需要一次明确批准", {
        recoverable: true,
        suggestedAction: "approve_external_service",
        details
      });
    }

    denied(row) {
      return new C.AgentError("EXTERNAL_SERVICE_APPROVAL_DENIED", "用户拒绝了本次外部服务调用", {
        recoverable: false,
        details: this.public(row)
      });
    }

    createRequestState(details = {}) {
      const token = randomToken("request");
      this.requestStates.set(token, {
        approvalID: String(details.approvalID || ""),
        planHash: String(details.planHash || ""),
        toolName: String(details.toolName || ""),
        plan: details.plan || null,
        expiresAt: String(details.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString()),
        createdAt: C.now()
      });
      return token;
    }

    takeRequestState(token, toolName) {
      const key = String(token || "").trim();
      const state = this.requestStates.get(key);
      if (!state) throw new C.AgentError("MCP_REQUEST_STATE_INVALID", "requestState 无效、已使用或已过期", { recoverable: true, suggestedAction: "retry_external_approval" });
      if (state.expiresAt && Date.parse(state.expiresAt) < Date.now()) {
        this.requestStates.delete(key);
        throw new C.AgentError("MCP_REQUEST_STATE_EXPIRED", "requestState 已过期，请重新发起外部服务请求", { recoverable: true, suggestedAction: "retry_external_approval" });
      }
      if (state.toolName && state.toolName !== String(toolName || "")) {
        throw new C.AgentError("MCP_REQUEST_STATE_MISMATCH", "requestState 与当前工具不匹配", { recoverable: false });
      }
      this.requestStates.delete(key);
      return state;
    }

    async resolveRequestState(token, values = {}) {
      const state = this.takeRequestState(token, values.toolName);
      const row = this.find(state.approvalID);
      if (!row || row.planHash !== state.planHash) throw new C.AgentError("MCP_REQUEST_STATE_MISMATCH", "requestState 对应的审批计划已经失效", { recoverable: true, suggestedAction: "retry_external_approval" });
      if (values.approved !== true) {
        row.status = "denied";
        await this.persist();
        throw this.denied(row);
      }
      await this.approve(row.approvalID, { approved: true, planHash: state.planHash });
      return { approvalID: row.approvalID, planHash: row.planHash, approved: true };
    }

    async ensure(planInput, provided = {}) {
      const plan = this.plan(planInput);
      if (!plan.services.length) return { approved: true, plan, approvalID: "" };
      const approvalID = String(provided.approvalID || provided._approvalID || provided.parentApprovalID || "").trim();
      if (approvalID) {
        const row = this.find(approvalID);
        if (row && row.status === "approved" && (row.planHash === plan.planHash || this.compatible(row.plan, plan))) {
          return { approved: true, plan, approvalID: row.approvalID, inherited: row.planHash !== plan.planHash };
        }
        if (provided.approved === false) throw this.denied(row || { approvalID, plan });
      }
      if (provided.approved === true && !approvalID) {
        throw new C.AgentError("EXTERNAL_APPROVAL_ID_REQUIRED", "批准外部服务前必须提供有效的审批状态", { recoverable: true, suggestedAction: "retry_external_approval", details: { planHash: plan.planHash } });
      }
      let row = [...this.rows.values()].find(item => item.status === "pending" && item.planHash === plan.planHash);
      if (!row) {
        row = {
          approvalID: randomToken("approval"),
          planHash: plan.planHash,
          plan,
          status: "pending",
          createdAt: C.now(),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          approvedAt: ""
        };
        this.rows.set(row.approvalID, row);
        await this.persist();
      }
      throw this.required(row);
    }

    async approve(approvalID, values = {}) {
      const row = this.find(approvalID);
      if (!row) throw new C.AgentError("EXTERNAL_APPROVAL_NOT_FOUND", `未找到外部服务批准请求 ${approvalID}`, { recoverable: false });
      const planHash = String(values.planHash || "").trim();
      if (planHash && planHash !== row.planHash) throw new C.AgentError("EXTERNAL_APPROVAL_PLAN_CHANGED", "外部服务计划已经变化，需要重新确认", { recoverable: true, suggestedAction: "approve_external_service", details: { approvalID: row.approvalID, expectedPlanHash: row.planHash, receivedPlanHash: planHash } });
      if (values.approved !== true) {
        row.status = "denied";
        await this.persist();
        throw this.denied(row);
      }
      row.status = "approved";
      row.approvedAt = C.now();
      await this.persist();
      return { ...this.public(row), approved: true };
    }
  }

  Agent.ExternalApprovalService = ExternalApprovalService;
  Agent.normalizeExternalPlan = normalizePlan;
})(this);
