(function (global) {
  "use strict";
  const L = global.LitMTrans = global.LitMTrans || {};
  const U = L.Utils;
  const validBox = box => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1];
  const fingerprint = layout => U.hashString(layout.rawText || "");
  const noTranslation = value => typeof value === "string" && value.trim() === "无需翻译";
  const unchangedImageText = (cell, value) => typeof value === "string" && value.trim() === String(cell?.text || "").trim();
  const validImageText = (cell, value) => noTranslation(value) || L.LayoutTables.validText(cell, value);

  function isPageFurniture(block) {
    const source = block?.original || block;
    const roles = [source?.type, source?.parser?.semanticRole, source?.parser?.source?.label];
    return roles.some(role => ["header", "footer", "header_image", "footer_image", "page_number"].includes(role));
  }

  function extract(layout) {
    const figures = [];
    for (const [page, data] of layout.pages.entries()) {
      const visit = (block, path) => {
        if (isPageFurniture(block)) return;
        if (["table", "table_body"].includes(block.type)) return;
        if (["image_body", "chart_body"].includes(block.type) && validBox(block.bbox)) {
          const asset = block.image_path || (block.lines || []).flatMap(line => line.spans || []).find(span => span.image_path)?.image_path;
          if (asset) figures.push({ id: `image:${page}:${path}`, page, bbox: [...block.bbox], asset });
          return;
        }
        for (const [index, child] of (block.blocks || []).entries()) visit(child, `${path}.${index}`);
      };
      for (const [index, block] of (data.preproc_blocks || []).entries()) visit(block, String(index));
    }
    return figures;
  }

  function quadsOverlap(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
    const axes = [];
    for (const poly of [a, b]) {
      for (let i = 0; i < 2; i++) {
        const dx = poly[i + 1][0] - poly[i][0], dy = poly[i + 1][1] - poly[i][1];
        if (dx || dy) axes.push([-dy, dx]);
      }
    }
    for (const [ax, ay] of axes) {
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of a) { const v = p[0] * ax + p[1] * ay; minA = Math.min(minA, v); maxA = Math.max(maxA, v); }
      for (const p of b) { const v = p[0] * ax + p[1] * ay; minB = Math.min(minB, v); maxB = Math.max(maxB, v); }
      if (maxA <= minB || maxB <= minA) return false;
    }
    return true;
  }

  function itemQuad(item, width = 1, height = 1) {
    if (Array.isArray(item?.poly) && item.poly.length === 4) {
      return item.poly.map(point => [point[0] * width, point[1] * height]);
    }
    const box = Array.isArray(item) ? item : item?.bbox;
    if (!validBox(box)) return null;
    return [[box[0] * width, box[1] * height], [box[2] * width, box[1] * height], [box[2] * width, box[3] * height], [box[0] * width, box[3] * height]];
  }

  function ocrLineFromPolygon(text, score, polygon, width, height, options = {}) {
    const clean = typeof text === "string" ? text.trim() : "";
    const minScore = options.minScore ?? .85;
    if (!clean || !(Number(score) >= minScore) || !(width > 0 && height > 0) || !Array.isArray(polygon)
      || polygon.length !== 4 || polygon.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) return null;
    const norm = value => options.clamp ? Math.max(0, Math.min(1, value)) : value;
    const xs = polygon.map(point => norm(point[0] / width)), ys = polygon.map(point => norm(point[1] / height));
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (!validBox(bbox) || (!options.clamp && bbox.some(value => value < 0 || value > 1))) return null;
    const vx = ((polygon[1][0] - polygon[0][0]) + (polygon[2][0] - polygon[3][0])) / 2;
    const vy = ((polygon[1][1] - polygon[0][1]) + (polygon[2][1] - polygon[3][1])) / 2;
    const len = Math.hypot(vx, vy);
    if (!(len > 0)) return null;
    const tx = vx / len, ty = vy / len, nx = -ty, ny = tx;
    const h1 = Math.abs((polygon[3][0] - polygon[0][0]) * nx + (polygon[3][1] - polygon[0][1]) * ny);
    const h2 = Math.abs((polygon[2][0] - polygon[1][0]) * nx + (polygon[2][1] - polygon[1][1]) * ny);
    const thick = (h1 + h2) / 2;
    const angle = Math.atan2(vy, vx) * 180 / Math.PI;
    const horizontal = Math.abs(angle) <= 6;
    if (options.rotated) {
      if (!horizontal || !(thick > 0) || len < thick * (options.minAspect ?? 1.2)) return null;
      return { text: clean, score: Number(score), bbox: [bbox[1], 1 - bbox[2], bbox[3], 1 - bbox[0]], rotation: -90 };
    }
    const requiredAspect = horizontal ? (options.minAspect || 0) : Math.max(1.2, options.minAspect || 0);
    if (!(thick > 0) || (requiredAspect > 0 && len < thick * requiredAspect)) return null;
    if (horizontal) return { text: clean, score: Number(score), bbox };
    // 倾斜曲线或网格交叉易产生低置信度误检，斜向文本仅保留高置信度识别框。
    if (Number(score) < Math.max(minScore, .8)) return null;
    const poly = polygon.map(point => [Math.max(0, Math.min(1, point[0] / width)), Math.max(0, Math.min(1, point[1] / height))]);
    return { text: clean, score: Number(score), bbox, rotation: Math.round(angle * 100) / 100, poly };
  }

  function linesFromOCR(result, info) {
    const raw = result?.prunedResult;
    if (!(info?.width > 0 && info?.height > 0) || !Array.isArray(raw?.rec_texts)
      || !Array.isArray(raw.rec_polys) || raw.rec_texts.length !== raw.rec_polys.length) return [];
    return raw.rec_texts.flatMap((text, index) => {
      const line = ocrLineFromPolygon(text, raw.rec_scores?.[index], raw.rec_polys[index], info.width, info.height, { minScore: .85 });
      return line ? [line] : [];
    });
  }

  function linesFromMinerU(page) {
    const { width, height } = page?.page_info || {};
    if (!(width > 0 && height > 0) || !Array.isArray(page.layout_dets)) return [];
    // 只接收原始 OCR 行，不把图表理解或整块摘要当作图内文字。
    return page.layout_dets.flatMap(line => {
      if (line.label !== "ocr_text" || typeof line.text !== "string" || !line.text.trim()
        || !(line.score >= .85) || !validBox(line.bbox) || (line.angle && line.angle !== 0)) return [];
      const box = line.bbox;
      // 此接口只有轴对齐框；跳过狭长竖框及多行文本，不猜测旋转方向。
      if (box[2] - box[0] < (box[3] - box[1]) * 1.5 || /[\r\n]/.test(line.text)) return [];
      const bbox = box.map((value, index) => value / (index % 2 ? height : width));
      if (bbox.some(value => value < 0 || value > 1)) return [];
      return [{ text: line.text.trim(), bbox, score: line.score }];
    });
  }

  const MINERU_IMAGE_STRATEGY = "shared-gray-crops-v3";

  function imageOCRProgressEmitter(emit) {
    return event => emit?.({ ...event, phase: "image-ocr-poll", message: String(event.message || "")
      .replace(/^(MinerU|Paddle)解析/, "$1图片文字识别")
      .replace(/^(等待MinerU返回|正在等待Paddle)解析结果/, "$1图片文字识别结果") });
  }

  function planImageOCRSheets(inputs, isolated = false) {
    const sheets = [];
    const cells = inputs.flatMap((input, index) => input.packing.mapping.map(row => ({
      input: index, source: row.source, from: row.packed,
      width: row.packed[2] - row.packed[0], height: row.packed[3] - row.packed[1]
    }))).filter(cell => cell.width > 0 && cell.height > 0 && cell.width <= 664 && cell.height <= 952)
      .sort((a, b) => b.height - a.height || b.width - a.width);
    let sheet, left = 24, top = 24, rowHeight = 0;
    for (const cell of cells) {
      if (isolated === true) {
        sheets.push({ size: [Math.max(200, cell.width + 48), Math.max(100, cell.height + 48)], cells: [{ input: cell.input, source: cell.source, from: cell.from, packed: [24, 24, cell.width + 24, cell.height + 24] }] });
        continue;
      }
      if (isolated === 2) {
        if (!sheet || sheet.cells.length >= 2 || left + cell.width > 688) {
          sheet = { size: [200, 100], cells: [] };sheets.push(sheet);left = 24;
        }
        sheet.cells.push({ input: cell.input, source: cell.source, from: cell.from,
          packed: [left, 24, left + cell.width, 24 + cell.height] });
        sheet.size[0] = Math.max(sheet.size[0], left + cell.width + 24);
        sheet.size[1] = Math.max(sheet.size[1], cell.height + 48);
        left += cell.width + 64;
        continue;
      }
      if (left + cell.width > 688) { left = 24;top += rowHeight + 32;rowHeight = 0; }
      if (!sheet || top + cell.height > 976) {
        sheet = { size: [200, 0], cells: [] };sheets.push(sheet);left = top = 24;rowHeight = 0;
      }
      sheet.cells.push({ input: cell.input, source: cell.source, from: cell.from,
        packed: [left, top, left + cell.width, top + cell.height] });
      sheet.size[0] = Math.max(sheet.size[0], left + cell.width + 24);
      sheet.size[1] = Math.max(sheet.size[1], top + cell.height + 24);
      left += cell.width + 64;rowHeight = Math.max(rowHeight, cell.height);
    }
    return sheets;
  }

  function planPaddleImageSheets(inputs) {
    const sheets = [];
    let sheet = null, left = 32, top = 32, rowHeight = 0;
    for (let index = 0; index < inputs.length; index++) {
      const { width, height } = inputs[index];
      if (!(width > 0 && height > 0)) continue;
      if (width + 64 > 2000 || height + 64 > 2000) {
        sheets.push({ size: [width + 64, height + 64], cells: [{ input: index, box: [32, 32, width + 32, height + 32] }] });
        continue;
      }
      if (left + width > 1968) { left = 32;top += rowHeight + 32;rowHeight = 0; }
      if (!sheet || top + height > 1968) {
        sheet = { size: [0, 0], cells: [] };sheets.push(sheet);left = top = 32;rowHeight = 0;
      }
      sheet.cells.push({ input: index, box: [left, top, left + width, top + height] });
      sheet.size[0] = Math.max(sheet.size[0], left + width + 32);
      sheet.size[1] = Math.max(sheet.size[1], top + height + 32);
      rowHeight = Math.max(rowHeight, height);left += width + 32;
    }
    return sheets;
  }

  function mapPaddleSheetLines(lines, sheet) {
    const mapped = new Map(sheet.cells.map(cell => [cell.input, []]));
    for (const line of lines) {
      const box = line.bbox.map((value, axis) => value * sheet.size[axis % 2]);
      const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      const cells = sheet.cells.filter(({ box: b }) => {
        const overlap = Math.max(0, Math.min(box[2], b[2]) - Math.max(box[0], b[0])) * Math.max(0, Math.min(box[3], b[3]) - Math.max(box[1], b[1]));
        return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3]
          && overlap / ((box[2] - box[0]) * (box[3] - box[1])) >= .8;
      });
      if (cells.length !== 1) continue;
      const cell = cells[0], b = cell.box;
      const normalized = box.map((value, axis) => Math.max(0, Math.min(1, (value - b[axis % 2]) / (b[axis % 2 + 2] - b[axis % 2]))));
      if (validBox(normalized)) mapped.get(cell.input).push({ ...line, bbox: normalized });
    }
    return mapped;
  }

  function imageTextCandidates(pixels, width, height, neutralOnly = false) {
    if (!(width > 0 && height > 0) || width * height > 2400000 || pixels.length !== width * height * 4) return { boxes: [] };
    const size = width * height, ink = new Uint8Array(size), mask = new Uint8Array(size), queue = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      const p = i * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      ink[i] = pixels[p + 3] >= 250 && (neutralOnly === 4 ? Math.min(r, g, b) > 210
        : (!neutralOnly || Math.max(r, g, b) - Math.min(r, g, b) < 45) && r * .299 + g * .587 + b * .114 < 190) ? 1 : 0;
    }
    const components = (input, accept) => {
      for (let start = 0; start < size; start++) {
        if (!input[start]) continue;
        let head = 0, tail = 1, left = width, top = height, right = 0, bottom = 0;
        queue[0] = start; input[start] = 0;
        while (head < tail) {
          const index = queue[head++], x = index % width, y = Math.floor(index / width);
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
            const next = index + dy * width + dx;
            if (input[next]) { input[next] = 0; queue[tail++] = next; }
          }
        }
        accept([left, top, right, bottom], tail, queue);
      }
    };
    // 去掉大图形连通域，只在识别副本中保留小笔画。
    components(ink, (box, count, indices) => {
      if (count < 6 || count > Math.max(180, size * .0025)
        || box[2] - box[0] > width * .15 || box[3] - box[1] > height * .1) return;
      for (let i = 0; i < count; i++) mask[indices[i]] = 1;
    });
    const joined = new Uint8Array(size), radius = Math.max(7, Math.round(width * .01));
    for (let y = 0; y < height; y++) {
      let count = 0;
      for (let x = 0; x < width + radius; x++) {
        if (x < width) count += mask[y * width + x];
        if (x > radius * 2) count -= mask[y * width + x - radius * 2 - 1];
        const center = x - radius;
        if (center >= 0 && center < width && count) {
          joined[y * width + center] = 1;
          if (neutralOnly !== 2 && y) joined[(y - 1) * width + center] = 1;
          if (neutralOnly !== 2 && y + 1 < height) joined[(y + 1) * width + center] = 1;
        }
      }
    }
    const boxes = [];
    components(joined, (_box, count, indices) => {
      let left = width, top = height, right = 0, bottom = 0;
      for (let i = 0; i < count; i++) {
        const index = indices[i];
        if (!mask[index]) continue;
        const x = index % width, y = Math.floor(index / width);
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
      const w = right - left, h = bottom - top;
      if (w < 15 || h < 9 || h > Math.max(70, height * .15) || w < h * 1.5) return;
      const box = [Math.max(0, left - 3), Math.max(0, top - 3), Math.min(width, right + 3), Math.min(height, bottom + 3)];
      let inkCount = 0;
      for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) inkCount += mask[y * width + x];
      // 稀疏网格残片不排入文字页，避免版面检测继续把整页识别成图形。
      if (inkCount / ((box[2] - box[0]) * (box[3] - box[1])) < .12) return;
      boxes.push(box);
    });
    return { boxes: boxes.sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, 80), mask };
  }

  function imageLineOverlap(a, b) {
    const overlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    return overlap / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  }

  function mapPackedImageLines(lines, packing) {
    const mapped = lines.flatMap(line => {
      const box = line.bbox.map((value, i) => value * packing.size[i % 2]);
      const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      const matches = packing.mapping.filter(({ packed: p }) => {
        const overlap = Math.max(0, Math.min(p[2], box[2]) - Math.max(p[0], box[0]))
          * Math.max(0, Math.min(p[3], box[3]) - Math.max(p[1], box[1]));
        return cx >= p[0] && cx <= p[2] && cy >= p[1] && cy <= p[3]
          && overlap / Math.min((p[2] - p[0]) * (p[3] - p[1]), (box[2] - box[0]) * (box[3] - box[1])) >= .7;
      });
      if (matches.length !== 1) return [];
      const { source, packed } = matches[0];
      // 按单行 OCR 框反映射，不把候选中未识别的其他文字一起擦除。
      const mapped = box.map((value, i) => {
        const axis = i % 2, extent = packed[axis + 2] - packed[axis];
        return source[axis] + Math.max(0, Math.min(extent, value - packed[axis])) * (source[axis + 2] - source[axis]) / extent;
      });
      if (!validBox(mapped)) return [];
      return [{ ...line, bbox: mapped.map((value, i) => value / packing.sourceSize[i % 2]) }];
    });
    // 相邻行框重叠时不覆盖，尤其不能擦到旁边保留原文的数值或公式。
    const adjusted = normalizeImageLines(mapped);
    return adjusted.filter((line, index) => !adjusted.some((other, i) => {
      if (i === index || imageLineOverlap(line.bbox, other.bbox) <= .02) return false;
      const vertical = Math.max(0, Math.min(line.bbox[3], other.bbox[3]) - Math.max(line.bbox[1], other.bbox[1]));
      const height = Math.min(line.bbox[3] - line.bbox[1], other.bbox[3] - other.bbox[1]);
      if (/[A-Za-z]{2}/.test(line.text) !== /[A-Za-z]{2}/.test(other.text) && vertical <= height * .25) return false;
      return true;
    }));
  }

  function shrinkQuad(quad, factor = .8) {
    if (!quad) return null;
    const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
    const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
    return quad.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
  }

  function mergeImageLines(original, extra) {
    const lines = [...original];
    for (let line of extra) {
      let replaced = null, replacedIndex = -1;
      if (line.rotation === -90) {
        const duplicate = lines.findIndex(existing => !existing.rotation && (existing.bbox[3] - existing.bbox[1]) > (existing.bbox[2] - existing.bbox[0]) * 1.5
          && imageLineOverlap(line.bbox, existing.bbox) > .5);
        if (duplicate >= 0) { replacedIndex = duplicate; replaced = lines.splice(duplicate, 1)[0]; }
        let box = [...line.bbox];
        for (const existing of lines) {
          if (imageLineOverlap(box, existing.bbox) <= .02) continue;
          const center = (box[0] + box[2]) / 2, otherCenter = (existing.bbox[0] + existing.bbox[2]) / 2;
          if (center < otherCenter && existing.bbox[0] > center) box[2] = Math.min(box[2], existing.bbox[0]);
          else if (center > otherCenter && existing.bbox[2] < center) box[0] = Math.max(box[0], existing.bbox[2]);
          else {
            const middle = (box[1] + box[3]) / 2, otherMiddle = (existing.bbox[1] + existing.bbox[3]) / 2;
            if (middle > otherMiddle && existing.bbox[3] < middle) box[1] = Math.max(box[1], existing.bbox[3]);
            else if (middle < otherMiddle && existing.bbox[1] > middle) box[3] = Math.min(box[3], existing.bbox[1]);
          }
        }
        if (validBox(box) && box[2] - box[0] >= (line.bbox[2] - line.bbox[0]) * .5
          && box[3] - box[1] >= (line.bbox[3] - line.bbox[1]) * .8) line = { ...line, bbox: box };
      }
      const overlaps = lines.some(existing => {
        if (imageLineOverlap(line.bbox, existing.bbox) <= .02) return false;
        if (!line.poly && !existing.poly) return true;
        return quadsOverlap(shrinkQuad(itemQuad(line)), shrinkQuad(itemQuad(existing)));
      });
      if (!overlaps) lines.push(line);
      else if (replaced) lines.splice(replacedIndex, 0, replaced);
    }
    return lines;
  }

  function rotatedImageLines(lines, width, height) {
    return lines.flatMap(line => {
      const w = (line.bbox[2] - line.bbox[0]) * height, h = (line.bbox[3] - line.bbox[1]) * width;
      if (!(w > h * 1.5 || h > w * 1.5)) return [];
      return [{ ...line, bbox: [line.bbox[1], 1 - line.bbox[2], line.bbox[3], 1 - line.bbox[0]], rotation: w > h ? -90 : 0 }];
    });
  }

  function filterRotatedDetections(rows, normalItems, sourceHeight, horizontalOnly = false) {
    const box = points => {
      const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const normalBoxes = horizontalOnly ? null : normalItems.map(item => box(item.poly));
    return rows.map(row => ({ ...row, boxes: row.boxes.filter(({ poly }) => {
      const [left, top, right, bottom] = box(poly);
      if (right - left >= 1.2 * (bottom - top)) return true;
      if (horizontalOnly) return false;
      const mapped = [top, sourceHeight - right, bottom, sourceHeight - left];
      return !normalBoxes.some(other => imageLineOverlap(mapped, other) > .5);
    }) }));
  }

  function isColoredCurveCandidate(line, pixels, width, height) {
    const box = line.bbox;
    if (line.rotation || line.score >= .7 || box[2] - box[0] < .4 || box[3] - box[1] < .12) return false;
    const left = Math.max(0, Math.floor(box[0] * width)), right = Math.min(width, Math.ceil(box[2] * width));
    const top = Math.max(0, Math.floor(box[1] * height)), bottom = Math.min(height, Math.ceil(box[3] * height));
    let colored = 0, dark = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (Math.max(r, g, b) < 180) dark++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 45 && Math.min(r, g, b) < 200) colored++;
    }
    return colored > dark;
  }

  async function recognizeLocalImageText(model, source, rotated, options = {}) {
    const { rotatedHorizontalOnly = false, ...predictOptions } = options;
    const [normal] = await model.predict(source, predictOptions);
    const detector = model.detModel, predict = detector.predict;
    detector.predict = async function (...args) {
      const rows = await predict.apply(this, args);
      return filterRotatedDetections(rows, normal.items, normal.image.height, Boolean(rotatedHorizontalOnly));
    };
    try {
      const [vertical] = await model.predict(rotated, predictOptions);
      return { normal, rotated: vertical };
    } finally {
      detector.predict = predict;
    }
  }

  function mergeAdjacentRotatedWords(lines) {
    const result = lines.map(line => ({ ...line, bbox: [...line.bbox] }));
    for (let i = 0; i < result.length; i++) {
      const first = result[i];
      if (first.rotation !== -90 || !/^[A-Za-z]+$/.test(first.text)) continue;
      const candidate = result.findIndex((other, index) => {
        if (index === i || other.rotation !== -90 || !/^[A-Za-z]+$/.test(other.text)) return false;
        const overlap = Math.max(0, Math.min(first.bbox[2], other.bbox[2]) - Math.max(first.bbox[0], other.bbox[0]));
        const width = Math.min(first.bbox[2] - first.bbox[0], other.bbox[2] - other.bbox[0]);
        const gap = first.bbox[1] - other.bbox[3];
        return overlap >= width * .7 && gap >= -.002 && gap <= width * .6;
      });
      if (candidate < 0) continue;
      const next = result[candidate];
      first.text = `${first.text} ${next.text}`;
      first.bbox = [Math.min(first.bbox[0], next.bbox[0]), next.bbox[1], Math.max(first.bbox[2], next.bbox[2]), first.bbox[3]];
      first.score = Math.min(first.score ?? 1, next.score ?? 1);
      result.splice(candidate, 1);
      if (candidate < i) i--;
    }
    return result;
  }

  function normalizeImageLines(lines, geometry = true) {
    const cleaned = (geometry ? mergeAdjacentRotatedWords(lines) : lines)
      .map(line => ({ ...line, text: line.text.replace(/^(?:[\s|·•─━]+|-{2,}|–{2,}|—+|\.(?=\d+[A-Za-z])|-(?=[A-Za-z]))+/, "") }));
    const candidates = cleaned.map(line => line.text).filter(text => /^[A-Za-z ]{10,}$/.test(text));
    const counts = new Map();
    for (const text of candidates) counts.set(text, (counts.get(text) || 0) + 1);
    const unitGroups = new Map();
    const unitKey = text => text.toLowerCase().replace(/[²³]/g, c => c === "²" ? "2" : "3").replace(/\s+/g, " ").trim();
    for (const line of cleaned) {
      if (!/^[A-Za-z ]{8,}\([^)]*\)$/.test(line.text)) continue;
      const key = unitKey(line.text), group = unitGroups.get(key) || [];
      group.push(line.text); unitGroups.set(key, group);
    }
    const distance = (a, b) => {
      let row = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        row = next;
      }
      return row[b.length];
    };
    return cleaned.map((line, index) => {
      const text = line.text;
      const match = /^[A-Za-z ]{10,}$/.test(text) && [...counts].filter(([candidate, count]) => count >= 2 && count > (counts.get(text) || 0)
        && candidate.slice(-2).toLowerCase() === text.slice(-2).toLowerCase()
        && Math.abs(candidate.length - text.length) <= 2 && distance(candidate.toLowerCase(), text.toLowerCase()) <= 2)
        .sort((a, b) => b[1] - a[1])[0];
      const unit = [...unitGroups].find(([key, group]) => {
        if (group.length < 2 || !/^[A-Za-z ]{8,}\([^)]*\)\d?$/.test(text)) return false;
        const normalized = unitKey(text), parts = normalized.match(/^(.+?)(\([^)]*\))\d?$/), reference = key.match(/^(.+?)(\([^)]*\))$/);
        return parts && reference && parts[2] === reference[2] && parts[1].slice(-2) === reference[1].slice(-2)
          && distance(parts[1], reference[1]) <= 1;
      })
        ?.[1].slice().sort((a, b) => (b.match(/[²³]/g) || []).length - (a.match(/[²³]/g) || []).length)[0];
      let box = [...line.bbox];
      if (geometry && !line.rotation && /[A-Za-z]{2}/.test(text)) for (const [otherIndex, other] of cleaned.entries()) {
        if (index === otherIndex || /[A-Za-z]{2}/.test(other.text) || imageLineOverlap(box, other.bbox) <= .02) continue;
        const overlap = Math.max(0, Math.min(box[2], other.bbox[2]) - Math.max(box[0], other.bbox[0]));
        if (overlap < (box[2] - box[0]) * .5) continue;
        const center = (box[1] + box[3]) / 2, otherCenter = (other.bbox[1] + other.bbox[3]) / 2;
        if (center > otherCenter && other.bbox[3] < center) box[1] = Math.max(box[1], other.bbox[3]);
        else if (center < otherCenter && other.bbox[1] > center) box[3] = Math.min(box[3], other.bbox[1]);
      }
      if (!validBox(box) || box[3] - box[1] < (line.bbox[3] - line.bbox[1]) * .75) box = line.bbox;
      return { ...line, text: unit || (match ? match[0] : text), bbox: box };
    });
  }

  function repairImageLabelBackground(pixels, width, left, top, w, h, accepted, chosen, foreground, background, protectedMask = null) {
    const values = new Float32Array(w * h * 3), holes = [];
    const ink = [[], [], []];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, source = ((top + y) * width + left + x) * 4;
      if (accepted[i]) holes.push(i);
      if (chosen[i]) for (let c = 0; c < 3; c++) ink[c].push(pixels[source + c]);
      for (let c = 0; c < 3; c++) values[i * 3 + c] = accepted[i] ? background[i * 3 + c] : pixels[source + c];
    }
    const inkColor = ink.map(channel => { channel.sort((a, b) => a - b);return channel[Math.floor(channel.length / 2)]; });
    const blocked = new Uint8Array(foreground);
    for (let i = 0; i < w * h; i++) {
      if (accepted[i]) continue;
      if ((protectedMask && protectedMask[i])
        || Math.max(...inkColor.map((value, c) => Math.abs(values[i * 3 + c] - value))) < 38
        || [0, 1, 2].some(c => values[i * 3 + c] < background[i * 3 + c] - 32)) blocked[i] = 1;
    }
    // 从可用背景向笔画内部逐层初始化，避免旧的单列取样污染迭代初值。
    const ready = new Uint8Array(w * h), queue = new Uint32Array(w * h);
    let head = 0, tail = 0;
    for (let i = 0; i < ready.length; i++) if (!accepted[i] && !blocked[i]) { ready[i] = 1;queue[tail++] = i; }
    while (head < tail) {
      const i = queue[head++], x = i % w, y = Math.floor(i / w);
      for (let direction = 0; direction < 4; direction++) {
        const next = direction === 0 ? (x > 0 ? i - 1 : -1) : direction === 1 ? (x + 1 < w ? i + 1 : -1)
          : direction === 2 ? (y > 0 ? i - w : -1) : (y + 1 < h ? i + w : -1);
        if (next < 0 || ready[next] || !accepted[next]) continue;
        ready[next] = 1;queue[tail++] = next;
        for (let c = 0; c < 3; c++) values[next * 3 + c] = values[i * 3 + c];
      }
    }
    // 在原有文字掩膜内求二维调和补色；未遮挡背景固定，其他前景不参与取色。
    for (let pass = 0; pass < 160; pass++) {
      let change = 0;
      for (const i of holes) {
        const x = i % w, y = Math.floor(i / w);
        let red = 0, green = 0, blue = 0, count = 0;
        for (let direction = 0; direction < 4; direction++) {
          const next = direction === 0 ? (x > 0 ? i - 1 : -1) : direction === 1 ? (x + 1 < w ? i + 1 : -1)
            : direction === 2 ? (y > 0 ? i - w : -1) : (y + 1 < h ? i + w : -1);
          if (next < 0 || (!accepted[next] && blocked[next])) continue;
          red += values[next * 3];green += values[next * 3 + 1];blue += values[next * 3 + 2];
          count++;
        }
        if (!count) continue;
        for (let c = 0; c < 3; c++) {
          const value = (c === 0 ? red : c === 1 ? green : blue) / count;
          change = Math.max(change, Math.abs(value - values[i * 3 + c]));
          values[i * 3 + c] = value;
        }
      }
      if (change < .08) break;
    }
    for (const i of holes) for (let c = 0; c < 3; c++) background[i * 3 + c] = values[i * 3 + c];
  }

  function restoreImageLabel(pixels, width, height, box, protectedBoxes = [], sourceText = "", neighborBoxes = [], options = {}) {
    const allowPartialEdge = Boolean(options?.allowPartialEdge);
    if (!validBox(box) || protectedBoxes.some(other => {
      if (!validBox(other) || imageLineOverlap(box, other) <= .02) return false;
      const overlap = Math.max(0, Math.min(box[2], other[2]) - Math.max(box[0], other[0]));
      return overlap >= (box[2] - box[0]) * .5;
    })) return null;
    const expected = (box[3] - box[1]) * height, pad = Math.max(3, Math.ceil(expected * .18));
    const left = Math.max(0, Math.floor(box[0] * width) - pad), top = Math.max(0, Math.floor(box[1] * height) - pad);
    const right = Math.min(width, Math.ceil(box[2] * width) + pad), bottom = Math.min(height, Math.ceil(box[3] * height) + pad);
    const w = right - left, h = bottom - top, size = w * h;
    if (!(w > 0 && h > 0) || size > 400000) return null;
    const median = values => { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]; };
    const sample = (x, y) => {
      const i = (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
      return [pixels[i], pixels[i + 1], pixels[i + 2]];
    };
    const protectedPixel = (x, y) => protectedBoxes.some(b => x >= b[0] * width - 1 && x <= b[2] * width + 1 && y >= b[1] * height - 1 && y <= b[3] * height + 1);
    const neighborPixel = (x, y) => neighborBoxes.some(b => validBox(b) && x >= b[0] * width && x < b[2] * width && y >= b[1] * height && y < b[3] * height);
    const edge = (y, altY) => Array.from({ length: w }, (_, x) => {
      const clean = [], fallback = [], gapLight = [];
      for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 1; dy++) {
        const sx = left + x + dx, sy = y + dy;
        const rgb = sample(sx, sy);
        fallback.push(rgb);
        if (!neighborPixel(sx, sy) && !protectedPixel(sx, sy)) clean.push(rgb);
        if (Math.min(...rgb) >= 215) gapLight.push(rgb);
      }
      if (clean.length < 3 && Number.isFinite(altY)) {
        for (let dx = -3; dx <= 3; dx++) for (let dy = 0; dy <= pad; dy++) {
          const sy = y < altY ? y + 2 + dy : y - 2 - dy;
          const rgb = sample(left + x + dx, sy);
          if (Math.min(...rgb) >= 215) gapLight.push(rgb);
        }
      }
      // 优先过滤邻行文字及暗色线条；若采样整行落入邻框，则回退到边界缝隙中的浅色原生底色。
      const veryLight = clean.filter(rgb => Math.min(...rgb) >= 215);
      const light = veryLight.length >= 3 ? veryLight : clean.filter(rgb => Math.max(...rgb) >= 180);
      const pool = light.length >= 3 ? light : (clean.length ? clean : (gapLight.length >= 3 ? gapLight : fallback));
      return [0, 1, 2].map(channel => median(pool.map(rgb => rgb[channel])));
    });
    const upper = edge(top - 2, top), lower = edge(bottom + 1, bottom);
    const background = new Uint8ClampedArray(size * 3), mask = new Uint8Array(size), chosen = new Uint8Array(size), graphics = new Uint8Array(size), queue = new Uint32Array(size);
    const outer = [[], [], []];
    let sampled = 0;
    for (let y = Math.max(0, top - pad); y < Math.min(height, bottom + pad); y++) for (let x = left; x < right; x++) {
      if ((x >= box[0] * width && x < box[2] * width && y >= box[1] * height && y < box[3] * height)
        || neighborPixel(x, y) || protectedPixel(x, y)) continue;
      sampled++;
      const rgb = sample(x, y);
      if (rgb.every(value => value >= 200)) for (let c = 0; c < 3; c++) outer[c].push(rgb[c]);
    }
    let whiteColor = null;
    if (sampled && outer[0].length >= 30 && outer[0].length / sampled >= .55) {
      const candidate = outer.map(values => median([...values]));
      let matching = 0;
      for (let i = 0; i < outer[0].length; i++) {
        if ([0, 1, 2].every(c => Math.abs(outer[c][i] - candidate[c]) <= 12)) matching++;
      }
      if (matching / outer[0].length >= .85) whiteColor = candidate;
    }
    let neutralInk = 0, coloredInk = 0;
    for (let y = Math.max(0, Math.floor(box[1] * height)); y < Math.min(height, Math.ceil(box[3] * height)); y++) {
      for (let x = Math.max(0, Math.floor(box[0] * width)); x < Math.min(width, Math.ceil(box[2] * width)); x++) {
        const rgb = sample(x, y);
        if (Math.min(...rgb) >= 180) continue;
        if (Math.max(...rgb) - Math.min(...rgb) > 25) coloredInk++;
        else neutralInk++;
      }
    }
    const keepColor = whiteColor && neutralInk > coloredInk;
    const coloredPixel = (x, y) => {
      const rgb = sample(x, y);
      return keepColor && Math.max(...rgb) - Math.min(...rgb) > 25;
    };
    let totalInk = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (pixels[((top + y) * width + left + x) * 4 + 3] < 250) return null;
      const index = y * w + x, rgb = sample(left + x, top + y), t = (y + 1) / (h + 1);
      let difference = 0;
      for (let c = 0; c < 3; c++) { const value = whiteColor ? whiteColor[c] : upper[x][c] * (1 - t) + lower[x][c] * t; background[index * 3 + c] = value; difference = Math.max(difference, Math.abs(rgb[c] - value)); }
      if (difference > 38 && left + x >= box[0] * width && left + x < box[2] * width
        && top + y >= box[1] * height && top + y < box[3] * height
        && !protectedPixel(left + x, top + y) && !neighborPixel(left + x, top + y)
        && !coloredPixel(left + x, top + y)) { mask[index] = 1; totalInk++; }
    }
    if (!totalInk || totalInk / size > .5) return null;
    const foreground = new Uint8Array(mask);
    const components = [], fragments = [];
    for (let start = 0; start < size; start++) {
      if (!mask[start]) continue;
      let head = 0, tail = 1, x0 = w, y0 = h, x1 = 0, y1 = 0;
      queue[0] = start; mask[start] = 0;
      while (head < tail) {
        const i = queue[head++], x = i % w, y = Math.floor(i / w);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
          const next = i + dy * w + dx;
          if (mask[next]) { mask[next] = 0; queue[tail++] = next; }
        }
      }
      const cw = x1 - x0, ch = y1 - y0;
      // 长引线与跨出文字区域的图形保留；只擦除接近字高的小笔画连通域，避免把连写小写单词误判为水平线。
      const graphic = ch > expected * 1.3 || tail > size * .35
        || (cw > Math.max(ch * 3, expected * 1.4) && (ch <= Math.max(4, expected * .25) || (ch < expected * .34 && tail / (cw * ch) > .78)))
        || (ch > cw * 5 && (y0 === 0 || y1 === h));
      if (graphic) { for (let i = 0; i < tail; i++) graphics[queue[i]] = 1;continue; }
      if (tail >= 2 && cw <= expected * .45 && ch <= expected * .45) {
        fragments.push({ box: [x0, y0, x1, y1], indices: queue.slice(0, tail) });
      }
      if (tail < (allowPartialEdge ? 2 : 3) || ch < (allowPartialEdge ? 2 : Math.max(4, expected * .24))) continue;
      components.push([x0, y0, x1, y1]);
      for (let i = 0; i < tail; i++) chosen[queue[i]] = 1;
    }
    const letters = (String(sourceText).match(/[A-Za-z\u3400-\u9fff]/g) || []).length;
    if (components.length < (whiteColor || allowPartialEdge ? 1 : Math.max(1, Math.min(4, Math.floor(letters * .3))))) return null;
    const bounds = [Math.min(...components.map(b => b[0])), Math.min(...components.map(b => b[1])), Math.max(...components.map(b => b[2])), Math.max(...components.map(b => b[3]))];
    for (const fragment of fragments) {
      const b = fragment.box;
      if (b[0] < bounds[0] - 1 || b[2] > bounds[2] + 1 || b[1] < bounds[1] - expected * .4 || b[3] > bounds[3] + expected * .15) continue;
      for (const index of fragment.indices) if (!graphics[index]) chosen[index] = 1;
      components.push(b);
    }
    const accepted = new Uint8Array(chosen);
    // 包含抗锯齿边缘，但不把整块背景或相邻图形扩成擦除区域。
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!chosen[y * w + x]) continue;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h || protectedPixel(left + x + dx, top + y + dy) || neighborPixel(left + x + dx, top + y + dy)) continue;
        if (left + x + dx < box[0] * width || left + x + dx >= box[2] * width
          || top + y + dy < box[1] * height || top + y + dy >= box[3] * height) continue;
        const i = (y + dy) * w + x + dx, rgb = sample(left + x + dx, top + y + dy);
        if (!graphics[i] && !coloredPixel(left + x + dx, top + y + dy)
          && rgb.some((value, channel) => Math.abs(value - background[i * 3 + channel]) > 8)) accepted[i] = 1;
      }
    }
    let x0 = Math.max(0, Math.min(...components.map(b => b[0])) - 3), y0 = Math.max(0, Math.min(...components.map(b => b[1])) - 3);
    let x1 = Math.min(w, Math.max(...components.map(b => b[2])) + 3), y1 = Math.min(h, Math.max(...components.map(b => b[3])) + 3);
    if (x1 <= x0 || y1 <= y0) return null;
    const protectedMask = new Uint8Array(size);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (protectedPixel(left + x, top + y) || neighborPixel(left + x, top + y) || coloredPixel(left + x, top + y)) protectedMask[y * w + x] = 1;
    }
    repairImageLabelBackground(pixels, width, left, top, w, h, accepted, chosen, foreground, background, protectedMask);
    // 均匀浅底图中文字行相邻时，上下边缘可能采到另一行，优先用邻近的均匀原生背景。
    if (whiteColor) {
      const color = whiteColor;
      // 浅色纯底下仅清理文字连通域外框内遗漏的浅色抗锯齿，保留引线等图形，也不把框外留白或引线纳入译文区域。
      const bx0 = Math.max(x0, Math.floor(box[0] * width) - left), by0 = Math.max(y0, Math.floor(box[1] * height) - top);
      const bx1 = Math.min(x1, Math.ceil(box[2] * width) - left), by1 = Math.min(y1, Math.ceil(box[3] * height) - top);
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
        const i = y * w + x;
        if (graphics[i] || accepted[i]) continue;
        const rgb = sample(left + x, top + y);
        if (!coloredPixel(left + x, top + y) && !neighborPixel(left + x, top + y) && !protectedPixel(left + x, top + y)
          && Math.max(...rgb) - Math.min(...rgb) < 45 && rgb.some((value, c) => value < color[c] - 4)) accepted[i] = 1;
      }
      for (let i = 0; i < size; i++) if (accepted[i]) for (let c = 0; c < 3; c++) background[i * 3 + c] = color[c];
    }
    const patch = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4), colors = [[], [], []], darkColors = [[], [], []];
    const acceptedMask = options?.returnMask ? new Uint8Array((x1 - x0) * (y1 - y0)) : null;
    let changed = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const index = y * w + x, localAt = (y - y0) * (x1 - x0) + x - x0, at = localAt * 4, rgb = sample(left + x, top + y);
      for (let c = 0; c < 3; c++) patch[at + c] = accepted[index] ? background[index * 3 + c] : rgb[c];
      patch[at + 3] = 255;
      if (accepted[index]) {
        changed++;
        if (acceptedMask) acceptedMask[localAt] = 1;
      }
      if (chosen[index] && rgb.some((value, c) => Math.abs(value - background[index * 3 + c]) > 100)) {
        for (let c = 0; c < 3; c++) colors[c].push(rgb[c]);
        if (Math.min(...rgb) < 130) for (let c = 0; c < 3; c++) darkColors[c].push(rgb[c]);
      }
    }
    const inkColors = darkColors.every(values => values.length) ? darkColors : colors;
    return { pixels: patch, width: x1 - x0, height: y1 - y0, box: [left + x0, top + y0, left + x1, top + y1],
      color: inkColors.every(values => values.length) ? inkColors.map(median) : [20, 20, 20], changed,
      ...(acceptedMask ? { acceptedMask } : {}) };
  }

  function restoreRotatedImageLabel(pixels, width, height, poly, protectedItems = [], sourceText = "", neighborItems = []) {
    if (!pixels || !(width > 0 && height > 0) || !Array.isArray(poly) || poly.length !== 4) return null;
    const pts = poly.map(([x, y]) => [x * width, y * height]);
    const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
    const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
    const vx = ((pts[1][0] - pts[0][0]) + (pts[2][0] - pts[3][0])) / 2;
    const vy = ((pts[1][1] - pts[0][1]) + (pts[2][1] - pts[3][1])) / 2;
    const textLen = Math.hypot(vx, vy);
    if (!(textLen > 4)) return null;
    const tx = vx / textLen, ty = vy / textLen, nx = -ty, ny = tx;
    const h1 = Math.abs((pts[3][0] - pts[0][0]) * nx + (pts[3][1] - pts[0][1]) * ny);
    const h2 = Math.abs((pts[2][0] - pts[1][0]) * nx + (pts[2][1] - pts[1][1]) * ny);
    const textH = (h1 + h2) / 2;
    if (!(textH > 4)) return null;
    const pad = Math.max(6, Math.ceil(textH * .4));
    const patchW = Math.ceil(textLen) + pad * 2, patchH = Math.ceil(textH) + pad * 2;
    if (patchW * patchH > 400000) return null;
    const pcx = patchW / 2, pcy = patchH / 2;
    const patch = new Uint8ClampedArray(patchW * patchH * 4);
    for (let ly = 0; ly < patchH; ly++) for (let lx = 0; lx < patchW; lx++) {
      const dx = lx - pcx, dy = ly - pcy;
      const sx = Math.max(0, Math.min(width - 1, cx + dx * tx - dy * ty));
      const sy = Math.max(0, Math.min(height - 1, cy + dx * ty + dy * tx));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const i00 = (y0 * width + x0) * 4, i10 = (y0 * width + x1) * 4, i01 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
      const dst = (ly * patchW + lx) * 4;
      for (let c = 0; c < 4; c++) {
        patch[dst + c] = Math.round(pixels[i00 + c] * w00 + pixels[i10 + c] * w10 + pixels[i01 + c] * w01 + pixels[i11 + c] * w11);
      }
    }
    const toLocalBox = item => {
      const quad = itemQuad(item, width, height);
      if (!quad) return null;
      const lxs = [], lys = [];
      for (const [px, py] of quad) {
        const rx = px - cx, ry = py - cy;
        lxs.push((pcx + rx * tx + ry * ty) / patchW);
        lys.push((pcy - rx * ty + ry * tx) / patchH);
      }
      const box = [Math.max(0, Math.min(...lxs)), Math.max(0, Math.min(...lys)), Math.min(1, Math.max(...lxs)), Math.min(1, Math.max(...lys))];
      return validBox(box) ? box : null;
    };
    const localBox = [(pcx - textLen / 2) / patchW, (pcy - textH / 2) / patchH, (pcx + textLen / 2) / patchW, (pcy + textH / 2) / patchH];
    const restored = restoreImageLabel(patch, patchW, patchH, localBox,
      (protectedItems || []).map(toLocalBox).filter(Boolean), sourceText,
      (neighborItems || []).map(toLocalBox).filter(Boolean), { returnMask: true });
    if (!restored || !restored.acceptedMask) return null;
    const [rx0, ry0, rx1, ry1] = restored.box;
    const rw = restored.width, rh = restored.height, mask = restored.acceptedMask;
    const corners = [[rx0, ry0], [rx1, ry0], [rx1, ry1], [rx0, ry1]].map(([lx, ly]) => [
      cx + (lx - pcx) * tx - (ly - pcy) * ty,
      cy + (lx - pcx) * ty + (ly - pcy) * tx
    ]);
    const ox0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[0]))) - 1);
    const oy0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[1]))) - 1);
    const ox1 = Math.min(width, Math.ceil(Math.max(...corners.map(c => c[0]))) + 1);
    const oy1 = Math.min(height, Math.ceil(Math.max(...corners.map(c => c[1]))) + 1);
    const repairs = [];
    for (let oy = oy0; oy < oy1; oy++) for (let ox = ox0; ox < ox1; ox++) {
      const rx = ox - cx, ry = oy - cy;
      const lx = pcx + rx * tx + ry * ty - rx0, ly = pcy - rx * ty + ry * tx - ry0;
      if (lx < 0 || lx >= rw - 1 || ly < 0 || ly >= rh - 1) continue;
      const x0 = Math.floor(lx), y0 = Math.floor(ly), fx = lx - x0, fy = ly - y0;
      const ws = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      const idxs = [y0 * rw + x0, y0 * rw + x0 + 1, (y0 + 1) * rw + x0, (y0 + 1) * rw + x0 + 1];
      let wSum = 0, r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) {
        if (!mask[idxs[k]]) continue;
        const w = ws[k], ra = idxs[k] * 4;
        wSum += w; r += restored.pixels[ra] * w; g += restored.pixels[ra + 1] * w; b += restored.pixels[ra + 2] * w;
      }
      if (wSum >= .35) repairs.push((oy * width + ox) * 4, Math.round(r / wSum), Math.round(g / wSum), Math.round(b / wSum));
    }
    const rcx = cx + ((rx0 + rx1) / 2 - pcx) * tx - ((ry0 + ry1) / 2 - pcy) * ty;
    const rcy = cy + ((rx0 + rx1) / 2 - pcx) * ty + ((ry0 + ry1) / 2 - pcy) * tx;
    return {
      center: [rcx, rcy], width: rw, height: rh, sourceHeight: textH,
      angle: Math.round(Math.atan2(ty, tx) * 18000 / Math.PI) / 100,
      color: restored.color, changed: repairs.length / 4, repairs
    };
  }

  function applyRestoredImageLabel(combinedData, sourcePixels, width, height, restored, rotated = false) {
    if (!restored) return;
    if (Array.isArray(restored.repairs)) {
      for (let i = 0; i < restored.repairs.length; i += 4) {
        const target = restored.repairs[i];
        combinedData[target] = restored.repairs[i + 1];
        combinedData[target + 1] = restored.repairs[i + 2];
        combinedData[target + 2] = restored.repairs[i + 3];
        combinedData[target + 3] = 255;
      }
      return;
    }
    const [x0, y0] = restored.box;
    for (let y = 0; y < restored.height; y++) for (let x = 0; x < restored.width; x++) {
      const at = (y * restored.width + x) * 4;
      const target = rotated ? ((height - 1 - (x0 + x)) * width + y0 + y) * 4 : ((y0 + y) * width + x0 + x) * 4;
      if (restored.pixels[at] === sourcePixels[target] && restored.pixels[at + 1] === sourcePixels[target + 1]
        && restored.pixels[at + 2] === sourcePixels[target + 2]) continue;
      for (let c = 0; c < 4; c++) combinedData[target + c] = restored.pixels[at + c];
    }
  }

  function requestPlan(ocr, layout, machine = false, reserved = new Set()) {
    const images = [], records = [], seenTexts = new Set();
    let wireIndex = 0;
    if (ocr?.version !== 1 || ocr.sourceFingerprint !== fingerprint(layout) || !Array.isArray(ocr.images)) return { images, records, ids: new Set(), machine };
    const allowed = Array.isArray(layout.pages) ? new Set(extract(layout).map(figure => figure.id)) : null;
    for (const [index, figure] of ocr.images.entries()) {
      if (allowed && !allowed.has(figure?.id)) continue;
      if (!validBox(figure?.bbox) || !Array.isArray(figure.lines)
        || figure.lines.some(line => typeof line?.text !== "string" || !validBox(line.bbox))) continue;
      const html = `<table>${figure.lines.map(line => `<tr><td>${U.escapeHTML(line.text)}</td></tr>`).join("")}</table>`;
      const grid = L.LayoutTables.parseGrid(html);
      if (!grid) continue;
      for (const cell of grid.cells) if (cell.tokens.some(token => token.html === null)) cell.translate = false;
      const translatable = grid.cells.filter(cell => cell.translate);
      if (!translatable.length) continue;
      const imageFingerprint = U.hashString(JSON.stringify(figure));
      let id = `img${index}_${ocr.sourceFingerprint}_${imageFingerprint}`;
      while (reserved.has(id) || grid.cells.some(cell => reserved.has(`${id}c${cell.index}`))) id = `_${id}`;
      const image = { ...figure, ...grid, requestID: id, fingerprint: imageFingerprint };
      images.push(image);
      const cells = [];
      // 同一文献内完全相同的图片标签只保留首次出现的待译项，避免重复送译
      for (const cell of translatable) {
        if (seenTexts.has(cell.text)) continue;
        seenTexts.add(cell.text);
        cells.push(cell);
      }
      if (!cells.length) continue;
      if (machine) records.push(...cells.map(cell => ({ id: `${id}c${cell.index}`, page: figure.page + 1, type: "image_label", text: cell.text })));
      else {
        let wireID = `I${++wireIndex}`;
        while (reserved.has(wireID)) wireID = `_${wireID}`;
        records.push({ id, wireID, page: figure.page + 1, type: "image_labels", cells: cells.map(cell => [cell.index, cell.text]), text: JSON.stringify(cells.map(cell => [cell.index, cell.text])) });
      }
    }
    return { images, records, machine, parseRevisionID: ocr.parseRevisionID || "", ids: new Set(records.map(record => record.id)) };
  }

  function cacheFromRecords(plan, translations, sourceFingerprint, targetLanguage) {
    const direct = new Map(), byText = new Map();
    const imageByID = new Map((plan.images || []).map(image => [image.requestID, image]));
    if (plan.machine) {
      for (const image of plan.images || []) {
        for (const cell of image.cells.filter(item => item.translate)) {
          const value = translations?.[`${image.requestID}c${cell.index}`];
          if (!L.LayoutTables.validText(cell, value)) continue;
          direct.set(`${image.requestID}c${cell.index}`, value);
          if (!byText.has(cell.text)) byText.set(cell.text, value);
        }
      }
    } else {
      for (const record of plan.records || []) {
        const image = imageByID.get(record.id);
        const raw = translations?.[record.id];
        if (!image || typeof raw !== "string") continue;
        let entries;
        try {
          entries = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!Array.isArray(entries)) continue;
        const cellByIndex = new Map(image.cells.map(item => [item.index, item]));
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          const [cellIndex, value] = entry;
          const cell = cellByIndex.get(cellIndex);
          if (!cell || !cell.translate || !validImageText(cell, value)) continue;
          direct.set(`${image.requestID}c${cellIndex}`, value);
          if (!byText.has(cell.text)) byText.set(cell.text, value);
        }
      }
    }
    // 将去重标签的译文回填到所有同文图片标签，确保每张图都能完整挂载渲染
    const images = (plan.images || []).flatMap(image => {
      const values = {};
      for (const cell of image.cells.filter(item => item.translate)) {
        const value = direct.get(`${image.requestID}c${cell.index}`) ?? byText.get(cell.text);
        if (validImageText(cell, value)) values[cell.index] = value;
      }
      return Object.keys(values).length ? [{ ...image, translations: values }] : [];
    });
    return { version: 1, sourceFingerprint, parseRevisionID: plan.parseRevisionID || "", targetLanguage, images };
  }

  function cachedRecords(plan, cache, sourceFingerprint) {
    if (cache && !Array.isArray(cache.images)) return {};
    if ((cache?.parseRevisionID || "") !== (plan.parseRevisionID || "")) return {};
    const values = {};
    if (cache?.sourceFingerprint !== sourceFingerprint) return values;
    const cachedByText = new Map();
    const cacheByFingerprint = new Map();
    for (const item of cache.images || []) {
      if (item?.fingerprint && !cacheByFingerprint.has(item.fingerprint)) cacheByFingerprint.set(item.fingerprint, item);
      for (const cell of item?.cells || []) {
        if (!cell?.translate) continue;
        const value = item.translations?.[cell.index];
        if (validImageText(cell, value) && !cachedByText.has(cell.text)) cachedByText.set(cell.text, value);
      }
    }
    if (plan.machine) {
      for (const image of plan.images || []) {
        const cached = cacheByFingerprint.get(image.fingerprint);
        for (const cell of image.cells.filter(item => item.translate)) {
          const id = `${image.requestID}c${cell.index}`;
          if (plan.ids instanceof Set && !plan.ids.has(id)) continue;
          const value = cached?.translations?.[cell.index] ?? cachedByText.get(cell.text);
          if (!noTranslation(value) && L.LayoutTables.validText(cell, value)) values[id] = value;
        }
      }
      return values;
    }
    const imageByID = new Map((plan.images || []).map(image => [image.requestID, image]));
    for (const record of plan.records || []) {
      const image = imageByID.get(record.id);
      if (!image || !Array.isArray(record.cells)) continue;
      const cached = cacheByFingerprint.get(image.fingerprint);
      const cellByIndex = new Map(image.cells.map(item => [item.index, item]));
      const pairs = [];
      let complete = true;
      for (const [cellIndex] of record.cells) {
        const cell = cellByIndex.get(cellIndex);
        const value = cached?.translations?.[cellIndex] ?? (cell ? cachedByText.get(cell.text) : null);
        if (!cell || !cell.translate || !validImageText(cell, value)) {
          complete = false;
          break;
        }
        pairs.push([cellIndex, value]);
      }
      if (complete && pairs.length) values[record.id] = JSON.stringify(pairs);
    }
    return values;
  }

  function attach(model, cache, parseRevisionID = "", layout = null, ocr = null) {
    if (!model?.pages) return model;
    // 旧编译模型不保留解析分类；从现有布局恢复保留区域，不改写旧模型缓存。
    const furniture = (layout?.pages || []).map(page => {
      const boxes = new Set();
      const visit = (block, inherited = false) => {
        const retained = inherited || isPageFurniture(block);
        if (retained && validBox(block.bbox)) boxes.add(JSON.stringify(block.bbox));
        for (const child of block.blocks || []) visit(child, retained);
      };
      for (const block of page.preproc_blocks || []) visit(block);
      return boxes;
    });
    const active = cache?.version === 1 && cache.sourceFingerprint === model.sourceFingerprint
      && (cache.parseRevisionID || "") === parseRevisionID && Array.isArray(cache.images) && cache.images.length;
    const activeOCR = ocr?.version === 1 && ocr.sourceFingerprint === model.sourceFingerprint
      && (ocr.parseRevisionID || "") === parseRevisionID && Array.isArray(ocr.images) && ocr.images.length;
    if (!active && !activeOCR && !model.imageTranslationHash && !furniture.some(boxes => boxes.size)) return model;
    const { imageTranslationHash: _previous, ...base } = model;
    const apply = (block, page) => {
      const { translatedImageLabels: _labels, imageProtectedBoxes: _protected, imageOCRDebugBoxes: _ocrDebug, ...clean } = block;
      if (isPageFurniture(block) || furniture[page]?.has(JSON.stringify(block.bbox))) return { ...clean, sourceOnly: true };
      if ((!active && !activeOCR) || !["image", "image_body", "chart", "chart_body"].includes(block.type)) return clean;
      const matches = active
        ? cache.images.filter(image => image?.page === page && JSON.stringify(image.bbox) === JSON.stringify(block.bbox))
        : [];
      const ocrMatches = activeOCR
        ? ocr.images.filter(image => image?.page === page && JSON.stringify(image.bbox) === JSON.stringify(block.bbox))
        : [];
      const image = matches.length === 1 ? matches[0] : null;
      const ocrImage = ocrMatches.length === 1 ? ocrMatches[0] : null;
      const debugFromImage = () => {
        if (image && Array.isArray(image.cells) && Array.isArray(image.lines)) {
          return image.cells.flatMap(cell => {
            const line = image.lines[cell.index];
            if (!line || !validBox(line.bbox)) return [];
            const raw = image.translations?.[cell.index];
            const isTranslated = cell.translate && !noTranslation(raw) && !unchangedImageText(cell, raw) && L.LayoutTables.validText(cell, raw);
            let translatedText = "";
            if (isTranslated) {
              translatedText = raw;
              for (const token of cell.tokens) translatedText = translatedText.replace(token.marker, () => token.source);
            }
            const status = isTranslated ? "translated" : (cell.translate ? "skipped" : "protected");
            return [{ bbox: line.bbox, text: line.text || "", status, ...(translatedText ? { translatedText } : {}) }];
          });
        }
        if (ocrImage && Array.isArray(ocrImage.lines)) {
          return ocrImage.lines.filter(line => validBox(line?.bbox)).map(line => ({ bbox: line.bbox, text: line.text || "", status: "ocr" }));
        }
        return [];
      };
      const debugBoxes = debugFromImage();
      const withDebug = debugBoxes.length ? { imageOCRDebugBoxes: debugBoxes } : {};
      if (!image) return { ...clean, ...withDebug };
      try {
        const translated = cell => cell.translate && !noTranslation(image.translations?.[cell.index]) && !unchangedImageText(cell, image.translations?.[cell.index])
          && L.LayoutTables.validText(cell, image.translations?.[cell.index]);
        const labels = image.cells.filter(translated).map(cell => {
          let text = image.translations[cell.index];
          for (const token of cell.tokens) text = text.replace(token.marker, () => token.source);
          const srcText = String(image.lines[cell.index].text || "");
          if (/^(?:[\s|·•─━]+|-{2,}|–{2,}|—+|\.(?=\d+[A-Za-z])|-(?=[A-Za-z]))/.test(srcText)) {
            text = text.replace(/^(?:[\s|·•─━]+|-{2,}|–{2,}|—+|-(?=[A-Za-z0-9])|\.(?=\d+[A-Za-z]))+/, "");
          }
          const line = image.lines[cell.index];
          return {
            bbox: line.bbox,
            text,
            sourceText: srcText,
            rotation: Number.isFinite(Number(line.rotation)) ? Number(line.rotation) : 0,
            ...(Array.isArray(line.poly) ? { poly: line.poly } : {})
          };
        });
        if (!labels.length || labels.some(label => !validBox(label.bbox))) return { ...clean, ...withDebug };
        return { ...clean, ...withDebug, translatedImageLabels: labels, imageProtectedBoxes: image.cells.filter(cell => !translated(cell)).map(cell => image.lines[cell.index].bbox) };
      } catch (_) { return { ...clean, ...withDebug }; }
    };
    return { ...base, ...(active ? { imageTranslationHash: U.hashString(`image-render-centered-v12|${JSON.stringify(cache)}`) } : {}), pages: model.pages.map((page, index) => ({
      ...page, blocks: (page.blocks || []).map(block => apply(block, index)), restoration: page.restoration ? {
        ...page.restoration, absoluteBlocks: (page.restoration.absoluteBlocks || []).map(block => apply(block, index))
      } : page.restoration
    })) };
  }

  // MinerU 在线图片 OCR 对小字号和图内标签较弱，当前默认使用本地 OCR；保留代码级开关以便未来随时切回在线接口。
  const MINERU_USE_LOCAL_OCR = true;

  function resolveImageOCRMode(parseProvider = "mineru", options = {}) {
    if (String(parseProvider || "mineru").trim().toLowerCase() === "paddle") return "paddle-api";
    const useLocal = options.mineruUseLocal ?? L.LayoutImages?.mineruUseLocalOCR ?? MINERU_USE_LOCAL_OCR;
    return useLocal ? "local" : "mineru-api";
  }

  function resolveImageOCRModel(parseProvider = "mineru", options = {}) {
    const mode = resolveImageOCRMode(parseProvider, options);
    if (mode === "local") return "local-ppocr-v6-tiny";
    return mode === "paddle-api" ? "PP-OCRv6" : "mineru-pipeline";
  }

  class ImageTranslationService {
    constructor(storage, paddle, mineru = null, hooks = {}) {
      this.storage = storage;
      this.paddle = paddle;
      this.mineru = mineru;
      this.pending = new Map();
      this.localOCRConsent = typeof hooks?.localOCRConsent === "function" ? hooks.localOCRConsent : null;
      this.switchToPaddle = typeof hooks?.switchToPaddle === "function" ? hooks.switchToPaddle : null;
    }

    async _withLocalOCRPage(signal, emit, task) {
      const win = Zotero.getMainWindow?.() || global.Services?.wm?.getMostRecentWindow?.("navigator:browser");
      if (!win?.document?.documentElement) throw new Error("无法启动本地图片识别");
      const browser = win.document.createXULElement("browser");
      browser.setAttribute("type", "content");
      browser.style.cssText = "position:fixed;width:1px;height:1px;visibility:hidden;pointer-events:none";
      win.document.documentElement.appendChild(browser);
      let page = null;
      let progressTimer = null;
      const onAbort = () => {
        try { page?.LitMTransLocalOCR?.cancel?.(); } catch (_) {}
      };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        browser.setAttribute("src", "chrome://litmtrans/content/src/local-ocr.xhtml");
        for (let i = 0; i < 300; i++) {
          U.throwIfAborted(signal);
          page = browser.contentWindow?.wrappedJSObject || browser.contentWindow;
          if (page?.LitMTransLocalOCR) break;
          await U.sleep(100);
        }
        if (!page?.LitMTransLocalOCR) throw new Error("无法启动本地图片识别");
        let lastKey = "";
        progressTimer = win.setInterval(() => {
          const message = String(page.LitMTransLocalOCR.state?.progress || "");
          const percent = page.LitMTransLocalOCR.state?.percent;
          const key = `${message}:${percent ?? ""}`;
          if (message && key !== lastKey) {
            lastKey = key;
            emit?.({
              type: "status",
              phase: "local-ocr",
              message,
              ...(Number.isFinite(percent) ? { progress: percent } : {})
            });
          }
        }, 300);
        const config = this.storage.getLocalOCRConfig?.() || {};
        return await task(page, config);
      } finally {
        if (progressTimer !== null) win.clearInterval(progressTimer);
        signal?.removeEventListener("abort", onAbort);
        try { await page?.LitMTransLocalOCR?.dispose?.(); } finally { browser.remove(); }
      }
    }

    async ensureLocalModels(signal, emit) {
      return this._withLocalOCRPage(signal, emit, async (page, config) => {
        emit?.({ type: "status", phase: "local-ocr", message: "正在检查本地图片识别组件", progress: 0 });
        await page.LitMTransLocalOCR.downloadModels(config);
        U.throwIfAborted(signal);
        return true;
      });
    }

    async collectLocalFigures(documentID, figures, assets, cached, signal, emit, missingOnly = false, failedOnly = false) {
      return this._withLocalOCRPage(signal, emit, async (page, config) => {
        await page.LitMTransLocalOCR.initialize(config);
        const images = [];
        for (const [index, figure] of figures.entries()) {
          U.throwIfAborted(signal);
          const previous = cached?.images.find(item => item.id === figure.id && JSON.stringify(item.bbox) === JSON.stringify(figure.bbox));
          if (missingOnly && previous && (previous.lines?.length || failedOnly) && !previous.ocrFailed) { images.push(previous); continue; }
          const relative = String(assets[figure.asset] || figure.asset).replace(/\\/g, "/");
          if (/^(?:[a-z]+:|\/)/i.test(relative) || relative.split("/").includes("..") || !/\.(?:png|jpe?g)$/i.test(relative)) continue;
          const done = index + 1;
          const percent = Math.round((done * 100) / Math.max(1, figures.length));
          emit?.({
            type: "status",
            phase: "local-ocr",
            message: `正在本地识别图片文字：${done}/${figures.length}`,
            progress: percent
          });
          try {
            const bytes = await this.storage.readBytes(this.storage.path(documentID, ...relative.split("/")));
            const rows = await page.LitMTransLocalOCR.recognize(U.encodeBytesBase64(bytes), /\.png$/i.test(relative) ? "image/png" : "image/jpeg");
            const recognized = JSON.parse(rows);
            images.push({ ...figure, lines: previous?.lines?.length ? mergeImageLines(previous.lines, recognized) : recognized });
          } catch (error) {
            U.throwIfAborted(signal);
            emit?.({ type: "log", message: `第 ${index + 1} 张图片识别失败，保留原图。` });
            images.push({ ...(previous || { ...figure, lines: [] }), ocrFailed: true });
          }
        }
        return images;
      });
    }

    async paddleImageRequests(pdf, sheets, maxBytes = 200 * 1024 * 1024, maxPages = 1000) {
      const bytes = await pdf.save();
      if (bytes.length <= maxBytes && sheets.length <= maxPages) return [{ bytes, sheets }];
      if (sheets.length <= 1) throw new Error("单页图片识别文件超过Paddle上传限制，已保留原图");
      const middle = Math.ceil(sheets.length / 2), requests = [];
      for (const [start, end] of [[0, middle], [middle, sheets.length]]) {
        const part = await global.PDFLib.PDFDocument.create();
        for (const page of await part.copyPages(pdf, Array.from({ length: end - start }, (_, i) => start + i))) part.addPage(page);
        requests.push(...await this.paddleImageRequests(part, sheets.slice(start, end), maxBytes, maxPages));
      }
      return requests;
    }

    async packImageText(bytes, png, signal, rotate = false, neutralOnly = false) {
      U.throwIfAborted(signal);
      const win = Zotero.getMainWindow?.();
      if (!win?.Image || !win.document) return null;
      const image = new win.Image();
      const canvases = [];
      const canvas = (width, height) => {
        const node = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        node.width = width; node.height = height; canvases.push(node); return node;
      };
      try {
        await new Promise((resolve, reject) => {
          const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener("abort", abort); };
          const abort = () => { cleanup(); image.src = ""; reject(new U.CancelledError("操作已取消")); };
          image.onload = () => { cleanup(); resolve(); };
          image.onerror = () => { cleanup(); reject(new Error("图片识别副本无法解码")); };
          signal?.addEventListener("abort", abort, { once: true });
          image.src = `data:image/${png ? "png" : "jpeg"};base64,${U.encodeBytesBase64(bytes)}`;
        });
        U.throwIfAborted(signal);
        if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) return null;
        const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight), Math.sqrt(2300000 / (image.naturalWidth * image.naturalHeight)));
        const width = Math.max(1, Math.round((rotate ? image.naturalHeight : image.naturalWidth) * scale)), height = Math.max(1, Math.round((rotate ? image.naturalWidth : image.naturalHeight) * scale));
        const source = canvas(width, height), ctx = source.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
        if (rotate) { ctx.translate(width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(image, 0, 0, height, width); ctx.setTransform(1, 0, 0, 1, 0, 0); }
        else ctx.drawImage(image, 0, 0, width, height);
        const ink = ctx.getImageData(0, 0, width, height);
        let { boxes, mask } = imageTextCandidates(ink.data, width, height, neutralOnly === 5 ? true : neutralOnly);
        if (neutralOnly === 3) boxes = boxes.filter(box => box[3] >= height * .985);
        if (!boxes.length) return null;
        // 掩膜只用于定位；识别副本保留原始灰度笔画，避免连在线上的字母被一起删除。
        for (let i = 0; i < ink.data.length; i += 4) {
          const luminance = Math.round(ink.data[i] * .299 + ink.data[i + 1] * .587 + ink.data[i + 2] * .114);
          const gray = neutralOnly === 4 ? (luminance > 210 ? 0 : 255) : neutralOnly === 5 ? (mask[i / 4] ? 0 : 255) : luminance;
          ink.data[i] = ink.data[i + 1] = ink.data[i + 2] = gray;
        }
        ctx.putImageData(ink, 0, 0);
        const mapping = [];
        let top = 16;
        for (const box of boxes) {
          const h = box[3] - box[1];
          // 定位掩膜可能丢掉与图线相连的词首，识别裁片按字高补足横向上下文。
          const padding = neutralOnly ? Math.max(3, Math.ceil(h * .25)) : h;
          const sourceBox = [Math.max(0, box[0] - padding), box[1], Math.min(width, box[2] + padding), box[3]];
          const w = sourceBox[2] - sourceBox[0];
          const scale = neutralOnly === 4 || neutralOnly === 5 ? 3 : 1;
          if (top + h * scale + 16 > 6000) break;
          mapping.push({ source: sourceBox, packed: [20, top, 20 + w * scale, top + h * scale] }); top += h * scale + 20;
        }
        if (!mapping.length) return null;
        const packed = canvas(Math.max(200, ...mapping.map(row => row.packed[2] + 20)), top);
        const draw = packed.getContext("2d"); draw.fillStyle = "#fff"; draw.fillRect(0, 0, packed.width, packed.height);
        for (const { source: box, packed: p } of mapping) draw.drawImage(source, box[0], box[1], box[2] - box[0], box[3] - box[1], p[0], p[1], p[2] - p[0], p[3] - p[1]);
        U.throwIfAborted(signal);
        const binary = U.base64Decode(packed.toDataURL("image/png").split(",")[1]);
        return { bytes: global.Uint8Array.from(binary, char => char.charCodeAt(0)), mapping, size: [packed.width, packed.height], sourceSize: [width, height] };
      } finally { image.src = ""; for (const node of canvases) node.width = node.height = 1; }
    }

    async recognizeMinerU(bytes, count, token, signal, emit) {
      const root = this.storage.temporaryDir("imageocr");
      await this.storage.ensureDir(root);
      const diagnostics = this.diagnosticsDirectory
        ? PathUtils.join(this.diagnosticsDirectory, U.randomID("image-ocr")) : null;
      try {
        if (diagnostics) {
          await this.storage.ensureDir(diagnostics);
          await this.storage.writeBytes(PathUtils.join(diagnostics, "input.pdf"), bytes);
        }
        const file = PathUtils.join(root, "images.pdf");
        await this.storage.writeBytes(file, bytes);
        const options = { modelVersion: "pipeline", isOCR: true, enableFormula: false, enableTable: false, timeoutSeconds: 600 };
        const task = await this.mineru.submit(file, options, token, signal);
        await this.mineru.upload(task.uploadURL, file, signal);
        const item = await this.mineru.poll(task.batchID, options, token, signal, imageOCRProgressEmitter(emit));
        const { zipPath } = await this.mineru.downloadResult(item, root, signal);
        const extracted = PathUtils.join(root, "result");
        await this.mineru.extractZip(zipPath, extracted);
        const located = await this.mineru.locateResultFiles(extracted);
        const pages = located.model ? await this.storage.readJSON(located.model, null) : null;
        if (diagnostics) await this.storage.writeJSON(PathUtils.join(diagnostics, "raw-model.json"), pages);
        if (!Array.isArray(pages) || pages.length !== count
          || pages.some((page, index) => page?.page_info?.page_no !== index)) throw new Error("MinerU 图片 OCR 返回页数或顺序不兼容");
        const lines = pages.map(linesFromMinerU);
        if (diagnostics) await this.storage.writeJSON(PathUtils.join(diagnostics, "accepted-lines.json"), lines);
        return lines;
      }
      finally { await this.storage.remove(root, true); }
    }

    async recognizeSharedImageText(inputs, token, signal, emit, isolated = false, groupSizes = null) {
      let start = 0;
      const sheets = (groupSizes || [inputs.length]).flatMap(size => {
        const offset = start;
        start += size;
        return planImageOCRSheets(inputs.slice(offset, start), isolated).map(sheet => ({
          ...sheet, cells: sheet.cells.map(cell => ({ ...cell, input: cell.input + offset }))
        }));
      });
      const result = inputs.map(() => []);
      let completed = false, failure = null;
      for (let offset = 0; offset < sheets.length; offset += 40) {
        U.throwIfAborted(signal);
        const group = sheets.slice(offset, offset + 40), pdf = await global.PDFLib.PDFDocument.create(), embedded = new Map();
        for (const sheet of group) {
          const page = pdf.addPage(sheet.size.map(value => value * .5));
          for (const cell of sheet.cells) {
            if (!embedded.has(cell.input)) embedded.set(cell.input, await pdf.embedPng(inputs[cell.input].packing.bytes));
            const image = embedded.get(cell.input), packing = inputs[cell.input].packing;
            const p = cell.packed, from = cell.from;
            // 临时 PDF 只放文字裁片，坐标裁切不涉及文献 PDF 或原图文件。
            page.pushOperators(global.PDFLib.pushGraphicsState(), global.PDFLib.rectangle(p[0] * .5, (sheet.size[1] - p[3]) * .5, (p[2] - p[0]) * .5, (p[3] - p[1]) * .5), global.PDFLib.clip(), global.PDFLib.endPath());
            page.drawImage(image, { x: (p[0] - from[0]) * .5, y: (sheet.size[1] - p[3] - packing.size[1] + from[3]) * .5,
              width: packing.size[0] * .5, height: packing.size[1] * .5 });
            page.pushOperators(global.PDFLib.popGraphicsState());
          }
        }
        emit?.({ type: "status", message: `正在识别图片文字：第 ${offset + 1}–${offset + group.length}/${sheets.length} 页文字裁片` });
        let pages;
        try {
          pages = await this.recognizeMinerU(await pdf.save(), group.length, token, signal, emit);
          completed = true;
        } catch (error) {
          U.throwIfAborted(signal);
          if (error.cancelled) throw error;
          failure ||= error;
          continue;
        }
        for (let page = 0; page < group.length; page++) {
          const sheet = group[page];
          for (const index of new Set(sheet.cells.map(cell => cell.input))) {
            const mapping = sheet.cells.filter(cell => cell.input === index).map(cell => ({ source: cell.source, packed: cell.packed }));
            result[index].push(...mapPackedImageLines(pages[page], { size: sheet.size, sourceSize: inputs[index].packing.sourceSize, mapping }));
          }
        }
      }
      if (!completed && failure) throw failure;
      return result;
    }

    async collectMinerUFigures(documentID, figures, assets, cached, token, signal, emit, missingOnly = false) {
      const inputs = [], enhanced = [], supplemental = [], edge = [], sources = [], images = [];
      for (const figure of figures) {
        U.throwIfAborted(signal);
        const previous = cached?.images.find(item => item.id === figure.id && JSON.stringify(item.bbox) === JSON.stringify(figure.bbox));
        images.push({ ...figure, lines: previous?.lines || [] });
        if (missingOnly && previous?.lines?.length) continue;
        const relative = String(assets[figure.asset] || figure.asset).replace(/\\/g, "/");
        if (/^(?:[a-z]+:|\/)/i.test(relative) || relative.split("/").includes("..") || !/\.(?:png|jpe?g)$/i.test(relative)) continue;
        try {
          const bytes = global.Uint8Array.from(await this.storage.readBytes(this.storage.path(documentID, ...relative.split("/"))));
          const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
          if (!png && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) continue;
          sources.push({ image: images.length - 1, bytes, png });
          for (const rotated of [false, true]) for (const neutral of [true, false]) {
            const packing = await this.packImageText(bytes, png, signal, rotated, neutral);
            if (packing) (neutral ? enhanced : inputs).push({ image: images.length - 1, packing, rotated });
          }
          const narrow = await this.packImageText(bytes, png, signal, true, 2);
          if (narrow) supplemental.push({ image: images.length - 1, packing: narrow });
          const bottom = await this.packImageText(bytes, png, signal, false, 3);
          if (bottom) edge.push({ image: images.length - 1, packing: bottom });
        } catch (error) { U.throwIfAborted(signal); if (error.cancelled) throw error; }
      }
      let completed = false, failure = null;
      const collect = async (batch, isolated = false, groupSizes = null) => {
        if (!batch.length) return [];
        try {
          const result = await this.recognizeSharedImageText(batch, token, signal, emit, isolated, groupSizes);
          completed = true; return result;
        } catch (error) { U.throwIfAborted(signal); if (error.cancelled) throw error; failure ||= error; }
        return [];
      };
      const groups = [inputs, enhanced, supplemental, edge];
      const combined = await collect(groups.flat(), false, groups.map(group => group.length));
      let position = 0;
      const [original, refined, extra, edgeLines] = groups.map(group => {
        const lines = combined.slice(position, position + group.length);
        position += group.length;
        return lines;
      });
      for (const [batch, recognized] of [[enhanced, refined], [inputs, original], [supplemental, extra], [edge, edgeLines]]) {
        batch.forEach((input, index) => {
          const source = recognized[index] || [];
          const lines = input.rotated || batch === supplemental ? rotatedImageLines(source, input.packing.sourceSize[1], input.packing.sourceSize[0]) : source;
          images[input.image].lines = mergeImageLines(images[input.image].lines, lines);
        });
      }
      const binary = [];
      for (const source of sources) {
        if (images[source.image].lines.filter(line => /[A-Za-z]{2}/.test(line.text)).length >= 2) continue;
        for (const mode of [4, 5]) {
          const packing = await this.packImageText(source.bytes, source.png, signal, false, mode);
          if (packing) binary.push({ image: source.image, packing });
        }
      }
      const recovered = await collect(binary, 2);
      binary.forEach((input, index) => { images[input.image].lines = mergeImageLines(images[input.image].lines, recovered[index] || []); });
      if (!completed && failure) throw failure;
      return images;
    }

    async ensure(documentID, layout, signal, emit, options = {}) {
      const meta = await this.storage.getDocumentMeta(documentID);
      const provider = String(options.parseProvider || meta?.parseProvider || U.getPref("parseProvider", "mineru") || "mineru");
      const mode = resolveImageOCRMode(provider, options);
      const key = `${documentID}:${fingerprint(layout)}:${provider}:${mode}`;
      if (this.pending.has(key)) return this.pending.get(key);
      const nextOptions = { parseProvider: provider };
      if (options.mineruUseLocal !== undefined) nextOptions.mineruUseLocal = options.mineruUseLocal;
      const task = this.collect(documentID, layout, signal, emit, nextOptions).finally(() => this.pending.delete(key));
      this.pending.set(key, task);
      return task;
    }

    async collect(documentID, layout, signal, emit, options = {}) {
      const sourceFingerprint = fingerprint(layout), path = this.storage.path(documentID, "image-ocr.v1.json");
      const meta = await this.storage.getDocumentMeta(documentID);
      const parseRevisionID = meta?.parseRevisionID || "";
      const cached = await this.storage.readJSON(path, null);
      const validCache = cached?.version === 1 && cached.sourceFingerprint === sourceFingerprint
        && (cached.parseRevisionID || "") === parseRevisionID && Array.isArray(cached.images);
      const canPack = Boolean(Zotero.getMainWindow?.()?.Image);
      let provider = String(options.parseProvider || meta?.parseProvider || U.getPref("parseProvider", "mineru") || "mineru");
      let mode = resolveImageOCRMode(provider, options);
      const requestedModel = resolveImageOCRModel(provider, options);
      const initialSupplement = validCache && cached.model !== requestedModel && cached.images.some(image => !image.lines?.length);
      const initialLocalRetry = mode === "local" && validCache && cached.model === requestedModel && cached.images.some(image => image.ocrFailed);
      const initialMineruToken = mode === "mineru-api" ? this.mineru?.secrets?.getMinerUToken() : "";
      const missingOnly = validCache && ["text-crops-v1", "shared-text-crops-v2"].includes(cached.strategy)
        && cached.images.some(image => !image.lines?.length);
      const upgrade = mode === "mineru-api" && validCache && cached.model === "mineru-pipeline"
        && (!cached.strategy || missingOnly) && initialMineruToken && canPack;
      if (validCache && !upgrade && !initialSupplement && !initialLocalRetry) return cached;
      const figures = extract(layout), result = { version: 1, sourceFingerprint, parseRevisionID, model: requestedModel, images: [] };
      if (!figures.length) return result;
      if (mode === "local" && this.localOCRConsent && this.storage.hasLocalOCRModels && !(await this.storage.hasLocalOCRModels())) {
        const decision = await this.localOCRConsent({ documentID, parseProvider: provider, signal, emit });
        if (decision === "paddle") {
          await this.switchToPaddle?.();
          provider = "paddle";
          mode = "paddle-api";
        } else if (decision !== "download" && decision !== true) {
          emit?.({ type: "warning", message: "未安装本地图片识别模型，已保留原图。" });
          return validCache ? cached : result;
        }
      }
      const local = mode === "local";
      const providerModel = local ? "local-ppocr-v6-tiny" : provider === "paddle" ? "PP-OCRv6" : "mineru-pipeline";
      result.model = providerModel;
      const supplement = validCache && cached.model !== providerModel && cached.images.some(image => !image.lines?.length);
      const localRetry = local && validCache && cached.model === providerModel && cached.images.some(image => image.ocrFailed);
      const mineruToken = mode === "mineru-api" ? this.mineru?.secrets?.getMinerUToken() : "";
      let token = "";
      if (local) {
        const assets = await this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {});
        try { result.images = await this.collectLocalFigures(documentID, figures, assets, validCache ? cached : null, signal, emit,
          missingOnly || supplement || localRetry, localRetry && !missingOnly && !supplement); }
        catch (error) { U.throwIfAborted(signal); if (error.cancelled || !validCache) throw error; return cached; }
      } else {
      token = provider === "paddle" ? this.paddle?.secrets?.getPaddleToken() : "";
      if (!token && !mineruToken) { emit?.({ type: "log", message: `当前解析服务${provider === "paddle" ? " Paddle" : " MinerU"}未配置令牌，图片文字保持原文。` }); return validCache ? cached : result; }
      const assets = await this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {});
      if (!token) {
        try { result.images = await this.collectMinerUFigures(documentID, figures, assets, validCache ? cached : null, mineruToken, signal, emit, missingOnly || supplement); }
        catch (error) { U.throwIfAborted(signal); if (error.cancelled || !validCache) throw error; return cached; }
        if (canPack) result.strategy = MINERU_IMAGE_STRATEGY;
      }
      if (token) {
        U.throwIfAborted(signal);
        const pdf = await global.PDFLib.PDFDocument.create(), batch = [], inputs = [];
        for (const figure of figures) {
          U.throwIfAborted(signal);
          const previous = supplement && cached.images.find(image => image.id === figure.id && JSON.stringify(image.bbox) === JSON.stringify(figure.bbox));
          if (previous?.lines?.length) { result.images.push(previous);continue; }
          const relative = String(assets[figure.asset] || figure.asset).replace(/\\/g, "/");
          if (/^(?:[a-z]+:|\/)/i.test(relative) || relative.split("/").includes("..") || !/\.(?:png|jpe?g)$/i.test(relative)) continue;
          const bytes = global.Uint8Array.from(await this.storage.readBytes(this.storage.path(documentID, ...relative.split("/"))));
          const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
          const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
          if (!png && !jpeg) continue;
          const image = png ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
          const index = batch.length;
          inputs.push({ image, width: image.width, height: image.height, index });
          inputs.push({ image, width: image.height, height: image.width, index, rotated: true });
          batch.push(figure);
        }
        const sheets = [];
        // 保留原页内布局，只合并云任务，避免为减少请求额外改变识别结果。
        for (let start = 0; start < inputs.length; start += 20) {
          sheets.push(...planPaddleImageSheets(inputs.slice(start, start + 20)).map(sheet => ({
            ...sheet, cells: sheet.cells.map(cell => ({ ...cell, input: cell.input + start }))
          })));
        }
        for (const sheet of sheets) {
          const page = pdf.addPage(sheet.size.map(value => value * .5));
          for (const { input, box } of sheet.cells) {
            // 完整图片保持像素比例共用识别页，不参与文献 PDF 的解析或保存。
            const item = inputs[input];
            if (item.rotated) page.drawImage(item.image, { x: box[0] * .5, y: (sheet.size[1] - box[1]) * .5,
              width: item.height * .5, height: item.width * .5, rotate: global.PDFLib.degrees(-90) });
            else page.drawImage(item.image, { x: box[0] * .5, y: (sheet.size[1] - box[3]) * .5,
              width: item.width * .5, height: item.height * .5 });
          }
        }
        const recognized = inputs.map(() => []);
        const requests = sheets.length ? await this.paddleImageRequests(pdf, sheets) : [];
        for (const [index, request] of requests.entries()) {
          U.throwIfAborted(signal);
          emit?.({ type: "status", message: `正在识别图片文字：${batch.length} 张图片，共 ${sheets.length} 页${requests.length > 1 ? `，第 ${index + 1}/${requests.length} 个任务` : ""}` });
          const task = await this.paddle.submit(request.bytes, "PP-OCRv6", token, signal,
            { useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false,
              textDetLimitSideLen: 2000, textDetLimitType: "max", visualize: false });
          const url = await this.paddle.poll(task, token, async () => {}, { timeoutSeconds: 600 }, imageOCRProgressEmitter(emit), signal);
          emit?.({ type: "progress", phase: "image-ocr-poll", progress: null, message: "正在下载Paddle图片文字识别结果" });
          const bytes = await L.HTTP.requestBytes(url, { timeout: 90000, maxBytes: 64 * 1024 * 1024, signal });
          const rows = new TextDecoder().decode(bytes).split(/\r?\n/).filter(line => line.trim()).flatMap(line => {
            const response = JSON.parse(line);
            if (!Array.isArray(response.result?.ocrResults)) throw new Error("图片 OCR 返回结构不兼容");
            return response.result.ocrResults.map((item, index) => ({ item, info: response.result.dataInfo?.pages?.[index] }));
          });
          if (rows.length !== request.sheets.length) throw new Error("图片 OCR 返回页数不完整");
          rows.forEach((row, index) => {
            for (const [input, lines] of mapPaddleSheetLines(linesFromOCR(row.item, row.info), request.sheets[index])) recognized[input].push(...lines);
          });
        }
        batch.forEach((figure, index) => {
          let lines = [];
          inputs.forEach((input, i) => {
            if (input.index !== index) return;
            if (input.rotated) lines = mergeImageLines(lines, rotatedImageLines(recognized[i], input.height, input.width));
            else lines = recognized[i];
          });
          result.images.push({ ...figure, lines });
        });
      }
      }
      if (token) result.strategy = "full-image-sheets-v1";
      result.images.forEach(image => { image.lines = normalizeImageLines(image.lines); });
      for (const page of new Set(result.images.map(image => image.page))) {
        const rows = result.images.filter(image => image.page === page).flatMap(image => image.lines);
        normalizeImageLines(rows, false).forEach((line, index) => { rows[index].text = line.text; });
      }
      result.images.sort((a, b) => figures.findIndex(figure => figure.id === a.id) - figures.findIndex(figure => figure.id === b.id));
      U.throwIfAborted(signal);
      if (U.hashString(await this.storage.readText(this.storage.path(documentID, "layout.json"), "")) !== sourceFingerprint) return null;
      if (((await this.storage.getDocumentMeta(documentID))?.parseRevisionID || "") !== parseRevisionID) return null;
      await this.storage.writeTextAtomically(path, JSON.stringify(result));
      return result;
    }
  }

  function planAlignedImageLabelGroups(items = []) {
    const candidates = (Array.isArray(items) ? items : [])
      .filter(item => item && !item.rotated && item.align !== "flex-end" && validBox(item.box) && Number.isFinite(item.fontSize))
      .sort((a, b) => (a.box[1] + a.box[3]) / 2 - (b.box[1] + b.box[3]) / 2 || a.box[0] - b.box[0]);
    if (candidates.length < 3) return [];
    const heights = candidates.map(item => item.box[3] - item.box[1]).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)];
    if (!(medianH > 0)) return [];
    const leftTol = Math.max(5, Math.min(18, medianH * .55));
    const gapTol = Math.max(10, medianH * 1.15);
    const groups = [];
    for (const item of candidates) {
      let target = null, bestDistance = Infinity;
      for (const group of groups) {
        const last = group[group.length - 1].box;
        if (item.box[1] - last[3] > gapTol || item.box[3] < last[1]) continue;
        const overlap = Math.min(item.box[2], last[2]) - Math.max(item.box[0], last[0]);
        if (overlap <= 0) continue;
        const xs = group.map(entry => entry.box[0]).sort((a, b) => a - b);
        const anchor = xs[Math.floor(xs.length / 2)];
        const distance = Math.abs(item.box[0] - anchor);
        const minW = Math.min(item.box[2] - item.box[0], last[2] - last[0]);
        // 左边缘相近直接归组；若某一行左侧误吞了图例短线导致左缘偏左但主体同列重合，也纳入同组等待众数纠偏。
        if ((distance <= leftTol || (item.box[0] < anchor && overlap >= minW * .55)) && distance < bestDistance) {
          bestDistance = distance;
          target = group;
        }
      }
      if (target) target.push(item);
      else groups.push([item]);
    }
    const updates = [];
    for (const group of groups) {
      if (group.length < 3) continue;
      const xs = group.map(item => item.box[0]);
      const sortedX = [...xs].sort((a, b) => a - b);
      const medianX0 = sortedX[Math.floor(sortedX.length / 2)];
      const sigma = Math.max(1.5, medianH * .12);
      let bestX0 = medianX0, bestScore = -1;
      for (const candidateX of new Set(xs)) {
        const score = xs.reduce((sum, x) => sum + Math.exp(-((x - candidateX) ** 2) / (2 * sigma * sigma)), 0);
        if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && Math.abs(candidateX - medianX0) < Math.abs(bestX0 - medianX0))) {
          bestScore = score;
          bestX0 = candidateX;
        }
      }
      const closeCount = xs.filter(x => Math.abs(x - bestX0) <= Math.max(4, medianH * .35)).length;
      if (closeCount < Math.ceil(group.length * .6)) continue;
      const members = group.filter(item => item.box[0] <= bestX0 + leftTol
        && item.box[2] - bestX0 >= Math.max(8, (item.box[2] - item.box[0]) * .4));
      if (members.length < 3) continue;
      const alignedBoxes = members.map(item => [bestX0, item.box[1], Math.max(bestX0 + 8, item.box[2]), item.box[3]]);
      for (let i = 0; i + 1 < alignedBoxes.length; i++) {
        if (alignedBoxes[i][3] > alignedBoxes[i + 1][1]) {
          const mid = (alignedBoxes[i][3] + alignedBoxes[i + 1][1]) / 2;
          if (mid - .25 - alignedBoxes[i][1] >= Math.max(4, medianH * .55)
            && alignedBoxes[i + 1][3] - (mid + .25) >= Math.max(4, medianH * .55)) {
            alignedBoxes[i][3] = mid - .25;
            alignedBoxes[i + 1][1] = mid + .25;
          }
        }
      }
      const unifiedFontSize = Math.min(...members.map((item, i) => {
        const oldH = Math.max(1, item.box[3] - item.box[1]);
        const newH = Math.max(1, alignedBoxes[i][3] - alignedBoxes[i][1]);
        return item.fontSize * Math.min(1, newH / oldH);
      }));
      members.forEach((item, i) => {
        updates.push({
          index: item.index,
          box: alignedBoxes[i],
          align: "flex-start",
          fontSize: unifiedFontSize
        });
      });
    }
    return updates;
  }

  const MERGED_LEGEND_RE = /^(.+?[A-Za-z\u3400-\u9fff][^\r\n]*?)\s*(?:-{2,}|–{2,}|—+|─+|━+|\.{3,}|…+)\s*([^\r\n]*?[A-Za-z\u3400-\u9fff].*)$/;

  function splitMergedImageLabel(pixels, width, height, box, sourceText, translatedText = sourceText) {
    if (!pixels || !(width > 0 && height > 0) || !validBox(box)) return null;
    const srcMatch = MERGED_LEGEND_RE.exec(String(sourceText || "").trim());
    const trMatch = MERGED_LEGEND_RE.exec(String(translatedText || "").trim());
    if (!srcMatch || !trMatch) return null;
    const px0 = Math.max(0, Math.floor(box[0] * width)), py0 = Math.max(0, Math.floor(box[1] * height));
    const px1 = Math.min(width, Math.ceil(box[2] * width)), py1 = Math.min(height, Math.ceil(box[3] * height));
    const bw = px1 - px0, bh = py1 - py0;
    if (bw < 24 || bh < 8) return null;
    const neutralCols = new Uint8Array(bw);
    for (let x = 0; x < bw; x++) {
      let dark = 0;
      for (let y = py0; y < py1; y++) {
        const at = (y * width + px0 + x) * 4;
        if (pixels[at + 3] < 250) continue;
        const r = pixels[at], g = pixels[at + 1], b = pixels[at + 2];
        if (Math.max(r, g, b) < 180 && Math.max(r, g, b) - Math.min(r, g, b) < 40) dark++;
      }
      if (dark > 0) neutralCols[x] = 1;
    }
    let firstInk = -1, lastInk = -1;
    for (let x = 0; x < bw; x++) if (neutralCols[x]) { if (firstInk < 0) firstInk = x; lastInk = x; }
    if (firstInk < 0 || lastInk - firstInk < 20) return null;
    // 寻找中间不含深灰/黑文字笔画、仅余底色或彩色图例线的最宽空隙作为分栏裂点。
    let bestStart = -1, bestLen = 0, runStart = -1;
    for (let x = firstInk; x <= lastInk; x++) {
      if (!neutralCols[x]) {
        if (runStart < 0) runStart = x;
      } else {
        if (runStart >= 0 && x - runStart > bestLen) { bestStart = runStart; bestLen = x - runStart; }
        runStart = -1;
      }
    }
    const minGap = Math.max(10, Math.round(bh * .55));
    if (bestStart < 0 || bestLen < minGap) return null;
    const gapEnd = bestStart + bestLen;
    if (bestStart - firstInk < 8 || lastInk - gapEnd + 1 < 8) return null;
    const leftBox = [Math.max(0, px0 + firstInk - 3) / width, box[1], Math.min(width, px0 + bestStart + 2) / width, box[3]];
    const rightBox = [Math.max(0, px0 + gapEnd - 2) / width, box[1], Math.min(width, px0 + lastInk + 4) / width, box[3]];
    if (!validBox(leftBox) || !validBox(rightBox)) return null;
    return [
      { bbox: leftBox, sourceText: srcMatch[1].trim(), text: trMatch[1].trim() },
      { bbox: rightBox, sourceText: srcMatch[2].trim(), text: trMatch[2].trim() }
    ];
  }

  function splitMergedLegendLines(lines, pixels, width, height) {
    return (Array.isArray(lines) ? lines : []).flatMap(line => {
      if (!line || line.rotation || !validBox(line.bbox)) return [line];
      const parts = splitMergedImageLabel(pixels, width, height, line.bbox, line.text, line.text);
      if (!parts) return [line];
      return parts.map(part => ({ ...line, text: part.text, bbox: part.bbox }));
    });
  }

  L.LayoutImages = { extract, ocrLineFromPolygon, linesFromOCR, linesFromMinerU, imageTextCandidates, planImageOCRSheets, planPaddleImageSheets, mapPaddleSheetLines, mapPackedImageLines, mergeImageLines, filterRotatedDetections, isColoredCurveCandidate, recognizeLocalImageText, mergeAdjacentRotatedWords, normalizeImageLines, restoreImageLabel, restoreRotatedImageLabel, applyRestoredImageLabel, planAlignedImageLabelGroups, splitMergedImageLabel, splitMergedLegendLines, requestPlan, cacheFromRecords, cachedRecords, attach, mineruUseLocalOCR: MINERU_USE_LOCAL_OCR, resolveImageOCRMode, resolveImageOCRModel };
  L.ImageTranslationService = ImageTranslationService;
})(this);
