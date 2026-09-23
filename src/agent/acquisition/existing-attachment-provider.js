(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  class ExistingAttachmentProvider {
    constructor(library, controller, options = {}) { this.name = "existing-zotero-attachment"; this.library = library; this.controller = controller; this.validator = options.validator || Agent.PDFValidator; }

    async acquire(candidate, options = {}) {
      const ref = candidate?.local?.itemKey || candidate?.local?.documentID || candidate?.itemKey || candidate?.itemID || candidate?.identifiers?.doi;
      if (!ref) return { status: "not-found", provider: this.name };
      try {
        const item = await this.library.resolveItem(ref, { libraryID: candidate?.local?.libraryID });
        const attachment = await this.library.resolveAttachment(item);
        const path = await this.controller.attachmentPath(attachment);
        const validation = await this.validator.validateFile(path, options);
        if (!validation.valid) return { status: "invalid", provider: this.name, validation };
        return { status: "available", provider: this.name, existing: true, item, attachment, path, validation, provenance: { source: "zotero", retrievedAt: new Date().toISOString() } };
      }
      catch (error) { return { status: "not-found", provider: this.name, error: String(error?.message || error) }; }
    }
  }

  Agent.ExistingAttachmentProvider = ExistingAttachmentProvider;
})(this);
