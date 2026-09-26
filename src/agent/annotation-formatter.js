(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function text(value) { return value === null || value === undefined ? "" : String(value); }
  function field(item, name) {
    try { return text(item?.getField?.(name) ?? item?.[name]); }
    catch (_) { return text(item?.[name]); }
  }
  function tags(item) {
    try { return (item?.getTags?.() || []).map(row => text(row?.tag || row).trim()).filter(Boolean); }
    catch (_) { return []; }
  }
  function parsePosition(value) {
    if (!value) return null;
    if (typeof value === "object") return value;
    try { return JSON.parse(String(value)); }
    catch (_) { return String(value); }
  }
  function pageNumber(value) {
    const parsed = Number.parseInt(text(value), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  function annotationType(value) {
    const type = text(value).toLowerCase();
    return ({ highlight: "highlight", note: "text", image: "image", ink: "ink", text: "text" })[type] || "annotation";
  }

  function normalize(item, options = {}) {
    if (!item) return null;
    const isNote = String(item?.itemType || item?.getItemType?.() || "") === "note" || item?.isNote?.();
    if (isNote) {
      const content = text(item.getNote?.() || item.note);
      const parent = options.parent || item.parentItem || null;
      const row = {
        id: text(item.key || item.id || item.itemID), itemKey: text(item.key), parentKey: text(options.parentKey || parent?.key || item.parentKey),
        type: "note", rawType: "note", content, text: content, comment: "", color: "", tags: tags(item),
        dateAdded: text(item.dateAdded), dateModified: text(item.dateModified), attachmentKey: text(options.attachmentKey || parent?.key || item.parentKey)
      };
      if (options.documentID) row.documentID = text(options.documentID);
      if (options.litmtrans) row.litmtrans = options.litmtrans;
      if (options.documentID || options.attachmentKey) row.locator = { documentID: text(options.documentID), attachmentKey: row.attachmentKey, page: null, position: null };
      return row;
    }
    const rawType = field(item, "annotationType") || text(item.annotationType);
    const annotationText = field(item, "annotationText") || text(item.annotationText);
    const comment = field(item, "annotationComment") || text(item.annotationComment);
    const position = parsePosition(field(item, "annotationPosition") || item.annotationPosition);
    const parent = options.parent || item.parentItem || null;
    const pageLabel = field(item, "annotationPageLabel") || text(item.annotationPageLabel);
    const page = pageNumber(pageLabel);
    const row = {
      id: text(item.key || item.id || item.itemID),
      itemKey: text(item.key),
      parentKey: text(options.parentKey || parent?.key || item.parentKey),
      type: annotationType(rawType),
      rawType,
      content: comment || annotationText,
      text: annotationText,
      comment,
      color: field(item, "annotationColor") || text(item.annotationColor),
      tags: tags(item),
      dateAdded: text(item.dateAdded),
      dateModified: text(item.dateModified),
      page,
      pageLabel,
      position,
      sortIndex: Number(field(item, "annotationSortIndex") || item.annotationSortIndex || 0) || 0,
      attachmentKey: text(options.attachmentKey || parent?.key || item.parentKey)
    };
    if (options.documentID) row.documentID = text(options.documentID);
    if (options.litmtrans) row.litmtrans = options.litmtrans;
    if (options.documentID || options.attachmentKey) {
      row.locator = { documentID: text(options.documentID), attachmentKey: row.attachmentKey, page: page ?? null, position };
    }
    return row;
  }

  function values(value) { return Array.isArray(value) ? value.map(text) : value == null ? [] : [text(value)]; }

  function matches(row, options = {}) {
    const q = text(options.q || options.query).trim().toLocaleLowerCase();
    if (q && ![row.content, row.text, row.comment, row.itemKey, row.parentKey, row.tags.join(" ")].join(" ").toLocaleLowerCase().includes(q)) return false;
    const types = values(options.type).filter(Boolean);
    if (types.length && !types.includes(row.type) && !types.includes(row.rawType)) return false;
    const wantedTags = values(options.tags).filter(Boolean).map(value => value.toLocaleLowerCase());
    if (wantedTags.length && !wantedTags.some(wanted => row.tags.some(tag => tag.toLocaleLowerCase().includes(wanted)))) return false;
    if (options.color && row.color.toLocaleLowerCase() !== text(options.color).toLocaleLowerCase()) return false;
    if (options.hasComment !== undefined && Boolean(options.hasComment) !== Boolean(row.comment.trim())) return false;
    if (options.itemKey && row.parentKey !== text(options.itemKey) && row.itemKey !== text(options.itemKey)) return false;
    if (options.dateFrom && Date.parse(row.dateModified) < Date.parse(text(options.dateFrom))) return false;
    if (options.dateTo && Date.parse(row.dateModified) > Date.parse(text(options.dateTo))) return false;
    if (options.dateRange) {
      const [from, to] = text(options.dateRange).split(",").map(value => value.trim());
      if (from && Date.parse(row.dateModified) < Date.parse(from)) return false;
      if (to && Date.parse(row.dateModified) > Date.parse(to)) return false;
    }
    return true;
  }

  function sort(rows, key = "dateModified", direction = "desc") {
    const multiplier = text(direction).toLowerCase() === "asc" ? 1 : -1;
    const value = row => {
      if (key === "position") return (Number(row.page || 0) * 1000000) + Number(row.sortIndex || 0);
      if (key === "page") return Number(row.page || 0);
      if (key === "type") return row.type;
      if (key === "dateAdded" || key === "dateModified") return Date.parse(row[key]) || 0;
      return text(row[key]);
    };
    return [...rows].sort((left, right) => {
      const a = value(left); const b = value(right);
      if (a === b) return text(left.id).localeCompare(text(right.id));
      return (a < b ? -1 : 1) * multiplier;
    });
  }

  function paginate(rows, options = {}) {
    const offset = Math.max(0, Number(options.offset || 0));
    const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
    const items = rows.slice(offset, offset + limit);
    return { total: rows.length, offset, limit, nextOffset: offset + items.length < rows.length ? offset + items.length : null, annotations: items };
  }

  Agent.AnnotationFormatter = { normalize, matches, sort, paginate, parsePosition, annotationType };
})(this);
