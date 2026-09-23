(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function text(value) { return String(value ?? "").trim(); }

  function normalizeDOI(value) {
    return text(value)
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .replace(/[\s\]}>,.;]+$/g, "")
      .toLowerCase();
  }

  function normalizeArxiv(value) {
    return text(value).replace(/^https?:\/\/arxiv\.org\/abs\//i, "").replace(/^arxiv:/i, "").replace(/v\d+$/i, "").toLowerCase();
  }

  function normalizeTitle(value) {
    return text(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function year(value) {
    const match = text(value).match(/\b(18|19|20|21)\d{2}\b/);
    return match ? Number(match[0]) : null;
  }

  function field(item, name) {
    try { return text(item?.getField?.(name)); }
    catch (_) { return text(item?.[name]); }
  }

  function creators(item) {
    let rows = [];
    try { rows = item?.getCreators?.() || []; }
    catch (_) { rows = Array.isArray(item?.creators) ? item.creators : []; }
    return (Array.isArray(rows) ? rows : []).map(row => {
      const name = text(row?.name || [row?.firstName, row?.lastName].filter(Boolean).join(" "));
      return name ? { name, firstName: text(row?.firstName), lastName: text(row?.lastName), creatorType: text(row?.creatorType || "author") } : null;
    }).filter(Boolean);
  }

  function tags(item) {
    try {
      return (item?.getTags?.() || []).map(row => text(row?.tag || row)).filter(Boolean);
    }
    catch (_) { return []; }
  }

  function collectionIDs(item) {
    try { return (item?.getCollections?.() || []).map(Number).filter(Number.isFinite); }
    catch (_) { return Array.isArray(item?.collections) ? item.collections.map(Number).filter(Number.isFinite) : []; }
  }

  async function attachmentFor(item) {
    if (!item) return null;
    try {
      const best = await Promise.resolve(item.getBestAttachment?.());
      if (best) return typeof best === "number" ? global.Zotero?.Items?.get?.(best) : best;
    }
    catch (_) {}
    let ids = [];
    try { ids = item.getAttachments?.() || []; } catch (_) {}
    const rows = (Array.isArray(ids) ? ids : []).map(value => typeof value === "number" ? global.Zotero?.Items?.get?.(value) : value).filter(Boolean);
    return rows.find(row => text(row.attachmentContentType).toLowerCase() === "application/pdf") || rows[0] || null;
  }

  function localIdentity(item, attachment, storage) {
    const libraryID = Number(item?.libraryID || attachment?.libraryID || 0) || null;
    const itemKey = text(item?.key || item?.itemKey);
    const parentItemID = Number(item?.id || item?.itemID || 0) || null;
    const itemParentID = Number(item?.parentID || item?.parentItemID || 0) || null;
    const attachmentKey = text(attachment?.key || "");
    const attachmentID = Number(attachment?.id || attachment?.attachmentID || 0) || null;
    let documentID = "";
    try { documentID = text(storage?.documentID?.(attachment)); } catch (_) {}
    if (!documentID && libraryID && attachmentKey) documentID = `${libraryID}-${attachmentKey}`;
    return { libraryID, itemKey, itemID: parentItemID || itemParentID || null, parentItemID: itemParentID || parentItemID || null, attachmentID, attachmentKey, documentID };
  }

  function emptyStatus() {
    return {
      hasAttachment: false,
      parsed: false,
      parseStale: false,
      streamTranslation: false,
      layoutTranslation: false,
      figureCount: null,
      tableCount: null,
      formulaCount: null
    };
  }

  class PaperCard {
    static async fromItem(item, options = {}) {
      const attachment = options.attachment || await attachmentFor(item);
      const identity = localIdentity(item, attachment, options.storage);
      const title = field(item, "title");
      const authors = creators(item);
      const card = {
        schemaVersion: 1,
        local: {
          libraryID: identity.libraryID,
          itemID: identity.itemID,
          parentItemID: identity.parentItemID,
          attachmentID: identity.attachmentID,
          itemKey: identity.itemKey,
          attachmentKey: identity.attachmentKey,
          documentID: identity.documentID
        },
        metadata: {
          title,
          authors,
          year: year(field(item, "date")),
          date: field(item, "date"),
          venue: field(item, "publicationTitle"),
          journal: field(item, "journalAbbreviation"),
          publisher: field(item, "publisher"),
          language: field(item, "language")
        },
        identifiers: {
          doi: normalizeDOI(field(item, "DOI")),
          arxiv: normalizeArxiv(item?.arxiv || field(item, "arXiv") || field(item, "arxiv")),
          pmid: text(item?.pmid || field(item, "PMID")),
          isbn: text(field(item, "ISBN")),
          url: field(item, "url")
        },
        summary: { abstract: field(item, "abstractNote") },
        zotero: {
          tags: tags(item),
          collections: collectionIDs(item),
          dateAdded: text(item?.dateAdded),
          dateModified: text(item?.dateModified)
        },
        discovery: {
          topics: [],
          keywords: [],
          concepts: [],
          citationCount: null,
          referenceCount: null,
          openAccess: false,
          bestOALocation: null
        },
        litmtrans: { ...emptyStatus(), hasAttachment: Boolean(attachment) },
        provenance: { metadataSources: ["zotero"], lastUpdated: new Date().toISOString() }
      };
      if (typeof options.statusForAttachment === "function" && attachment) {
        try {
          const status = await options.statusForAttachment(attachment);
          card.litmtrans = { ...card.litmtrans, ...status, hasAttachment: true };
          if (status?.provenance) card.provenance.metadataSources.push("litmtrans");
        }
        catch (_) {}
      }
      if (typeof options.enrich === "function") {
        try {
          const enriched = await options.enrich(card);
          PaperCard.mergeEnrichment(card, enriched);
        }
        catch (_) {}
      }
      return card;
    }

    static mergeEnrichment(card, enrichment = {}) {
      const discovery = enrichment.discovery || enrichment;
      for (const key of ["topics", "keywords", "concepts", "citationCount", "referenceCount", "openAccess", "bestOALocation"]) {
        if (discovery[key] !== undefined && discovery[key] !== null) card.discovery[key] = discovery[key];
      }
      if (Array.isArray(enrichment.metadataSources)) card.provenance.metadataSources = [...new Set([...card.provenance.metadataSources, ...enrichment.metadataSources.map(text).filter(Boolean)])];
      card.provenance.lastUpdated = new Date().toISOString();
      return card;
    }

    static identity(card) {
      const ids = card?.identifiers || {};
      return normalizeDOI(ids.doi) || normalizeArxiv(ids.arxiv) || text(ids.pmid).toLowerCase() || text(card?.candidateID).toLowerCase() || text(card?.local?.documentID) || normalizeTitle(card?.metadata?.title);
    }

    static indexText(card) {
      const metadata = card?.metadata || {};
      const ids = card?.identifiers || {};
      const discovery = card?.discovery || {};
      return [
        metadata.title,
        (metadata.authors || []).map(row => row.name || row).join(" "),
        metadata.venue, metadata.journal, metadata.publisher,
        card?.summary?.abstract,
        (card?.zotero?.tags || []).join(" "),
        (discovery.topics || []).join(" "),
        (discovery.keywords || []).join(" "),
        (discovery.concepts || []).join(" "),
        ids.doi, ids.arxiv, ids.pmid, ids.isbn, ids.url
      ].filter(Boolean).join(" ");
    }
  }

  Agent.PaperCard = PaperCard;
  Agent.PaperCardHelpers = { text, normalizeDOI, normalizeArxiv, normalizeTitle, year, field, creators, tags, collectionIDs, attachmentFor };
})(this);
