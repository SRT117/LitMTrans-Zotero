(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function clean(value) {
    if (C?.redact) return C.redact(value);
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(clean);
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(cookie|token|password|secret|credential|authorization|private.?key)/i.test(key)) output[key] = "[REDACTED]";
      else output[key] = clean(item);
    }
    return output;
  }

  class ScanSciInstitutionAccessBridge {
    constructor(provider, options = {}) {
      this.provider = provider;
      this.client = provider?.client || null;
      this.runtime = provider?.runtime || null;
      this.options = options;
    }

    requiredTools(action) {
      if (action === "status") return ["scansci_pdf_channel_status"];
      if (action === "schools") return ["scansci_pdf_schools"];
      if (action === "login") return ["scansci_pdf_login"];
      return [];
    }

    available(action = "") {
      const actions = action ? [action] : ["status", "schools", "login"];
      if (!this.client) return false;
      if (this.client.initialized) {
        if (typeof this.client.hasTools !== "function") return false;
        return actions.every(name => this.client.hasTools(this.requiredTools(name)));
      }

      const target = this.runtime?.targetManifest || this.runtime?.manifest?.targets?.[this.runtime?.platform?.target];
      if (target?.status !== "field-validated") return false;
      const expectedTools = new Set(this.runtime?.manifest?.scansci?.institutionToolNames || []);
      if (!expectedTools.size) return false;
      if (actions.some(name => !this.requiredTools(name).length)) return false;
      return actions.every(name => this.requiredTools(name).every(tool => expectedTools.has(tool)));
    }

    availableActions() {
      return ["status", "schools", "login"].filter(action => this.available(action));
    }

    async ensure(options = {}) {
      const runtime = await this.runtime?.ensure?.({ signal: options.signal, onProgress: options.onProgress });
      if (!runtime?.available) return { available: false, code: "INSTITUTION_ACCESS_UNAVAILABLE", reason: runtime?.reason || "managed-runtime-unavailable", diagnostics: runtime?.diagnostics || "" };
      if (!this.client) return { available: false, code: "INSTITUTION_ACCESS_UNAVAILABLE", reason: "scansci-client-unavailable" };
      await this.client.start({
        signal: options.signal,
        controlTimeoutMs: options.controlTimeoutMs,
        loginTimeoutMs: options.loginTimeoutMs,
        downloadTimeoutMs: options.downloadTimeoutMs
      });
      return { available: true, runtime };
    }

    async invoke(action, args = {}, options = {}) {
      const normalized = String(action || "status").trim().toLowerCase();
      if (!["status", "schools", "login"].includes(normalized)) {
        return { status: "invalid", code: "INSTITUTION_ACCESS_ACTION_UNSUPPORTED", reason: "unsupported-action", action: normalized };
      }
      const prepared = await this.ensure(options);
      if (!prepared.available) return { status: "unavailable", ...prepared, action: normalized };
      if (!this.available(normalized)) {
        return { status: "unavailable", code: "INSTITUTION_ACCESS_TOOL_UNAVAILABLE", reason: "scansci-tool-not-advertised", action: normalized, availableActions: this.availableActions() };
      }
      let tool;
      let input = {};
      if (normalized === "status") {
        tool = "scansci_pdf_channel_status";
        input = { kind: String(args.kind || "webvpn") };
        if (args.doi || args.identifier) input.doi = String(args.doi || args.identifier);
      }
      else if (normalized === "schools") {
        tool = "scansci_pdf_schools";
        const schoolAction = String(args.school || "").trim() ? "set" : "search";
        input = { action: schoolAction };
        if (args.query) input.query = String(args.query);
        if (args.school) input.school = String(args.school);
      }
      else {
        tool = "scansci_pdf_login";
        input = { kind: String(args.kind || "publisher") };
        const identifier = args.identifier || args.doi;
        if (identifier) input.identifier = String(identifier);
        for (const key of ["publisher", "custom_url"]) if (args[key]) input[key] = String(args[key]);
      }
      const result = await this.client.call(tool, input, {
        signal: options.signal,
        timeoutMs: normalized === "login"
          ? Number(options.loginTimeoutMs || this.options.loginTimeoutMs || 600000)
          : Number(options.controlTimeoutMs || this.options.controlTimeoutMs || 15000)
      });
      const output = clean(result);
      if (output && typeof output === "object" && (output.success === false || output.error)) {
        return {
          status: "failed",
          code: normalized === "login" ? "INSTITUTION_LOGIN_FAILED" : "INSTITUTION_ACCESS_FAILED",
          action: normalized,
          reason: String(output.error || "institution-access-failed"),
          result: output
        };
      }
      if (normalized === "login") {
        return {
          status: "login-started",
          action: normalized,
          requiresUserAction: true,
          message: "需要完成一次学校或出版社登录。请在打开的登录窗口中完成登录，完成后重试全文获取。",
          result: output
        };
      }
      return { status: "ok", action: normalized, result: output };
    }
  }

  Agent.ScanSciInstitutionAccessBridge = ScanSciInstitutionAccessBridge;
  Agent.cleanInstitutionResult = clean;
})(this);
