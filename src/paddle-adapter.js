(function (global) {
  "use strict";

  const L = global.LitMTrans = global.LitMTrans || {};
  const P = L.ParserModel;
  const ROLES = {
    doc_title: ["document_title", "title", true], paragraph_title: ["section_title", "title", true],
    abstract: ["abstract", "text", true], text: ["body", "text", true],
    reference_content: ["reference", "ref_text", false], reference: ["reference", "ref_text", false],
    display_formula: ["formula", "interline_equation", false], formula: ["formula", "interline_equation", false],
    formula_number: ["formula_number", "formula_number", false],
    image: ["image", "image", false], chart: ["image", "image", false], table: ["table", "table", false],
    figure_title: ["caption", "image_caption", true], table_title: ["table_caption", "table_caption", true],
    header: ["header", "header", false], footer: ["footer", "footer", false],
    number: ["page_number", "page_number", false], footnote: ["footnote", "page_footnote", false],
    header_image: ["header_image", "image", false], footer_image: ["footer_image", "image", false]
  };

  function decodeResults(text) {
    let records;
    try { records = [JSON.parse(String(text).replace(/^\uFEFF/, ""))]; }
    catch (_) {
      try { records = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
      catch (_) { throw new Error("Paddle结果文件不是完整的JSON或JSONL"); }
    }
    const pages = [];
    for (const record of records) {
      if (record?.errorCode != null && record.errorCode !== 0) throw new Error("Paddle页面识别失败");
      const result = record?.result;
      if (!Array.isArray(result?.layoutParsingResults)) throw new Error("Paddle返回了尚不支持的结果结构");
      pages.push(...result.layoutParsingResults);
    }
    if (!pages.length) throw new Error("Paddle未返回页面布局");
    return pages;
  }

  function normalize(pages, sizes, options = {}) {
    if (pages.length !== sizes.length) throw new Error(`Paddle返回 ${pages.length} 页，原文件为 ${sizes.length} 页，结果尚不完整`);
    let contentCount = 0;
    const normalized = pages.map((page, index) => {
      const raw = page?.prunedResult;
      const width = Number(raw?.width), height = Number(raw?.height);
      const target = sizes[index];
      if (!(width > 0 && height > 0 && target?.width > 0 && target?.height > 0) || !Array.isArray(raw?.parsing_res_list)) {
        throw new Error(`Paddle第 ${index + 1} 页缺少有效布局`);
      }
      if (Math.abs(width / height / (target.width / target.height) - 1) > .025) {
        throw new Error(`Paddle第 ${index + 1} 页尺寸与原PDF不一致，无法安全对齐`);
      }
      const angle = Number(raw.doc_preprocessor_res?.angle || 0);
      if ([90, 180, 270].includes(((angle % 360) + 360) % 360)) throw new Error("Paddle改变了页面方向，当前结果无法与原PDF对齐");
      const scaleBox = box => {
        if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) throw new Error(`Paddle第 ${index + 1} 页坐标无效`);
        return box.map((n, i) => n * (i % 2 ? target.height / height : target.width / width));
      };
      const blocks = raw.parsing_res_list.map((block, sequence) => {
        const label = String(block.block_label || "unknown");
        const [role, type, translatable] = ROLES[label] || ["unknown", "unknown", false];
        const text = String(block.block_content || "");
        if (text.trim() || ["image", "table"].includes(role)) contentCount++;
        return {
          id: `p${String(index + 1).padStart(3, "0")}-s${String(sequence + 1).padStart(4, "0")}`,
          role, type, translatable, text, tokens: P.mathTokens(text), sequence,
          bbox: scaleBox(block.block_bbox),
          polygon: Array.isArray(block.block_polygon_points) ? block.block_polygon_points.map(point => [point[0] * target.width / width, point[1] * target.height / height]) : null,
          source: { provider: "paddle", label, blockID: block.block_id ?? sequence,
            readingOrder: block.block_order ?? null, groupID: block.group_id ?? null,
            bbox: block.block_bbox, rawRef: `parser-source/paddle/pages.json#/pages/${index}/prunedResult/parsing_res_list/${sequence}` }
        };
      });
      // 标题归属只在同栏、近邻且唯一的表格上成立，歧义时保留通用标题。
      for (const caption of blocks.filter(block => block.role === "caption")) {
        const matches = blocks.filter(block => block.role === "table"
          && block.bbox[1] >= caption.bbox[3] - 2 && block.bbox[1] - caption.bbox[3] < 20
          && Math.abs(block.bbox[0] - caption.bbox[0]) < 20);
        if (matches.length === 1) {
          caption.role = "table_caption";
          caption.type = "table_caption";
          caption.targetID = matches[0].id;
        }
      }
      return { index, width: target.width, height: target.height, rasterWidth: width, rasterHeight: height, blocks };
    });
    if (!contentCount) throw new Error("Paddle未返回可用的文献内容");
    return { schema: P.SCHEMA, provider: "paddle", model: options.model || "PaddleOCR-VL-1.6",
      apiProtocol: "aistudio-jobs-v2", resultSchema: "paddle-layout-blocks-v1", adapterVersion: 1,
      capabilities: { geometry: "block", readingOrder: true, nativePolygons: normalized.some(page => page.blocks.some(block => Array.isArray(block.polygon))) }, pages: normalized };
  }

  L.PaddleAdapter = { decodeResults, normalize };
})(this);
