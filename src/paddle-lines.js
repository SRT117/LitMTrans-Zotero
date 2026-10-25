(function (global) {
  "use strict";
  const L = global.LitMTrans = global.LitMTrans || {};
  const U = L.Utils;
  const VERSION = 1;
  const TEXT_TYPES = new Set(["text", "ref_text", "title", "image_caption", "table_caption", "page_footnote"]);
  const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const validBox = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && area(b) > 0;
  const median = (values, fallback = 0) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const i = Math.floor(sorted.length / 2);
    return sorted.length ? (sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2) : fallback;
  };
  const union = boxes => [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
  const normalizedText = text => String(text || "").replace(/<[^>]*>/g, "")
    .replace(/\\+[A-Za-z]+/g, "").toLowerCase().replace(/[^a-z\u3400-\u9fff]/g, "");
  const blockText = block => (block.lines || []).map(line => (line.spans || []).map(span => span.content || "").join("")).join(" ");

  function textCoverage(source, extracted) {
    const a = normalizedText(source), b = normalizedText(extracted);
    if (!a) return 1;
    if (!b) return 0;
    if (a.length < 8) return b.includes(a) ? 1 : 0;
    const pairs = new Map();
    for (let i = 1; i < b.length; i++) { const key = b.slice(i - 1, i + 1); pairs.set(key, (pairs.get(key) || 0) + 1); }
    let hits = 0;
    for (let i = 1; i < a.length; i++) {
      const key = a.slice(i - 1, i + 1), count = pairs.get(key) || 0;
      if (count) { hits++; pairs.set(key, count - 1); }
    }
    return hits / (a.length - 1);
  }

  function pageBlocks(page) {
    const output = [];
    const visit = blocks => {
      for (const block of blocks || []) {
        if (TEXT_TYPES.has(block.type) && block.parser?.id && validBox(block.bbox)) output.push(block);
        if (!["image", "table", "chart"].includes(block.type)) visit(block.blocks);
      }
    };
    visit(page.preproc_blocks);
    return output;
  }

  function assignItems(items, blocks) {
    const result = new Map(blocks.map(block => [block.parser.id, []]));
    for (const item of items) {
      if (!validBox(item.bbox)) continue;
      const box = item.bbox, cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      let winner = null, best = 0;
      for (const block of blocks) {
        const b = block.bbox;
        if (cx < b[0] || cx > b[2] || cy < b[1] || cy > b[3]) continue;
        const overlap = Math.max(0, Math.min(box[2], b[2]) - Math.max(box[0], b[0]))
          * Math.max(0, Math.min(box[3], b[3]) - Math.max(box[1], b[1])) / area(box);
        if (overlap > best) { winner = block; best = overlap; }
      }
      if (winner && best >= .5) result.get(winner.parser.id).push(item);
    }
    return result;
  }

  function groupLines(items) {
    // 用正文词语建立行基线，积分上下限和孤立公式符号只附着到已有行。
    const prose = items.filter(item => /[A-Za-z\u3400-\u9fff]{2}/.test(String(item.text || "")));
    if (!prose.length) return [];
    const height = median(prose.map(item => item.size), 10);
    const width = Math.max(...prose.map(item => item.bbox[2] - item.bbox[0]));
    const anchors = items.filter(item => prose.includes(item) || (item.size >= height * .75
      && (/^\s*[([]?\d{4}[).,\]]*\s*$/.test(String(item.text || ""))
        || (String(item.text || "").replace(/\s/g, "").length >= 10 && item.bbox[2] - item.bbox[0] >= width * .40))));
    const rows = [];
    for (const item of [...anchors].sort((a, b) => a.baseline - b.baseline || a.bbox[0] - b.bbox[0])) {
      const row = rows.find(row => Math.abs(row.baseline - item.baseline) <= Math.max(2, height * .30));
      if (row) row.anchors.push(item);
      else rows.push({ baseline: item.baseline, anchors: [item], items: [] });
    }
    for (const item of items) {
      const row = rows.reduce((best, row) => !best || Math.abs(row.baseline - item.baseline) < Math.abs(best.baseline - item.baseline) ? row : best, null);
      if (Math.abs(row.baseline - item.baseline) <= height * 1.05) row.items.push(item);
    }
    return rows.map(row => {
      const source = union(row.anchors.map(item => item.bbox));
      const bounds = union((row.items.length ? row.items : row.anchors).map(item => item.bbox));
      return { bbox: [bounds[0], source[1], bounds[2], source[3]], baseline: row.baseline,
        text: row.items.sort((a, b) => a.bbox[0] - b.bbox[0]).map(item => item.text).join(" ") };
    }).sort((a, b) => a.baseline - b.baseline);
  }

  function localItems(content, viewport, width, height, transform) {
    const sx = width / viewport.width, sy = height / viewport.height;
    return (content.items || []).filter(item => String(item.str || "").trim() && item.transform).map(item => {
      const tx = transform(viewport.transform, item.transform);
      const size = Math.hypot(tx[2], tx[3]) * sy;
      const baseline = tx[5] * sy, top = baseline - size * (content.styles?.[item.fontName]?.ascent ?? .8);
      return { text: item.str, baseline, size, bbox: [tx[4] * sx, top, (tx[4] + item.width) * sx, top + size] };
    }).filter(item => item.size > 0 && validBox(item.bbox));
  }

  function ocrItems(result, info, page) {
    const raw = result?.prunedResult;
    if (!Array.isArray(raw?.dt_polys) || !Array.isArray(raw.rec_texts) || !Array.isArray(raw.rec_polys)
      || raw.rec_texts.length !== raw.rec_polys.length || !(info?.width > 0 && info?.height > 0)) {
      throw new Error("Paddle文字OCR缺少有效行坐标");
    }
    const [width, height] = page.page_size;
    if (Math.abs(info.width / info.height / (width / height) - 1) > .025) throw new Error("Paddle文字OCR页面尺寸不匹配");
    return raw.rec_polys.map((poly, i) => {
      if (!Array.isArray(poly) || poly.length < 4 || !poly.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return null;
      const box = [Math.min(...poly.map(p => p[0])) * width / info.width, Math.min(...poly.map(p => p[1])) * height / info.height,
        Math.max(...poly.map(p => p[0])) * width / info.width, Math.max(...poly.map(p => p[1])) * height / info.height];
      return { text: raw.rec_texts[i], bbox: box, baseline: box[3], size: box[3] - box[1] };
    }).filter(item => item && validBox(item.bbox));
  }

  function pageGeometry(page, items, source, onlyIDs = null) {
    const blocks = pageBlocks(page), assigned = assignItems(items, blocks), output = {};
    for (const block of blocks) {
      const id = block.parser.id;
      if (onlyIDs && !onlyIDs.has(id)) continue;
      const hits = assigned.get(id), lines = groupLines(hits);
      const coverage = textCoverage(blockText(block), hits.map(item => item.text).join(" "));
      if (lines.length && coverage >= .60) {
        output[id] = { source, lines: lines.map(line => line.bbox), coverage };
        if (source === "pdf-text" && block.type === "ref_text") {
          const markers = hits.filter(item => /^\s*[\[(]?([1-9]\d{0,2})[\]).]?\s*$/.test(item.text)
            && item.bbox[0] <= block.bbox[0] + Math.min(14, (block.bbox[2] - block.bbox[0]) * .12)
            && item.bbox[1] <= lines[0].bbox[1] + 2);
          if (markers.length === 1) output[id].referenceNumber = Number(markers[0].text.match(/\d+/)[0]);
        }
      }
    }
    return output;
  }

  function applyGeometry(pages, geometry) {
    if (!geometry?.pages) return;
    for (let i = 0; i < pages.length; i++) {
      const boxes = [];
      for (const block of pageBlocks(pages[i])) {
        const value = geometry.pages[i]?.blocks?.[block.parser.id];
        if (!Array.isArray(value?.lines) || !value.lines.length || !value.lines.every(validBox)) continue;
        block._layout_original_line_count = value.lines.length;
        block._layout_debug_lines = value.lines.map(bbox => ({ bbox }));
        block._layout_line_source = value.source;
        boxes.push(...value.lines);
      }
      if (boxes.length) pages[i]._layoutLineBoxes = boxes;
    }
  }

  function lineSummary(geometry) {
    let local = 0, ocr = 0;
    for (const page of geometry.pages || []) {
      for (const block of Object.values(page.blocks || {})) {
        if (block.source === "pdf-text") local += block.lines.length;
        else if (block.source === "paddle-ocr") ocr += block.lines.length;
      }
    }
    return `本地提取 ${local} 行，OCR 补充 ${ocr} 行`;
  }

  class PaddleLineService {
    constructor(storage, paddle, renderer) {
      this.storage = storage;
      this.paddle = paddle;
      this.renderer = renderer;
      this.active = new Map();
    }

    async ensure(documentID, layout, signal = null, emit = null, options = {}) {
      const meta = await this.storage.getDocumentMeta(documentID);
      if (meta?.parseProvider !== "paddle" || !meta.sourcePath || layout.payload?.parser_schema !== "litmtrans-document-v1") return null;
      const stat = await this.storage.stat(meta.sourcePath);
      if (!stat) return null;
      const key = U.hashString(JSON.stringify([VERSION, meta.parseRevisionID, meta.sourceIdentity, meta.sourcePath,
        stat.size, stat.lastModified, U.hashString(layout.rawText)]));
      const cachePath = this.storage.path(documentID, "line-geometry.v1.json");
      const cached = await this.storage.readJSON(cachePath, null);
      if (!options.forceOCR && cached?.version === VERSION && cached.key === key && cached.complete && cached.pages?.length === layout.pages.length
        && cached.textMatchVersion === 1
        && cached.documentTextPolicy === 1
        && (cached.referenceNumbersVersion === 1 || !layout.pages.some(page => pageBlocks(page).some(block => block.type === "ref_text")))) {
        return cached;
      }
      const activeKey = `${documentID}:${key}:${options.forceOCR ? "manual" : "auto"}`;
      if (this.active.has(activeKey)) {
        const result = await this.active.get(activeKey);
        U.throwIfAborted(signal);
        return result;
      }
      const run = this.collect(documentID, meta, stat, layout, key, cachePath, cached?.key === key ? cached : null, signal, emit, options);
      this.active.set(activeKey, run);
      try { return await run; }
      finally { this.active.delete(activeKey); }
    }

    async collect(documentID, meta, sourceStat, layout, key, cachePath, cached, signal, emit, options = {}) {
      emit?.({ type: "progress", phase: "paddle-lines-local", message: `正在从 PDF 本地提取行信息，共 ${layout.pages.length} 页`, progress: null });
      const failures = [];
      const lib = this.renderer.loadOwnPDFJS(failures);
      if (!lib) throw new Error(`无法加载PDF文字提取组件：${failures.join("；")}`);
      const bytes = await this.storage.readBytes(meta.sourcePath);
      const task = lib.getDocument({ data: new global.Uint8Array(bytes), useSystemFonts: true });
      const geometry = { version: VERSION, textMatchVersion: 1, documentTextPolicy: 1, referenceNumbersVersion: 1, key, complete: false, pages: [] };
      const missing = [];
      let textPages = 0, bodyPages = 0, missingTextPages = 0;
      const model = String(U.getPref("paddleOCRModel", "PP-OCRv6"));
      const timings = { localMs: 0, ocrMs: 0 };
      const start = Date.now();
      try {
        const pdf = await task.promise;
        if (pdf.numPages !== layout.pages.length) throw new Error("PDF页数与Paddle解析结果不一致");
        for (let i = 0; i < pdf.numPages; i++) {
          U.throwIfAborted(signal);
          const page = await pdf.getPage(i + 1), viewport = page.getViewport({ scale: 1 });
          const target = layout.pages[i];
          if (Math.abs(viewport.width / viewport.height / (target.page_size[0] / target.page_size[1]) - 1) > .025) throw new Error("PDF页面尺寸与Paddle解析结果不一致");
          const content = await page.getTextContent();
          const items = localItems(content, viewport, ...target.page_size, lib.Util.transform);
          const bodyItems = items.filter(item => (item.bbox[1] + item.bbox[3]) / 2 >= target.page_size[1] * .08
            && (item.bbox[1] + item.bbox[3]) / 2 <= target.page_size[1] * .92);
          const hasText = normalizedText(bodyItems.map(item => item.text).join(" ")).length >= 60 && groupLines(bodyItems).length >= 2;
          const hasBody = pageBlocks(target).some(block => ["text", "ref_text"].includes(block.type) && normalizedText(blockText(block)).length >= 60);
          if (hasText) textPages++;
          if (hasBody) { bodyPages++; if (!hasText) missingTextPages++; }
          const blocks = pageGeometry(target, items, "pdf-text");
          // 复用已完成的云端结果，失败或取消后只补尚未取得行信息的页面。
          for (const [id, value] of Object.entries(cached?.pages?.[i]?.blocks || {})) {
            if (value.source === "paddle-ocr") blocks[id] = { ...value, referenceNumber: blocks[id]?.referenceNumber };
          }
          geometry.pages.push({ blocks });
          const ids = pageBlocks(target).filter(block => !blocks[block.parser.id]
            && ["text", "ref_text"].includes(block.type) && normalizedText(blockText(block)).length >= 60).map(block => block.parser.id);
          if (ids.length) missing.push({ index: i, ids });
          page.cleanup?.();
          emit?.({ type: "progress", phase: "paddle-lines-local", message: `本地行信息提取：${i + 1}/${pdf.numPages} 页`, progress: null });
          if (i % 4 === 3) await U.sleep(0, signal);
        }
      } finally { await task.destroy(); }
      timings.localMs = Date.now() - start;
      geometry.documentText = { kind: textPages ? (missingTextPages ? "mixed" : "digital") : "scanned", textPages, bodyPages, missingTextPages };
      geometry.missingPages = missing.map(page => page.index + 1);
      const requestOCR = missing.length > 0 && (options.forceOCR || !textPages);
      const decision = requestOCR ? `；${missing.length} 页需要 OCR 补充`
        : textPages ? `；已检测到 PDF 文字层，不自动调用 OCR${missingTextPages ? `（${missingTextPages} 页缺少可用文字层，可手动补充）` : ""}` : "；无需调用 OCR";
      emit?.({ type: "log", message: `本地行信息提取完成：${lineSummary(geometry)}，耗时 ${(timings.localMs / 1000).toFixed(1)} 秒${decision}` });
      try {
        if (requestOCR) {
          emit?.({ type: "progress", phase: "paddle-lines", message: `正在调用 ${model} 补充 ${missing.length} 页的行信息`, progress: null });
          const t = Date.now();
          await this.collectOCR(documentID, bytes, layout.pages, geometry, missing, model, signal, emit);
          timings.ocrMs = Date.now() - t;
          geometry.missingPages = missing.filter(page => page.ids.some(id => !geometry.pages[page.index].blocks[id])).map(page => page.index + 1);
          emit?.({ type: "log", message: `${model} 行信息补充完成：${lineSummary(geometry)}，OCR 耗时 ${(timings.ocrMs / 1000).toFixed(1)} 秒` });
        }
        geometry.complete = true;
      } catch (error) {
        if (error.cancelled || signal?.aborted) throw error;
        emit?.({ type: "log", message: "文字行位置补充未完成，暂时保留原排版" });
      }
      U.throwIfAborted(signal);
      const current = await this.storage.getDocumentMeta(documentID);
      const currentStat = await this.storage.stat(meta.sourcePath);
      if (current?.parseRevisionID !== meta.parseRevisionID || current?.sourceIdentity !== meta.sourceIdentity
        || current?.sourcePath !== meta.sourcePath || !currentStat || currentStat.size !== bytes.length
        || JSON.stringify([currentStat.size, currentStat.lastModified]) !== JSON.stringify([sourceStat.size, sourceStat.lastModified])
        || U.hashString(await this.storage.readText(this.storage.path(documentID, "layout.json"), "")) !== U.hashString(layout.rawText)) {
        const error = new Error("解析结果已变化，已停止补充行信息");
        error.cancelled = true;
        throw error;
      }
      geometry.timings = timings;
      geometry.ocrModel = model;
      geometry.generatedAt = new Date().toISOString();
      await this.storage.writeJSON(cachePath, geometry);
      return geometry;
    }

    async collectOCR(documentID, bytes, pages, geometry, missing, model, signal, emit) {
      if (!/^PP-OCRv[0-9][A-Za-z0-9._-]{0,63}$/.test(model) || /\s/.test(model)) throw new Error("文字OCR模型名称无效");
      const token = String(this.paddle.secrets.getPaddleToken() || "").trim();
      if (!token) throw new Error("尚未配置Paddle访问令牌");
      // 每批至多二十页，使用已有pdf-lib复制原页，不添加栅格化组件。
      const pdf = await global.PDFLib.PDFDocument.load(global.Uint8Array.from(bytes), { ignoreEncryption: true });
      for (let offset = 0; offset < missing.length; offset += 20) {
        U.throwIfAborted(signal);
        const batch = missing.slice(offset, offset + 20), subset = await global.PDFLib.PDFDocument.create();
        for (const page of await subset.copyPages(pdf, batch.map(p => p.index))) subset.addPage(page);
        const input = await subset.save();
        const identity = U.hashString(`${geometry.key}|${model}|${batch.map(p => p.index).join(",")}`);
        const taskPath = this.storage.path(documentID, "paddle-line-task.json");
        let task = await this.storage.readJSON(taskPath, null);
        const persist = task => this.storage.writeJSON(taskPath, { ...task, identity, model });
        const batchLabel = `${Math.floor(offset / 20) + 1}/${Math.ceil(missing.length / 20)}`;
        if (task?.identity !== identity || !task.jobID || task.state === "failed") {
          emit?.({ type: "progress", phase: "paddle-lines", message: `正在上传 ${batch.length} 页到 ${model}（第 ${batchLabel} 批）`, progress: null });
          task = await this.paddle.submit(input, model, token, signal,
            { useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false, visualize: false });
          await persist(task);
        }
        const waitingSince = Date.now();
        emit?.({ type: "log", message: `${model} 行识别任务：${task.jobID}（第 ${batchLabel} 批，共 ${batch.length} 页）` });
        const url = await this.paddle.poll(task, token, persist, { timeoutSeconds: 600 }, event => {
          if (event.type === "progress") {
            const status = String(event.message || "").startsWith("Paddle解析中：")
              ? event.message.replace("Paddle解析中：", "行识别中：") : "正在等待行识别结果";
            emit?.({ type: "progress", phase: "paddle-lines", progress: null,
              message: `${model} ${status}（第 ${batchLabel} 批，已等待 ${Math.floor((Date.now() - waitingSince) / 1000)} 秒）` });
          }
        }, signal);
        emit?.({ type: "progress", phase: "paddle-lines", message: `正在下载并匹配 ${model} 行信息（第 ${batchLabel} 批）`, progress: null });
        if (new URL(url).protocol !== "https:") throw new Error("Paddle文字OCR结果链接无效");
        const raw = new TextDecoder().decode(await L.HTTP.requestBytes(url, { signal, timeout: 90000, maxBytes: 32 * 1024 * 1024 }));
        const records = raw.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
        const results = records.flatMap(record => {
          if (record.errorCode != null && record.errorCode !== 0) throw new Error("Paddle文字OCR页面识别失败");
          if (!Array.isArray(record.result?.ocrResults)) throw new Error("Paddle文字OCR返回结构不兼容");
          return record.result.ocrResults.map((result, i) => ({ result, info: record.result.dataInfo?.pages?.[i] }));
        });
        if (results.length !== batch.length) throw new Error("Paddle文字OCR返回页数不完整");
        for (let i = 0; i < batch.length; i++) {
          const target = batch[i];
          Object.assign(geometry.pages[target.index].blocks, pageGeometry(pages[target.index],
            ocrItems(results[i].result, results[i].info, pages[target.index]), "paddle-ocr", new Set(target.ids)));
        }
      }
    }
  }
  L.PaddleLineService = PaddleLineService;
  L.PaddleLineHelpers = { pageBlocks, groupLines, localItems, ocrItems, pageGeometry, applyGeometry, textCoverage };
})(this);
