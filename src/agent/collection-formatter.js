(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function id(collection) { return Number(collection?.id || collection?.collectionID || 0) || 0; }
  function parentID(collection) { return Number(collection?.parentID || 0) || 0; }
  function name(collection) { return String(collection?.name || collection?.getName?.() || ""); }

  function resolveParent(collection, byID = null) {
    const wanted = parentID(collection);
    if (wanted && byID?.get(wanted)) return byID.get(wanted);
    const key = String(collection?.parentKey || "");
    if (!key) return null;
    try { return global.Zotero?.Collections?.getByLibraryAndKey?.(Number(collection.libraryID || 0), key) || null; }
    catch (_) { return null; }
  }

  function getCollectionPath(collection, byID = null) {
    const parts = [];
    const seen = new Set();
    let current = collection;
    while (current && !seen.has(id(current))) {
      seen.add(id(current));
      if (name(current)) parts.unshift(name(current));
      current = resolveParent(current, byID);
    }
    return parts.join(" > ");
  }

  function getCollectionDepth(collection, byID = null) {
    let depth = 0;
    const seen = new Set();
    let current = collection;
    while (current && !seen.has(id(current))) {
      seen.add(id(current));
      current = resolveParent(current, byID);
      if (current) depth += 1;
    }
    return depth;
  }

  function relations(collection) {
    try { return collection?.getRelations?.() || {}; }
    catch (_) { return {}; }
  }

  function formatCollectionBrief(collection, byID = null) {
    if (!collection) return null;
    return {
      id: id(collection),
      collectionID: id(collection),
      key: String(collection.key || ""),
      libraryID: Number(collection.libraryID || 0) || 0,
      name: name(collection),
      path: getCollectionPath(collection, byID),
      depth: getCollectionDepth(collection, byID),
      parentID: parentID(collection) || null,
      parentCollection: String(collection.parentKey || "") || null
    };
  }

  function formatCollection(collection, byID = null) {
    const brief = formatCollectionBrief(collection, byID);
    if (!brief) return null;
    return { ...brief, version: Number(collection.version || 0) || 0, relations: relations(collection) };
  }

  function childCollections(collection) {
    let rows = [];
    try { rows = collection?.getChildCollections?.(true) || []; }
    catch (_) { rows = []; }
    if (!Array.isArray(rows)) rows = Object.values(rows || {});
    return rows.map(value => typeof value === "number" ? global.Zotero?.Collections?.get?.(value) : value).filter(Boolean);
  }

  function formatCollectionTree(collection, byID = null) {
    const formatted = formatCollectionBrief(collection, byID);
    if (!formatted) return null;
    formatted.subcollections = childCollections(collection).map(row => formatCollectionTree(row, byID));
    return formatted;
  }

  async function formatCollectionDetails(collection, options = {}, byID = null) {
    const details = formatCollection(collection, byID);
    if (!details) return null;
    const itemIDs = (() => { try { return collection.getChildItems?.(true) || []; } catch (_) { return []; } })();
    const children = childCollections(collection);
    const response = { ...details, meta: { numItems: itemIDs.length, numCollections: children.length } };
    if (options.includeItems) {
      const ids = itemIDs.slice(0, Math.max(0, Number(options.itemsLimit || itemIDs.length)));
      const items = ids.map(value => typeof value === "number" ? global.Zotero?.Items?.get?.(value) : value).filter(Boolean);
      response.items = await Agent.ItemFormatter.formatItems(items, options);
    }
    if (options.includeSubcollections) response.subcollections = children.map(row => formatCollectionBrief(row, byID));
    return response;
  }

  Agent.CollectionFormatter = { id, parentID, getCollectionPath, getCollectionDepth, formatCollectionBrief, formatCollection, formatCollectionTree, formatCollectionDetails, childCollections };
})(this);
