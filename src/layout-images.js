(function (global) {
  "use strict";
  const L = global.LitMTrans = global.LitMTrans || {};
  const U = L.Utils;
  const validBox = box => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1];
  const fingerprint = layout => U.hashString(layout.rawText || "");

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

  function linesFromOCR(result, info) {
    const raw = result?.prunedResult;
    if (!(info?.width > 0 && info?.height > 0) || !Array.isArray(raw?.rec_texts)
      || !Array.isArray(raw.rec_polys) || raw.rec_texts.length !== raw.rec_polys.length) return [];
    return raw.rec_texts.flatMap((text, index) => {
      const score = Number(raw.rec_scores?.[index]);
      const polygon = raw.rec_polys[index];
      if (!(score >= .85) || typeof text !== "string" || !text.trim() || !Array.isArray(polygon)
        || polygon.length !== 4 || polygon.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) return [];
      const xs = polygon.map(point => point[0] / info.width), ys = polygon.map(point => point[1] / info.height);
      const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (!validBox(bbox) || bbox.some(value => value < 0 || value > 1)) return [];
      // 只覆盖近似水平的单行，旋转文字保持原图。
      if (Math.abs(polygon[1][1] - polygon[0][1]) > (bbox[3] - bbox[1]) * info.height * .15) return [];
      return [{ text: text.trim(), bbox, score }];
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

  function planImageOCRSheets(inputs) {
    const sheets = [];
    const cells = inputs.flatMap((input, index) => input.packing.mapping.map(row => ({
      input: index, source: row.source, from: row.packed,
      width: row.packed[2] - row.packed[0], height: row.packed[3] - row.packed[1]
    }))).filter(cell => cell.width > 0 && cell.height > 0 && cell.width <= 664 && cell.height <= 952)
      .sort((a, b) => b.height - a.height || b.width - a.width);
    let sheet, left = 24, top = 24, rowHeight = 0;
    for (const cell of cells) {
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
          && overlap / ((box[2] - box[0]) * (box[3] - box[1])) >= .95;
      });
      if (cells.length !== 1) continue;
      const cell = cells[0], b = cell.box;
      const normalized = box.map((value, axis) => Math.max(0, Math.min(1, (value - b[axis % 2]) / (b[axis % 2 + 2] - b[axis % 2]))));
      if (validBox(normalized)) mapped.get(cell.input).push({ ...line, bbox: normalized });
    }
    return mapped;
  }

  function imageTextCandidates(pixels, width, height) {
    if (!(width > 0 && height > 0) || width * height > 2400000 || pixels.length !== width * height * 4) return { boxes: [] };
    const size = width * height, ink = new Uint8Array(size), mask = new Uint8Array(size), queue = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      const p = i * 4;
      ink[i] = pixels[p + 3] >= 250 && pixels[p] * .299 + pixels[p + 1] * .587 + pixels[p + 2] * .114 < 190 ? 1 : 0;
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
          if (y) joined[(y - 1) * width + center] = 1;
          if (y + 1 < height) joined[(y + 1) * width + center] = 1;
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
      const mapped = box.map((value, i) => source[i % 2] + Math.max(0, Math.min(packed[i % 2 + 2] - packed[i % 2], value - packed[i % 2])));
      if (!validBox(mapped)) return [];
      return [{ ...line, bbox: mapped.map((value, i) => value / packing.sourceSize[i % 2]) }];
    });
    // 相邻行框重叠时不覆盖，尤其不能擦到旁边保留原文的数值或公式。
    return mapped.filter((line, index) => !mapped.some((other, i) => i !== index && imageLineOverlap(line.bbox, other.bbox) > .02));
  }

  function mergeImageLines(original, extra) {
    const lines = [...original];
    for (const line of extra) {
      const overlaps = lines.some(existing => imageLineOverlap(line.bbox, existing.bbox) > .02);
      if (!overlaps) lines.push(line);
    }
    return lines;
  }

  function repairImageLabelBackground(pixels, width, left, top, w, h, accepted, chosen, foreground, background) {
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
      if (!accepted[i] && Math.max(...inkColor.map((value, c) => Math.abs(values[i * 3 + c] - value))) < 38) blocked[i] = 1;
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

  function restoreImageLabel(pixels, width, height, box, protectedBoxes = [], sourceText = "") {
    if (!validBox(box) || protectedBoxes.some(other => validBox(other) && imageLineOverlap(box, other) > .02)) return null;
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
    const edge = y => Array.from({ length: w }, (_, x) => {
      const samples = [];
      for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 1; dy++) samples.push(sample(left + x + dx, y + dy));
      return [0, 1, 2].map(channel => median(samples.map(rgb => rgb[channel])));
    });
    const upper = edge(top - 2), lower = edge(bottom + 1);
    const background = new Uint8ClampedArray(size * 3), mask = new Uint8Array(size), chosen = new Uint8Array(size), graphics = new Uint8Array(size), queue = new Uint32Array(size);
    const protectedPixel = (x, y) => protectedBoxes.some(b => x >= b[0] * width - 1 && x <= b[2] * width + 1 && y >= b[1] * height - 1 && y <= b[3] * height + 1);
    let totalInk = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (pixels[((top + y) * width + left + x) * 4 + 3] < 250) return null;
      const index = y * w + x, rgb = sample(left + x, top + y), t = (y + 1) / (h + 1);
      let difference = 0;
      for (let c = 0; c < 3; c++) { const value = upper[x][c] * (1 - t) + lower[x][c] * t; background[index * 3 + c] = value; difference = Math.max(difference, Math.abs(rgb[c] - value)); }
      if (difference > 38 && !protectedPixel(left + x, top + y)) { mask[index] = 1; totalInk++; }
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
      if (tail >= 2 && cw <= expected * .45 && ch <= expected * .45) {
        fragments.push({ box: [x0, y0, x1, y1], indices: queue.slice(0, tail) });
      }
      // 长引线与跨出文字区域的图形保留；只擦除接近字高的小笔画连通域。
      const graphic = ch > expected * 1.3 || tail > size * .35
        || (cw > Math.max(ch * 3, expected * 1.4) && ch < expected * .5)
        || (ch > cw * 5 && (y0 === 0 || y1 === h));
      if (graphic) { for (let i = 0; i < tail; i++) graphics[queue[i]] = 1;continue; }
      if (tail < 3 || ch < Math.max(4, expected * .24)) continue;
      components.push([x0, y0, x1, y1]);
      for (let i = 0; i < tail; i++) chosen[queue[i]] = 1;
    }
    const letters = (String(sourceText).match(/[A-Za-z\u3400-\u9fff]/g) || []).length;
    if (components.length < Math.max(1, Math.min(4, Math.floor(letters * .3)))) return null;
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
        if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h || protectedPixel(left + x + dx, top + y + dy)) continue;
        const i = (y + dy) * w + x + dx, rgb = sample(left + x + dx, top + y + dy);
        if (!graphics[i] && rgb.some((value, channel) => Math.abs(value - background[i * 3 + channel]) > 8)) accepted[i] = 1;
      }
    }
    const x0 = Math.max(0, Math.min(...components.map(b => b[0])) - 3), y0 = Math.max(0, Math.min(...components.map(b => b[1])) - 3);
    const x1 = Math.min(w, Math.max(...components.map(b => b[2])) + 3), y1 = Math.min(h, Math.max(...components.map(b => b[3])) + 3);
    if (x1 <= x0 || y1 <= y0) return null;
    repairImageLabelBackground(pixels, width, left, top, w, h, accepted, chosen, foreground, background);
    const patch = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4), colors = [[], [], []];
    let changed = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const index = y * w + x, at = ((y - y0) * (x1 - x0) + x - x0) * 4, rgb = sample(left + x, top + y);
      for (let c = 0; c < 3; c++) patch[at + c] = accepted[index] ? background[index * 3 + c] : rgb[c];
      patch[at + 3] = 255;
      if (accepted[index]) changed++;
      if (chosen[index] && rgb.some((value, c) => Math.abs(value - background[index * 3 + c]) > 100)) for (let c = 0; c < 3; c++) colors[c].push(rgb[c]);
    }
    return { pixels: patch, width: x1 - x0, height: y1 - y0, box: [left + x0, top + y0, left + x1, top + y1],
      color: colors.every(values => values.length) ? colors.map(median) : [20, 20, 20], changed };
  }

  function requestPlan(ocr, layout, machine = false, reserved = new Set()) {
    const images = [], records = [];
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
      if (!grid.cells.some(cell => cell.translate)) continue;
      const imageFingerprint = U.hashString(JSON.stringify(figure));
      let id = `img${index}_${ocr.sourceFingerprint}_${imageFingerprint}`;
      while (reserved.has(id) || grid.cells.some(cell => reserved.has(`${id}c${cell.index}`))) id = `_${id}`;
      const image = { ...figure, ...grid, requestID: id, fingerprint: imageFingerprint };
      images.push(image);
      const cells = grid.cells.filter(cell => cell.translate);
      if (machine) records.push(...cells.map(cell => ({ id: `${id}c${cell.index}`, page: figure.page + 1, type: "image_label", text: cell.text })));
      else {
        let wireID = `I${images.length}`;
        while (reserved.has(wireID)) wireID = `_${wireID}`;
        records.push({ id, wireID, page: figure.page + 1, type: "image_labels", cells: cells.map(cell => [cell.index, cell.text]), text: JSON.stringify(cells.map(cell => [cell.index, cell.text])) });
      }
    }
    return { images, records, machine, parseRevisionID: ocr.parseRevisionID || "", ids: new Set(records.map(record => record.id)) };
  }

  function cacheFromRecords(plan, translations, sourceFingerprint, targetLanguage) {
    const shared = L.LayoutTables.cacheFromRecords({ ...plan, tables: plan.images }, translations, sourceFingerprint, targetLanguage);
    return { version: 1, sourceFingerprint, parseRevisionID: plan.parseRevisionID || "", targetLanguage, images: shared.tables };
  }

  function cachedRecords(plan, cache, sourceFingerprint) {
    if (cache && !Array.isArray(cache.images)) return {};
    if ((cache?.parseRevisionID || "") !== (plan.parseRevisionID || "")) return {};
    return L.LayoutTables.cachedRecords({ ...plan, tables: plan.images }, cache ? { ...cache, tables: cache.images } : null, sourceFingerprint);
  }

  function attach(model, cache, parseRevisionID = "", layout = null) {
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
    if (!active && !model.imageTranslationHash && !furniture.some(boxes => boxes.size)) return model;
    const { imageTranslationHash: _previous, ...base } = model;
    const apply = (block, page) => {
      const { translatedImageLabels: _labels, imageProtectedBoxes: _protected, ...clean } = block;
      if (isPageFurniture(block) || furniture[page]?.has(JSON.stringify(block.bbox))) return { ...clean, sourceOnly: true };
      if (!active || !["image", "image_body", "chart", "chart_body"].includes(block.type)) return clean;
      const matches = cache.images.filter(image => image?.page === page && JSON.stringify(image.bbox) === JSON.stringify(block.bbox));
      if (matches.length !== 1) return clean;
      const image = matches[0];
      try {
        const html = L.LayoutTables.render(image, image.translations);
        const labels = image.cells.filter(cell => cell.translate).map(cell => {
          let text = image.translations[cell.index];
          for (const token of cell.tokens) text = text.replace(token.marker, () => token.source);
          return { bbox: image.lines[cell.index].bbox, text, sourceText: image.lines[cell.index].text };
        });
        if (!html || labels.some(label => !validBox(label.bbox))) return clean;
        return { ...clean, translatedImageLabels: labels, imageProtectedBoxes: image.cells.filter(cell => !cell.translate).map(cell => image.lines[cell.index].bbox) };
      } catch (_) { return clean; }
    };
    return { ...base, ...(active ? { imageTranslationHash: U.hashString(`image-render-centered-v10|${JSON.stringify(cache)}`) } : {}), pages: model.pages.map((page, index) => ({
      ...page, blocks: (page.blocks || []).map(block => apply(block, index)), restoration: page.restoration ? {
        ...page.restoration, absoluteBlocks: (page.restoration.absoluteBlocks || []).map(block => apply(block, index))
      } : page.restoration
    })) };
  }

  class ImageTranslationService {
    constructor(storage, paddle, mineru = null) { this.storage = storage; this.paddle = paddle; this.mineru = mineru; this.pending = new Map(); }

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

    async packImageText(bytes, png, signal) {
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
        const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
        const source = canvas(width, height), ctx = source.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0, width, height);
        const ink = ctx.getImageData(0, 0, width, height);
        const { boxes } = imageTextCandidates(ink.data, width, height);
        if (!boxes.length) return null;
        // 掩膜只用于定位；识别副本保留原始灰度笔画，避免连在线上的字母被一起删除。
        for (let i = 0; i < ink.data.length; i += 4) {
          const gray = Math.round(ink.data[i] * .299 + ink.data[i + 1] * .587 + ink.data[i + 2] * .114);
          ink.data[i] = ink.data[i + 1] = ink.data[i + 2] = gray;
        }
        ctx.putImageData(ink, 0, 0);
        const mapping = [];
        let top = 16;
        for (const box of boxes) {
          const h = box[3] - box[1];
          // 定位掩膜可能丢掉与图线相连的词首，识别裁片按字高补足横向上下文。
          const sourceBox = [Math.max(0, box[0] - h), box[1], Math.min(width, box[2] + h), box[3]];
          const w = sourceBox[2] - sourceBox[0];
          if (top + h + 16 > 2400) break;
          mapping.push({ source: sourceBox, packed: [20, top, 20 + w, top + h] }); top += h + 20;
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

    async recognizeSharedImageText(inputs, token, signal, emit) {
      const sheets = planImageOCRSheets(inputs), result = inputs.map(() => []);
      for (let offset = 0; offset < sheets.length; offset += 20) {
        U.throwIfAborted(signal);
        const group = sheets.slice(offset, offset + 20), pdf = await global.PDFLib.PDFDocument.create(), embedded = new Map();
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
        emit?.({ type: "status", message: `正在识别图片文字：${inputs.length} 张图片，当前 ${offset + 1}–${offset + group.length}/${sheets.length} 页文字裁片` });
        const pages = await this.recognizeMinerU(await pdf.save(), group.length, token, signal, emit);
        for (let page = 0; page < group.length; page++) {
          const sheet = group[page];
          for (const index of new Set(sheet.cells.map(cell => cell.input))) {
            const mapping = sheet.cells.filter(cell => cell.input === index).map(cell => ({ source: cell.source, packed: cell.packed }));
            result[index].push(...mapPackedImageLines(pages[page], { size: sheet.size, sourceSize: inputs[index].packing.sourceSize, mapping }));
          }
        }
      }
      return result;
    }

    async collectMinerUFigures(documentID, figures, assets, cached, token, signal, emit, missingOnly = false) {
      const inputs = [], images = [];
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
          const packing = await this.packImageText(bytes, png, signal);
          if (packing) inputs.push({ image: images.length - 1, packing });
        } catch (error) { U.throwIfAborted(signal); if (error.cancelled) throw error; }
      }
      if (inputs.length) {
        const recognized = await this.recognizeSharedImageText(inputs, token, signal, emit);
        inputs.forEach((input, index) => { images[input.image].lines = mergeImageLines(images[input.image].lines, recognized[index]); });
      }
      return images;
    }

    async ensure(documentID, layout, signal, emit, options = {}) {
      const meta = await this.storage.getDocumentMeta(documentID);
      const provider = String(options.parseProvider || meta?.parseProvider || U.getPref("parseProvider", "mineru"));
      const key = `${documentID}:${fingerprint(layout)}:${provider}`;
      if (this.pending.has(key)) return this.pending.get(key);
      const task = this.collect(documentID, layout, signal, emit, { parseProvider: provider }).finally(() => this.pending.delete(key));
      this.pending.set(key, task);
      return task;
    }

    async collect(documentID, layout, signal, emit, options = {}) {
      const sourceFingerprint = fingerprint(layout), path = this.storage.path(documentID, "image-ocr.v1.json");
      const parseRevisionID = (await this.storage.getDocumentMeta(documentID))?.parseRevisionID || "";
      const cached = await this.storage.readJSON(path, null);
      const validCache = cached?.version === 1 && cached.sourceFingerprint === sourceFingerprint
        && (cached.parseRevisionID || "") === parseRevisionID && Array.isArray(cached.images);
      const canPack = Boolean(Zotero.getMainWindow?.()?.Image);
      const provider = options.parseProvider || "mineru";
      const providerModel = provider === "paddle" ? "PP-OCRv6" : "mineru-pipeline";
      const supplement = validCache && cached.model !== providerModel && cached.images.some(image => !image.lines?.length);
      const mineruToken = provider === "mineru" ? this.mineru?.secrets?.getMinerUToken() : "";
      const missingOnly = validCache && ["text-crops-v1", "shared-text-crops-v2"].includes(cached.strategy)
        && cached.images.some(image => !image.lines?.length);
      const upgrade = provider === "mineru" && validCache && cached.model === "mineru-pipeline"
        && (!cached.strategy || missingOnly) && mineruToken && canPack;
      if (validCache && !upgrade && !supplement) return cached;
      const figures = extract(layout), result = { version: 1, sourceFingerprint, parseRevisionID, model: providerModel, images: [] };
      if (!figures.length) return result;
      const token = provider === "paddle" ? this.paddle?.secrets?.getPaddleToken() : "";
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
          inputs.push({ image, width: image.width, height: image.height });batch.push(figure);
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
            page.drawImage(inputs[input].image, { x: box[0] * .5, y: (sheet.size[1] - box[3]) * .5,
              width: (box[2] - box[0]) * .5, height: (box[3] - box[1]) * .5 });
          }
        }
        const recognized = batch.map(() => []);
        const requests = sheets.length ? await this.paddleImageRequests(pdf, sheets) : [];
        for (const [index, request] of requests.entries()) {
          U.throwIfAborted(signal);
          emit?.({ type: "status", message: `正在识别图片文字：${batch.length} 张图片，共 ${sheets.length} 页${requests.length > 1 ? `，第 ${index + 1}/${requests.length} 个任务` : ""}` });
          const task = await this.paddle.submit(request.bytes, "PP-OCRv6", token, signal,
            { useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false,
              textDetLimitSideLen: 2000, textDetLimitType: "max", visualize: false });
          const url = await this.paddle.poll(task, token, async () => {}, { timeoutSeconds: 600 }, imageOCRProgressEmitter(emit), signal);
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
        batch.forEach((figure, index) => result.images.push({ ...figure, lines: recognized[index] }));
      }
      if (token) result.strategy = "full-image-sheets-v1";
      result.images.sort((a, b) => figures.findIndex(figure => figure.id === a.id) - figures.findIndex(figure => figure.id === b.id));
      U.throwIfAborted(signal);
      if (U.hashString(await this.storage.readText(this.storage.path(documentID, "layout.json"), "")) !== sourceFingerprint) return null;
      if (((await this.storage.getDocumentMeta(documentID))?.parseRevisionID || "") !== parseRevisionID) return null;
      await this.storage.writeTextAtomically(path, JSON.stringify(result));
      return result;
    }
  }

  L.LayoutImages = { extract, linesFromOCR, linesFromMinerU, imageTextCandidates, planImageOCRSheets, planPaddleImageSheets, mapPaddleSheetLines, mapPackedImageLines, mergeImageLines, restoreImageLabel, requestPlan, cacheFromRecords, cachedRecords, attach };
  L.ImageTranslationService = ImageTranslationService;
})(this);
