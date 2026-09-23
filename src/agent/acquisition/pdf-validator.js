(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function decode(value, limit = 0) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
    const slice = limit > 0 ? bytes.slice(0, limit) : bytes;
    try { return new TextDecoder("latin1").decode(slice); }
    catch (_) {
      let output = "";
      for (let index = 0; index < slice.length; index += 8192) {
        const chunk = slice.slice(index, index + 8192);
        output += String.fromCharCode.apply(null, Array.from(chunk));
      }
      return output;
    }
  }

  class PDFValidator {
    static async validateBytes(value, options = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      const minBytes = Math.max(64, Number(options.minBytes || 1024));
      if (bytes.length < minBytes) return { valid: false, reason: "file-too-small", size: bytes.length };
      const signature = decode(bytes, 5);
      if (signature !== "%PDF-") return { valid: false, reason: "not-pdf", size: bytes.length };
      const prefix = decode(bytes, 256).toLowerCase();
      if (prefix.includes("<html") || prefix.includes("<!doctype")) return { valid: false, reason: "html-error-page", size: bytes.length };
      let pageCount = 0;
      if (global.PDFLib?.PDFDocument) {
        try { const pdf = await global.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true }); pageCount = Number(pdf.getPageCount?.() || 0); }
        catch (_) { return { valid: false, reason: "pdf-open-failed", size: bytes.length }; }
      }
      else pageCount = (decode(bytes).match(/\/Type\s*\/Page(?:\s|\/|>)/g) || []).length;
      if (pageCount <= 0) return { valid: false, reason: "no-pages", size: bytes.length, pageCount };
      return { valid: true, size: bytes.length, pageCount, signature: "PDF" };
    }

    static async validateFile(path, options = {}) {
      try {
        const stat = await global.IOUtils.stat(path);
        const size = Number(stat?.size || 0);
        const minBytes = Math.max(64, Number(options.minBytes || 1024));
        const maxBytes = Number(options.maxBytes || 120 * 1024 * 1024);
        if (size < minBytes) return { valid: false, reason: "file-too-small", size };
        if (size > maxBytes) return { valid: false, reason: "file-too-large", size };
        if (options.fullValidation === true) return this.validateBytes(await global.IOUtils.read(path), options);
        const prefix = await global.IOUtils.read(path, { maxBytes: Math.min(size, 64 * 1024) });
        const signature = decode(prefix, 5);
        const header = decode(prefix, Math.min(prefix.length, 4096)).toLowerCase();
        if (signature !== "%PDF-") return { valid: false, reason: "not-pdf", size };
        if (header.includes("<html") || header.includes("<!doctype")) return { valid: false, reason: "html-error-page", size };
        return { valid: true, size, pageCount: (decode(prefix).match(/\/Type\s*\/Page(?:\s|\/|>)/g) || []).length || null, signature: "PDF", validation: "streamed-header" };
      }
      catch (error) { return { valid: false, reason: String(error?.message || error) }; }
    }
  }

  Agent.PDFValidator = PDFValidator;
})(this);
