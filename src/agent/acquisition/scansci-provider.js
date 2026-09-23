(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function joinPath(...parts) {
    try { return global.PathUtils?.join?.(...parts) || parts.filter(Boolean).join("/"); }
    catch (_) { return parts.filter(Boolean).join("/"); }
  }

  class ScanSciProvider {
    constructor(runtime, options = {}) {
      this.name = "managed-scansci";
      this.runtime = runtime;
      this.client = options.client || (Agent.ScanSciMCPClient ? new Agent.ScanSciMCPClient(runtime, { storage: runtime?.storage, ...(options.clientOptions || {}) }) : null);
      this.validator = options.validator || Agent.PDFValidator;
      this.institution = Agent.ScanSciInstitutionAccessBridge ? new Agent.ScanSciInstitutionAccessBridge(this, options.institutionOptions || {}) : null;
    }

    async acquire(candidate, options = {}) {
      const doi = Agent.PaperCardHelpers?.normalizeDOI?.(candidate?.identifiers?.doi || candidate?.doi || "") || "";
      const arxiv = Agent.PaperCardHelpers?.normalizeArxiv?.(candidate?.identifiers?.arxiv || candidate?.arxiv || "") || "";
      const identifier = doi || arxiv;
      if (!identifier) {
        return {
          status: "unresolved",
          provider: this.name,
          code: "ACQUISITION_IDENTIFIER_UNRESOLVED",
          reason: "unresolved-acquisition-identifier",
          candidateID: candidate?.candidateID || ""
        };
      }
      const preflightToken = Agent.RuntimePreflightToken;
      const preflight = preflightToken ? options[preflightToken] : null;
      const runtime = preflight && typeof preflight.available === "boolean"
        ? preflight
        : await this.runtime.ensure({ signal: options.signal, onProgress: options.onProgress, downloadTimeoutMs: options.runtimeDownloadTimeoutMs });
      if (!runtime.available) return { status: "unavailable", provider: this.name, reason: "acquisition unavailable", diagnostics: runtime.diagnostics || runtime.reason };
      if (!this.client || typeof this.client.call !== "function") return { status: "unavailable", provider: this.name, reason: "acquisition unavailable", diagnostics: "ScanSci MCP client is not configured" };
      let outputPath = "";
      try {
        const outputDir = options.outputDir || joinPath(this.runtime?.storage?.root || "", "staging", "acquisition", "scansci");
        await this.runtime?.storage?.ensureDir?.(outputDir);
        const response = Agent.normalizeScanSciDownloadResult
          ? Agent.normalizeScanSciDownloadResult(await this.client.call("scansci_pdf_download", { identifier, output_dir: outputDir, use_vpnsci: true }, {
            signal: options.signal,
            timeoutMs: Number(options.downloadTimeoutMs || this.runtime?.manifest?.scansci?.downloadTimeoutMs || 180000)
          }))
          : await this.client.call("scansci_pdf_download", { identifier, output_dir: outputDir, use_vpnsci: true }, {
            signal: options.signal,
            timeoutMs: Number(options.downloadTimeoutMs || 180000)
          });
        if (response?.success === false) {
          const loginRequired = /login|institution|paywall|auth/i.test(String(response.action || response.error_type || ""));
          return {
            status: "failed",
            provider: this.name,
            code: loginRequired ? "INSTITUTION_LOGIN_REQUIRED" : "SCANSCI_DOWNLOAD_FAILED",
            reason: response.error_type || "scansci-download-failed",
            diagnostics: response.error || response.agent_hint || "ScanSci returned an unsuccessful acquisition result",
            suggestedAction: loginRequired ? "litmtrans_fulltext_access" : "",
            accessAction: loginRequired ? "login" : "",
            response
          };
        }
        const path = String(response?.path || response?.file || response?.pdfPath || "");
        outputPath = path;
        if (!path) return { status: "invalid", provider: this.name, code: "SCANSCI_OUTPUT_MISSING", validation: { valid: false, reason: "missing-output-path" }, response };
        const validation = path ? await this.validator.validateFile(path, options) : { valid: false, reason: "missing-output-path" };
        if (!validation.valid) {
          await this.cleanupPath(path);
          return { status: "invalid", provider: this.name, validation, diagnostics: response?.error || "ScanSci returned an invalid PDF" };
        }
        return { status: "available", provider: this.name, path, validation, provenance: { source: response?.source || "scansci-pdf", retrievedAt: new Date().toISOString() } };
      }
      catch (error) {
        if (options.signal?.aborted) await this.cleanupPath(outputPath);
        return { status: "failed", provider: this.name, code: options.signal?.aborted ? "JOB_CANCELLED" : "SCANSCI_DOWNLOAD_FAILED", error: String(error?.message || error) };
      }
    }

    async cleanupPath(path) {
      const value = String(path || "");
      if (!value) return false;
      try {
        const root = String(this.runtime?.storage?.root || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
        const normalized = value.replace(/\\/g, "/").toLowerCase();
        if (!root || !normalized.startsWith(`${root}/staging/acquisition/`)) return false;
        await this.runtime?.storage?.removeFile?.(path);
        return true;
      }
      catch (_) { return false; }
    }

    institutionToolsAvailable(action = "") { return Boolean(this.institution?.available(action)); }

    institutionActions() { return this.institution?.availableActions?.() || []; }

    async institutionAccess(action, args = {}, options = {}) {
      if (!this.institution) return { status: "unavailable", code: "INSTITUTION_ACCESS_UNAVAILABLE", reason: "bridge-unavailable" };
      return this.institution.invoke(action, args, options);
    }

    async shutdown() {
      return this.client?.shutdown?.() || { stopped: true };
    }
  }

  Agent.ScanSciProvider = ScanSciProvider;
})(this);
