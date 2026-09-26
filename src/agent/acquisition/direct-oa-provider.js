(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function joinPath(...parts) {
    try { return global.PathUtils?.join?.(...parts) || parts.filter(Boolean).join("/"); }
    catch (_) { return parts.filter(Boolean).join("/"); }
  }

  class DirectKnownLocationProvider {
    constructor(storage, options = {}) {
      this.name = "direct-known-location";
      this.storage = storage;
      this.validator = options.validator || Agent.PDFValidator;
      this.downloadBytes = options.downloadBytes || null;
      this.downloadToFile = options.downloadToFile || null;
      this.maxBytes = Number(options.maxBytes || 120 * 1024 * 1024);
    }

    async acquire(candidate, options = {}) {
      const location = candidate?.discovery?.bestOALocation || candidate?.bestOALocation || {};
      const url = String(location.pdfURL || location.url || candidate?.identifiers?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { status: "not-found", provider: this.name };
      try {
        const name = `${String(candidate?.identifiers?.doi || candidate?.metadata?.title || "paper").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)}.pdf`;
        const staging = joinPath(this.storage?.root || "", "staging", "acquisition", `${Date.now()}-${Math.random().toString(16).slice(2)}`, name);
        let validation;
        if (this.downloadToFile) {
          await this.downloadToFile(url, staging, { ...options, maxBytes: this.maxBytes });
          validation = await this.validator.validateFile(staging, options);
        }
        else if (this.downloadBytes) {
          const bytes = await this.downloadBytes(url, { ...options, maxBytes: this.maxBytes });
          if (bytes.length > this.maxBytes) return { status: "invalid", provider: this.name, validation: { valid: false, reason: "file-too-large", size: bytes.length }, url };
          validation = await this.validator.validateBytes(bytes, options);
          if (validation.valid) await this.storage?.writeBytes?.(staging, bytes);
        }
        else if (LitMTrans.HTTP?.requestToFile) {
          await LitMTrans.HTTP.requestToFile(url, staging, { timeout: Number(options.timeoutMs || 30000), signal: options.signal, maxBytes: this.maxBytes });
          validation = await this.validator.validateFile(staging, options);
        }
        else {
          const bytes = await LitMTrans.HTTP.requestBytes(url, { timeout: Number(options.timeoutMs || 30000), signal: options.signal, maxBytes: this.maxBytes });
          validation = await this.validator.validateBytes(bytes, options);
          if (validation.valid) await this.storage?.writeBytes?.(staging, bytes);
        }
        if (!validation.valid) {
          await this.storage?.removeFile?.(staging);
          return { status: "invalid", provider: this.name, validation, url };
        }
        return { status: "available", provider: this.name, path: staging, validation, provenance: { source: url, retrievedAt: new Date().toISOString() } };
      }
      catch (error) { return { status: "failed", provider: this.name, error: String(error?.message || error), url }; }
    }
  }

  Agent.DirectKnownLocationProvider = DirectKnownLocationProvider;
})(this);
