(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function safeString(value) { return value === null || value === undefined ? "" : String(value); }

  function getField(item, name) {
    try { return safeString(item?.getField?.(name)); }
    catch (_) { return safeString(item?.[name]); }
  }

  function itemID(item) { return Number(item?.id || item?.itemID || 0) || 0; }

  function creators(item) {
    let rows = [];
    try { rows = item?.getCreators?.() || []; }
    catch (_) { rows = Array.isArray(item?.creators) ? item.creators : []; }
    return (Array.isArray(rows) ? rows : []).map(row => ({
      name: safeString(row?.name) || [row?.firstName, row?.lastName].filter(Boolean).join(" ").trim(),
      firstName: safeString(row?.firstName),
      lastName: safeString(row?.lastName),
      creatorType: safeString(row?.creatorType) || safeString(row?.creatorTypeID)
    })).filter(row => row.name || row.firstName || row.lastName);
  }

  function tags(item) {
    try { return (item?.getTags?.() || []).map(row => safeString(row?.tag || row).trim()).filter(Boolean); }
    catch (_) { return []; }
  }

  function ids(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value);
    return value == null ? [] : [value];
  }

  function attachmentSize(attachment) {
    const direct = Number(attachment?.fileSize || attachment?.size || attachment?.file?.fileSize || 0);
    return Number.isFinite(direct) && direct > 0 ? direct : 0;
  }

  function hasExtractableText(attachment) {
    const type = safeString(attachment?.attachmentContentType).toLowerCase();
    const filename = safeString(attachment?.attachmentFilename).toLowerCase();
    return type.includes("pdf") || type.includes("text") || /\.(pdf|txt|md|html?|xml)$/.test(filename);
  }

  function attachmentRows(item, options = {}) {
    let attachmentIDs = [];
    try { attachmentIDs = ids(item?.getAttachments?.(false)); }
    catch (_) { attachmentIDs = ids(item?.attachments); }
    return attachmentIDs.map(value => typeof value === "number" ? global.Zotero?.Items?.get?.(value) : value)
      .filter(Boolean)
      .map(attachment => ({
        id: itemID(attachment),
        key: safeString(attachment.key),
        linkMode: Number(attachment.attachmentLinkMode || 0) || 0,
        title: getField(attachment, "title"),
        filename: safeString(attachment.attachmentFilename),
        fileName: safeString(attachment.attachmentFilename),
        contentType: safeString(attachment.attachmentContentType),
        url: getField(attachment, "url"),
        hasFulltext: hasExtractableText(attachment),
        size: attachmentSize(attachment),
        ...(options.includePaths === true && options.developer === true ? { path: safeString(attachment.getFilePath?.()) } : {})
      }));
  }

  function noteRows(item) {
    let noteIDs = [];
    try { noteIDs = ids(item?.getNotes?.(false)); }
    catch (_) { noteIDs = []; }
    return noteIDs.map(value => typeof value === "number" ? global.Zotero?.Items?.get?.(value) : value)
      .filter(Boolean)
      .map(note => ({ key: safeString(note.key), id: itemID(note), content: safeString(note.getNote?.() || note.note) }))
      .filter(row => row.content);
  }

  function typeFields(item) {
    try {
      const typeID = Number(item?.itemTypeID || global.Zotero?.ItemTypes?.getID?.(item?.itemType)) || 0;
      return (global.Zotero?.ItemFields?.getItemTypeFields?.(typeID) || [])
        .map(id => safeString(global.Zotero?.ItemFields?.getName?.(id) || global.Zotero?.ItemFields?.getFieldNameFromID?.(id)))
        .filter(Boolean);
    }
    catch (_) { return []; }
  }

  function formatItemBrief(item) {
    return {
      id: itemID(item),
      key: safeString(item?.key),
      title: getField(item, "title") || "No Title",
      creators: creators(item).map(row => row.name).join(", "),
      date: getField(item, "date").match(/\d{4}/)?.[0] || ""
    };
  }

  function formatItem(item, options = {}) {
    if (!item) return null;
    const requested = Array.isArray(options.fields) ? options.fields : null;
    const fields = requested || [...new Set(["title", ...typeFields(item), "creators", "tags", "notes", "attachments"])]
      .filter(name => !/(?:path|fileName|attachmentPath)$/i.test(name) || ["attachments", "fileName"].includes(name));
    const output = {
      id: itemID(item),
      key: safeString(item.key),
      itemType: safeString(item.itemType || item.getItemType?.()),
      libraryID: Number(item.libraryID || 0) || 0,
      zoteroUrl: item.key ? `zotero://select/library/items/${item.key}` : ""
    };
    for (const name of fields) {
      try {
        if (name === "itemType") continue;
        if (name === "creators") output.creators = creators(item);
        else if (name === "tags") output.tags = tags(item);
        else if (name === "attachments") output.attachments = attachmentRows(item, options);
        else if (name === "notes") output.notes = noteRows(item);
        else output[name] = getField(item, name);
      }
      catch (_) { output[name] = ""; }
    }
    if (!Object.prototype.hasOwnProperty.call(output, "title")) output.title = getField(item, "title");
    if (!Object.prototype.hasOwnProperty.call(output, "creators")) output.creators = creators(item);
    return output;
  }

  async function formatItems(items, options = {}) {
    return Promise.all((Array.isArray(items) ? items : []).map(item => formatItem(item, options)));
  }

  Agent.ItemFormatter = { safeString, getField, formatItemBrief, formatItem, formatItems, attachmentRows, noteRows, creators, tags };
})(this);
