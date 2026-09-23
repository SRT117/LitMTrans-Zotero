(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  const SECRET_KEY = /(?:api.?key|mineru.?token|access.?token|token|authorization|cookie|password|secret|credential|private.?key|bearer)/i;
  const SECRET_VALUE = "[REDACTED]";

  function isObject(value) {
    return value && typeof value === "object";
  }

  function redact(value, depth = 0, seen = new Set()) {
    if (depth > 8) return "[TRUNCATED]";
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "function") return undefined;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(item => redact(item, depth + 1, seen));
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_KEY.test(key)) output[key] = SECRET_VALUE;
        else output[key] = redact(item, depth + 1, seen);
      }
      return output;
    }
    finally {
      seen.delete(value);
    }
  }

  function safeText(value, max = 200000) {
    const text = String(value ?? "");
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 80))}\n\n[内容已截断，原长度 ${text.length}]`;
  }

  function redactText(value) {
    return String(value ?? "").replace(/((?:api[_-]?key|chat[_-]?api[_-]?key|mineru[_-]?token|access[_-]?token|cookie(?:[_-]?file)?|token|authorization|password|secret|credential)\s*[=:]\s*)(["']?)[^\s,;"']+\2/gi, "$1[REDACTED]");
  }

  function now() {
    return new Date().toISOString();
  }

  function safeID(value, fallback = "") {
    return String(value ?? fallback).trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 160);
  }

  class AgentError extends Error {
    constructor(code, message, options = {}) {
      super(String(message || code || "Agent operation failed"));
      this.name = "AgentError";
      this.code = String(code || "AGENT_ERROR");
      this.recoverable = Boolean(options.recoverable);
      this.suggestedAction = String(options.suggestedAction || "");
      this.details = options.details == null ? null : redact(options.details);
    }

    toJSON() {
      return {
        code: this.code,
        message: this.message,
        recoverable: this.recoverable,
        suggestedAction: this.suggestedAction,
        details: this.details
      };
    }
  }

  function asAgentError(error, fallbackCode = "AGENT_ERROR") {
    if (error instanceof AgentError) return error;
    const message = String(error?.message || error || "Agent operation failed");
    return new AgentError(fallbackCode, message, {
      recoverable: Boolean(error?.recoverable),
      suggestedAction: error?.suggestedAction,
      details: error?.details
    });
  }

  function safeProviderStatus(controller, purpose = "translation") {
    const llm = controller?.llm;
    let settings = {};
    try { settings = llm?.getSettings?.(purpose) || {}; }
    catch (_) { settings = {}; }
    const provider = String(settings.provider || "").trim();
    const spec = LitMTrans.Utils?.providerSpec?.(provider) || {};
    let configured = Boolean(settings.configured || settings.hasAPIKey || settings.apiKey);
    if (spec.webDriver === true || LitMTrans.Utils?.isWebMachineProvider?.(provider)) configured = true;
    return {
      provider,
      model: String(settings.model || ""),
      configured,
      mode: spec.webDriver === true ? "web" : (LitMTrans.Utils?.isWebMachineProvider?.(provider) ? "local_or_web" : "api")
    };
  }

  function safeSettings(controller) {
    const translation = safeProviderStatus(controller, "translation");
    const chat = safeProviderStatus(controller, "chat");
    const settings = {};
    try {
      const raw = controller?.getSettings?.() || {};
      settings.targetLanguage = String(raw.targetLanguage || "");
      settings.translationMode = String(raw.translationMode || "");
      settings.chatEngine = String(raw.chatEngine || "");
      settings.mineruModel = String(raw.mineruModel || "");
      settings.mineruConfigured = Boolean(raw.mineruToken || raw.hasMinerUToken || controller?.secrets?.getMinerUToken?.());
    }
    catch (_) {}
    return { translation, chat, ...settings };
  }

  Agent.Contracts = {
    SECRET_VALUE,
    AgentError,
    asAgentError,
    redact,
    safeText,
    redactText,
    safeID,
    now,
    safeProviderStatus,
    safeSettings,
    isObject
  };
})(this);
