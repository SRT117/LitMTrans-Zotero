(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  const MODES = new Set(["read", "full", "developer"]);
  const READ_OPERATIONS = new Set([
    "capabilities", "context", "library-read", "paper-read", "reading", "search", "jobs-read",
    "resource", "processing-capacity", "client-config", "chat-read", "research-read", "diagram-read",
    "storage-summary", "external-approval", "annotation-read", "literature-discovery", "acquisition-read",
    "review-read"
  ]);
  const WRITE_OPERATIONS = new Set([
    "library-write", "processing", "chat-write", "research-write", "export", "annotation-write", "diagram-write",
    "maintenance", "literature-import", "acquisition-write", "review-write"
  ]);

  function normalizeMode(value) {
    const mode = String(value || "full").trim().toLowerCase();
    if (mode === "readonly" || mode === "read-only" || mode === "只读") return "read";
    if (mode === "developer" || mode === "开发者") return "developer";
    return MODES.has(mode) ? mode : "full";
  }

  class CapabilityPolicy {
    constructor(controller) {
      this.controller = controller;
    }

    settings() {
      const U = LitMTrans.Utils;
      return {
        enabled: Boolean(U?.getPref?.("agentEnabled", false)),
        mode: normalizeMode(U?.getPref?.("agentAccessMode", "full")),
        allowConfiguredServices: Boolean(U?.getPref?.("agentAllowConfiguredServices", true)),
        allowChatHistory: Boolean(U?.getPref?.("agentAllowChatHistory", true)),
        backgroundProvider: String(U?.getPref?.("agentBackgroundProvider", "auto") || "auto")
      };
    }

    can(operation) {
      const kind = String(operation || "");
      const current = this.settings();
      if (kind === "developer") return current.mode === "developer";
      if (READ_OPERATIONS.has(kind)) {
        if (kind === "chat-read" && !current.allowChatHistory) return false;
        return true;
      }
      if (WRITE_OPERATIONS.has(kind)) return current.mode !== "read";
      return current.mode !== "read";
    }

    assert(operation, details = null) {
      const kind = String(operation || "");
      const current = this.settings();
      if (!this.can(kind)) {
        if (kind === "chat-read" && !current.allowChatHistory) {
          throw new C.AgentError("CHAT_HISTORY_DISABLED", "用户已关闭智能体读取 LitMTrans 对话历史", { recoverable: false });
        }
        if (kind === "developer") {
          throw new C.AgentError("DEVELOPER_ACCESS_REQUIRED", "该能力需要开启开发者访问模式", { recoverable: false });
        }
        throw new C.AgentError("AGENT_READ_ONLY", "当前智能体权限为只读，不能执行写入或处理任务", {
          recoverable: false,
          details
        });
      }
      if (kind === "processing" && !current.allowConfiguredServices) {
        throw new C.AgentError("CONFIGURED_SERVICES_DISABLED", "用户已关闭智能体使用已配置的解析/AI服务", {
          recoverable: false,
          suggestedAction: "enable_agent_configured_services"
        });
      }
      return true;
    }

    capabilities() {
      const current = this.settings();
      const full = current.mode !== "read";
      const developer = current.mode === "developer";
      return {
        ...current,
        modes: ["read", "full", "developer"],
        toolsets: {
          core: true,
          library: true,
          reading: true,
          processing: full && current.allowConfiguredServices,
        research: true,
        literatureDiscovery: true,
        paperAcquisition: full,
        reviewWorkspace: true,
        annotations: { read: true, write: full },
          write: full,
          export: full,
          developer
        }
      };
    }
  }

  Agent.CapabilityPolicy = CapabilityPolicy;
  Agent.normalizeAccessMode = normalizeMode;
})(this);
