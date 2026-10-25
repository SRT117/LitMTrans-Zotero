(function (global) {
  "use strict";

  const L = global.LitMTrans = global.LitMTrans || {};
  const SCHEMA = "litmtrans-document-v1";

  function assetKey(value) {
    let key = String(value || "").replace(/\\/g, "/");
    try { key = decodeURIComponent(key); } catch (_) {}
    return key.replace(/^\.\//, "").split(/[?#]/)[0].toLowerCase();
  }

  function mathTokens(value) {
    const text = String(value || "");
    const tokens = [];
    let start = 0;
    let index = 0;
    const escaped = offset => {
      let slashes = 0;
      while (offset > 0 && text[--offset] === "\\") slashes++;
      return slashes % 2 === 1;
    };
    while (index < text.length) {
      if (text[index] === "`") {
        const marker = text.slice(index).match(/^`+/)[0];
        const end = text.indexOf(marker, index + marker.length);
        index = end < 0 ? text.length : end + marker.length;
        continue;
      }
      let open = "";
      let close = "";
      if (!escaped(index)) {
        if (text.startsWith("\\(", index)) { open = "\\("; close = "\\)"; }
        else if (text.startsWith("\\[", index)) { open = "\\["; close = "\\]"; }
        else if (text.startsWith("$$", index)) open = close = "$$";
        else if (text[index] === "$") open = close = "$";
      }
      if (!open) { index++; continue; }
      let end = text.indexOf(close, index + open.length);
      while (end >= 0 && escaped(end)) end = text.indexOf(close, end + close.length);
      const tex = end < 0 ? "" : text.slice(index + open.length, end).trim();
      if (!tex || (open === "$" && tex.includes("\n"))) { index += open.length; continue; }
      if (index > start) tokens.push({ kind: "text", text: text.slice(start, index) });
      tokens.push({ kind: "math", text: text.slice(index, end + close.length), tex, display: open === "$$" || open === "\\[" });
      index = start = end + close.length;
    }
    if (start < text.length) tokens.push({ kind: "text", text: text.slice(start) });
    return tokens;
  }

  function stripMath(value) {
    const tokens = mathTokens(String(value || "").trim());
    return tokens.length === 1 && tokens[0].kind === "math" ? tokens[0].tex : String(value || "").trim();
  }

  function estimatedLines(block) {
    const width = block.bbox[2] - block.bbox[0];
    const height = block.bbox[3] - block.bbox[1];
    const text = String(block.text || "");
    const byText = Math.ceil(text.length / Math.max(10, width / 4.2));
    return Math.max(1, Math.min(Math.max(1, Math.round(height / 9)), byText || 1));
  }

  function projectLayout(document) {
    if (document?.schema !== SCHEMA || !Array.isArray(document.pages) || !document.pages.length) {
      throw new Error("解析结果缺少有效的文档页面");
    }
    const ids = new Set();
    return {
      parser_schema: SCHEMA,
      pdf_info: document.pages.map((page, index) => ({
        page_idx: index,
        page_size: [page.width, page.height],
        parser_schema: SCHEMA,
        preproc_blocks: page.blocks.map(block => {
          if (!block.id || ids.has(block.id)) throw new Error("解析结果出现重复的内容标识");
          ids.add(block.id);
          if (!Array.isArray(block.bbox) || block.bbox.length !== 4 || !block.bbox.every(Number.isFinite)
            || block.bbox[2] <= block.bbox[0] || block.bbox[3] <= block.bbox[1]) throw new Error("解析结果包含无效的位置坐标");
          const metadata = {
            schema: SCHEMA, id: block.id, semanticRole: block.role,
            translatable: block.translatable === true, readingOrder: block.sequence,
            geometryGranularity: "block", source: block.source,
            polygon: block.polygon, estimatedLineCount: estimatedLines(block)
          };
          const spans = (block.tokens || mathTokens(block.text)).map(token => token.kind === "math"
            ? { type: "inline_equation", content: token.tex }
            : { type: "text", content: token.text });
          const projected = {
            type: block.type, bbox: block.bbox, parser: metadata,
            lines: [{ bbox: block.bbox, spans }]
          };
          if (block.role === "formula") projected.lines[0].spans = [{ type: "interline_equation", content: stripMath(block.text) }];
          if (block.asset) {
            const body = { type: block.role === "table" ? "table_body" : "image_body", bbox: block.bbox,
              parser: { ...metadata, id: `${block.id}-asset`, translatable: false },
              image_path: block.asset, lines: [] };
            if (block.role === "table" && /<table[\s>]/i.test(block.text || "")) {
              body.lines = [{ bbox: block.bbox, spans: [{ type: "table", html: block.text }] }];
            }
            projected.lines = [];
            projected.blocks = [body];
          }
          return projected;
        }),
        discarded_blocks: []
      }))
    };
  }

  L.ParserModel = { SCHEMA, assetKey, mathTokens, stripMath, estimatedLines, projectLayout };
})(this);
