(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const H = LitMTrans.HTTP;
  const C = LitMTrans.Constants;

  const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp", ".svg"]);
  const MINERU_UPLOAD_PAGE_LIMIT = 200;
  const MINERU_SPLIT_SEARCH_RADIUS = 20;

  function mineruBoundaryScore(previousText, nextText) {
    const previous = String(previousText || "").replace(/\s+/g, " ").trim();
    const next = String(nextText || "").split(/\r?\n/)
      .map(line => line.replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
    let score = 0;
    if (previous && /[.!?。！？）)\]】”’]\s*$/.test(previous)) score += 2;
    if (next) {
      if (
        next.length <= 100
        && /^(?:chapter|section|part|appendix|第[一二三四五六七八九十百\d]+[章节篇部]|\d+(?:\.\d+){0,4}\s+\S)/i.test(next)
      ) score += 6;
      else if (next.length <= 70 && next.toUpperCase() === next && /[A-Z]/.test(next)) score += 3;
      if (/^[a-z,;:，；：]/.test(next)) score -= 3;
    }
    const joined = `${previous.slice(-160)} ${next.slice(0, 160)}`.toLowerCase();
    if (/\b(?:continued|cont\.?|续表|接上页|下接)\b/.test(joined)) score -= 8;
    return score;
  }

  function chooseMinerUSplitEnd(start, pageCount, pageTexts = [], limit = MINERU_UPLOAD_PAGE_LIMIT) {
    const hardEnd = Math.min(pageCount, start + limit);
    if (hardEnd >= pageCount) return pageCount;
    // Never choose a prettier boundary that would create an avoidable extra
    // upload part; preserving the minimum number of parts keeps long uploads
    // within the service limits.
    const remainingPartCount = Math.ceil((pageCount - hardEnd) / limit);
    const minimumEnd = Math.max(
      start + 1,
      hardEnd - MINERU_SPLIT_SEARCH_RADIUS,
      pageCount - remainingPartCount * limit
    );
    const maximumEnd = hardEnd;
    let bestEnd = hardEnd;
    let bestScore = -Infinity;
    for (let end = minimumEnd; end <= maximumEnd; end++) {
      const score = mineruBoundaryScore(pageTexts[end - 1], pageTexts[end]);
      if (score > bestScore || (score === bestScore && end > bestEnd)) {
        bestScore = score;
        bestEnd = end;
      }
    }
    return bestEnd;
  }

  function planMinerUPageRanges(pageCount, pageTexts = [], limit = MINERU_UPLOAD_PAGE_LIMIT) {
    const total = Math.max(0, Math.trunc(Number(pageCount) || 0));
    const ranges = [];
    for (let start = 0; start < total;) {
      const end = chooseMinerUSplitEnd(start, total, pageTexts, limit);
      if (end <= start || end - start > limit) throw new Error("MinerU PDF拆分页码规划无效");
      ranges.push({ start, end, pageCount: end - start });
      start = end;
    }
    return ranges;
  }

  function rebaseMinerUPayload(value, pageOffset, assetMap) {
    if (Array.isArray(value)) return value.map(item => rebaseMinerUPayload(item, pageOffset, assetMap));
    if (!value || typeof value !== "object") {
      if (typeof value !== "string") return value;
      const key = normalizeAssetKey(value);
      return assetMap[key] || assetMap[normalizeAssetKey(basename(key))] || value;
    }
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if ((key === "page_idx" || key === "page_index") && Number.isFinite(Number(child))) {
        output[key] = Number(child) + pageOffset;
      }
      else output[key] = rebaseMinerUPayload(child, pageOffset, assetMap);
    }
    return output;
  }

  function mergedMinerUJSON(payloads, preferredArrayKey = "") {
    const present = payloads.filter(value => value !== null && value !== undefined);
    if (!present.length) return null;
    if (present.every(Array.isArray)) return present.flat();
    if (preferredArrayKey && present.every(value => Array.isArray(value?.[preferredArrayKey]))) {
      return { ...present[0], [preferredArrayKey]: present.flatMap(value => value[preferredArrayKey]) };
    }
    if (present.every(value => Array.isArray(value?.pages))) {
      return { ...present[0], pages: present.flatMap(value => value.pages) };
    }
    return present[0];
  }

  function normalizeAssetKey(value) {
    let key = String(value || "").trim().replace(/^<|>$/g, "");
    try { key = decodeURIComponent(key); }
    catch (_) {}
    key = key.replace(/\\/g, "/").replace(/^\.\//, "").split(/[?#]/)[0].toLowerCase();
    return key;
  }

  function basename(path) {
    return String(path || "").replace(/\\/g, "/").split("/").pop() || "";
  }

  function localMarkdownImageTargets(markdown) {
    const targets = [];
    const pattern = /!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gs;
    for (const match of String(markdown || "").matchAll(pattern)) {
      const target = String(match[1] || "").replace(/^<|>$/g, "").trim();
      // Remote URLs are deliberately not fetched by the plugin.  MinerU's
      // relative image paths, however, must have a local extracted asset.
      if (target && !/^(?:data:|[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) targets.push(target);
    }
    return [...new Set(targets)];
  }

  function zipU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function zipU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function zipU64(bytes, offset) {
    const low = zipU32(bytes, offset);
    const high = zipU32(bytes, offset + 4);
    const value = high * 0x100000000 + low;
    if (!Number.isSafeInteger(value)) throw new Error("ZIP64 数值超过JavaScript安全整数范围");
    return value;
  }

  function zipCRC32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // A deliberately small ZIP reader for the portable fallback below.  It
  // covers MinerU's normal ZIP entries (stored or raw-DEFLATE) without asking
  // Windows/macOS/Linux to provide an external archive program.
  function readPortableZip(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let eocd = -1;
    for (let offset = Math.max(0, data.length - 0x10016); offset <= data.length - 22; offset++) {
      if (zipU32(data, offset) === 0x06054b50) eocd = offset;
    }
    if (eocd < 0) throw new Error("未找到ZIP中央目录");
    let entryCount = zipU16(data, eocd + 10);
    let directoryOffset = zipU32(data, eocd + 16);
    if (entryCount === 0xffff || directoryOffset === 0xffffffff || zipU32(data, eocd + 12) === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || zipU32(data, locator) !== 0x07064b50) throw new Error("ZIP64 中缺少中央目录定位器");
      const zip64EOCD = zipU64(data, locator + 8);
      if (zipU32(data, zip64EOCD) !== 0x06064b50) throw new Error("ZIP64 中央目录记录已损坏");
      entryCount = zipU64(data, zip64EOCD + 32);
      directoryOffset = zipU64(data, zip64EOCD + 48);
    }

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const entries = new Map();
    let offset = directoryOffset;
    for (let index = 0; index < entryCount; index++) {
      if (zipU32(data, offset) !== 0x02014b50) throw new Error("ZIP中央目录已损坏");
      const flags = zipU16(data, offset + 8);
      const method = zipU16(data, offset + 10);
      const crc = zipU32(data, offset + 16);
      let compressedSize = zipU32(data, offset + 20);
      let uncompressedSize = zipU32(data, offset + 24);
      const nameLength = zipU16(data, offset + 28);
      const extraLength = zipU16(data, offset + 30);
      const commentLength = zipU16(data, offset + 32);
      let localOffset = zipU32(data, offset + 42);
      const extraStart = offset + 46 + nameLength;
      const extraEnd = extraStart + extraLength;
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        let extraOffset = extraStart;
        while (extraOffset + 4 <= extraEnd) {
          const fieldID = zipU16(data, extraOffset);
          const fieldSize = zipU16(data, extraOffset + 2);
          const fieldEnd = extraOffset + 4 + fieldSize;
          if (fieldEnd > extraEnd) break;
          if (fieldID === 0x0001) {
            let valueOffset = extraOffset + 4;
            if (uncompressedSize === 0xffffffff) { uncompressedSize = zipU64(data, valueOffset); valueOffset += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = zipU64(data, valueOffset); valueOffset += 8; }
            if (localOffset === 0xffffffff) localOffset = zipU64(data, valueOffset);
            break;
          }
          extraOffset = fieldEnd;
        }
      }
      const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
      entries.set(name, { flags, method, crc, compressedSize, uncompressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return { data, entries };
  }

  function readPortableZipEntry(archive, entryName) {
    const entry = archive.entries.get(entryName);
    if (!entry) throw new Error("ZIP中找不到该文件");
    if (entry.flags & 1) throw new Error("ZIP条目已加密");
    const { data } = archive;
    const { flags, method, crc, compressedSize, uncompressedSize, localOffset } = entry;
    if (zipU32(data, localOffset) !== 0x04034b50) throw new Error("ZIP本地文件头已损坏");
    const dataOffset = localOffset + 30 + zipU16(data, localOffset + 26) + zipU16(data, localOffset + 28);
    const compressed = data.subarray(dataOffset, dataOffset + compressedSize);
    if (compressed.length !== compressedSize) throw new Error("ZIP条目数据不完整");
    let output;
    if (method === 0) output = new Uint8Array(compressed);
    else if (method === 8 && global.pako?.inflateRaw) output = global.pako.inflateRaw(compressed);
    else if (method === 8) throw new Error("内置 DEFLATE 解码器未加载");
    else throw new Error(`不支持的ZIP压缩方法: ${method}`);
    if (output.length !== uncompressedSize) throw new Error("ZIP解压后的文件大小不匹配");
    if (!(flags & 8) && zipCRC32(output) !== crc) throw new Error("ZIP文件校验失败");
    return output;
  }

  function dataURIExtension(header) {
    const mime = String(header || "").split(";", 1)[0].replace(/^data:/, "").toLowerCase();
    const map = {
      "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
      "image/gif": ".gif", "image/svg+xml": ".svg", "image/bmp": ".bmp"
    };
    return map[mime] || ".bin";
  }

  function extensionFromTarget(target) {
    let value = String(target || "").trim().replace(/^<|>$/g, "");
    try {
      const parsed = new URL(value, "http://mineru.invalid/");
      value = parsed.pathname || value;
    }
    catch (_) {
      value = value.split(/[?#]/, 1)[0];
    }
    try { value = decodeURIComponent(value); }
    catch (_) {}
    const extension = U.extension(value);
    return extension && extension.length <= 8 ? extension : ".png";
  }

  function decodeBase64(value) {
    const binary = U.base64Decode(String(value || "").replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  class MinerUService {
    constructor(storage, secrets) {
      this.storage = storage;
      this.secrets = secrets;
    }

    async queryQuota(token, signal) {
      try {
        const result = await H.requestJSON("GET", `${C.MINERU_API_BASE}/quota`, {
          token,
          timeout: 30000,
          signal
        });
        return result?.code === 0 && result?.data && typeof result.data === "object" ? result.data : null;
      }
      catch (_) {
        return null;
      }
    }

    buildDataID(filePath) {
      const stem = U.safeStem(basename(filePath).replace(/\.[^.]+$/, ""), 110, "document");
      return `${stem}-${U.randomID("").replace(/^-/, "").slice(-8)}`.slice(0, 128);
    }

    shortUploadName(filePath) {
      const extension = U.extension(filePath);
      const digest = U.hashString(String(filePath || "")).slice(0, 10);
      const stemBudget = Math.max(8, 48 - digest.length - 1);
      const stem = U.safeStem(basename(filePath).replace(/\.[^.]+$/, ""), stemBudget, "document");
      return `${stem}-${digest}${extension}`;
    }

    async submit(filePath, options, token, signal) {
      const suffix = U.extension(filePath);
      const uploadName = this.shortUploadName(filePath);
      const payload = {
        enable_formula: options.enableFormula !== false,
        enable_table: options.enableTable !== false,
        model_version: [".html", ".htm"].includes(suffix) ? "MinerU-HTML" : (options.modelVersion || "vlm"),
        files: [{
          name: uploadName,
          is_ocr: Boolean(options.isOCR),
          data_id: this.buildDataID(filePath)
        }]
      };
      const result = await H.requestJSON("POST", `${C.MINERU_API_BASE}/file-urls/batch`, {
        token,
        json: payload,
        timeout: 60000,
        signal
      });
      if (result?.code !== 0) throw new Error(`无法创建文献解析任务：${result?.msg || "服务未返回具体原因"}`);
      const data = result?.data || {};
      const urls = data.file_urls;
      const first = Array.isArray(urls) ? urls[0] : urls;
      const uploadURL = typeof first === "string" ? first : first?.url;
      if (!data.batch_id || !uploadURL) throw new Error("文献解析服务返回的数据不完整，请稍后重试");
      return { batchID: String(data.batch_id), uploadURL: String(uploadURL), uploadName, payload };
    }

    async upload(uploadURL, filePath, signal, emit) {
      const bytes = await this.storage.readBytes(filePath);
      await H.retry(
        async attempt => {
          emit?.({ type: "progress", phase: "mineru-upload", progress: 18 + attempt * 2, message: attempt === 1 ? "正在上传附件到MinerU" : `正在重试上传（${attempt}/4）` });
          await H.uploadBytes(uploadURL, bytes, { timeout: 300000, signal });
        },
        {
          attempts: 4,
          signal,
          onRetry: error => emit?.({ type: "log", message: `上传暂时失败：${error.message}` })
        }
      );
    }

    async poll(batchID, options, token, signal, emit) {
      const started = Date.now();
      const timeoutMs = Number(options.timeoutSeconds || 1800) * 1000;
      let transientErrors = 0;
      while (Date.now() - started < timeoutMs) {
        U.throwIfAborted(signal);
        try {
          const result = await H.requestJSON("GET", `${C.MINERU_API_BASE}/extract-results/batch/${encodeURIComponent(batchID)}`, {
            token,
            timeout: 120000,
            signal
          });
          transientErrors = 0;
          if (result?.code !== 0) throw new Error(`无法获取文献解析进度：${result?.msg || "服务未返回具体原因"}`);
          let items = result?.data?.extract_result || result?.data?.extract_results || result?.data?.files || [];
          if (!Array.isArray(items)) items = items ? [items] : [];
          if (!items.length) {
            emit?.({ type: "progress", phase: "mineru-poll", progress: 48, message: "等待MinerU返回解析结果" });
            await U.sleep(Number(options.pollIntervalSeconds || 5) * 1000, signal);
            continue;
          }
          const item = items[0] || {};
          const state = String(item.state || item.status || "").toLowerCase();
          const zipURL = item.full_zip_url || item.zip_url || item.result_url;
          const progress = item.extract_progress;
          if (zipURL && (!state || ["done", "finished", "success"].includes(state))) return item;
          if (["failed", "fail", "error"].includes(state)) {
            const fatal = new Error(`文献解析失败：${item.err_msg || item.msg || "服务返回失败状态"}`);
            fatal.mineruFatal = true;
            throw fatal;
          }
          if (progress && typeof progress === "object") {
            const current = Number(progress.extracted_pages || 0);
            const total = Math.max(1, Number(progress.total_pages || 1));
            emit?.({
              type: "progress",
              phase: "mineru-poll",
              progress: Math.min(88, 28 + Math.round(current * 60 / total)),
              message: `MinerU解析中：${current}/${total} 页`
            });
          }
          else {
            emit?.({ type: "progress", phase: "mineru-poll", progress: 58, message: `MinerU解析状态：${state || "处理中"}` });
          }
        }
        catch (error) {
          if (error.cancelled || error.mineruFatal) throw error;
          transientErrors++;
          emit?.({ type: "log", message: `暂时无法获取解析进度，正在重试（${transientErrors}）：${error.message}` });
          await U.sleep(Math.min(5000 * transientErrors, 30000), signal);
          continue;
        }
        await U.sleep(Number(options.pollIntervalSeconds || 5) * 1000, signal);
      }
      throw new Error("文献解析等待时间过长，请稍后重试");
    }

    async downloadResult(resultItem, outputDir, signal, emit) {
      const zipURL = resultItem.full_zip_url || resultItem.zip_url || resultItem.result_url;
      if (!zipURL) throw new Error("文献解析服务未返回结果文件，请稍后重试");
      const zipPath = PathUtils.join(outputDir, "mineru-result.zip");
      const bytes = await H.retry(
        attempt => {
          emit?.({ type: "progress", phase: "mineru-download", progress: 92, message: attempt === 1 ? "正在下载MinerU解析结果" : `正在重新下载解析结果（${attempt}/5）` });
          return H.requestBytes(zipURL, { timeout: 180000, signal });
        },
        { attempts: 5, signal, shouldRetry: () => true, baseDelay: 3000 }
      );
      await this.storage.writeBytes(zipPath, bytes);
      return { zipPath, zipURL };
    }

    async extractZip(zipPath, extractDir) {
      await this.storage.remove(extractDir, true);
      await this.storage.ensureDir(extractDir);
      const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
      reader.open(U.createLocalFile(zipPath));
      try {
        const entries = reader.findEntries(null);
        const failures = [];
        while (entries.hasMore()) {
          const rawName = String(entries.getNext());
          const normalized = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
          const parts = normalized.split("/").filter(Boolean);
          if (!parts.length || parts.some(part => part === ".." || part.includes(":"))) continue;
          const destination = PathUtils.join(extractDir, ...parts);
          if (rawName.endsWith("/")) {
            await this.storage.ensureDir(destination);
            continue;
          }
          await this.storage.ensureDir(PathUtils.parent(destination));
          try { reader.extract(rawName, U.createLocalFile(destination)); }
          catch (error) { failures.push({ rawName, destination, error }); }
        }
        // nsIZipReader has a compatibility bug with a subset of valid MinerU
        // archives. This fallback uses an independent DEFLATE implementation
        // instead of the host ZIP reader.
        if (failures.length) {
          let archive;
          try { archive = readPortableZip(await this.storage.readBytes(zipPath)); }
          catch (error) { throw new Error(`无法读取MinerU解析结果：${error}`); }
          const unresolved = [];
          for (const failure of failures) {
            try { await this.storage.writeBytes(failure.destination, readPortableZipEntry(archive, failure.rawName)); }
            catch (error) { unresolved.push(`${failure.rawName}: 原生解压 ${failure.error}; 兼容解压 ${error}`); }
          }
          if (unresolved.length) {
            throw new Error(`MinerU结果压缩包有 ${unresolved.length} 个文件无法解压：${unresolved.slice(0, 3).join("；")}`);
          }
        }
      }
      finally {
        reader.close();
      }
    }

    async copyAssetFiles(extractDir, documentID, baseDir = null, options = {}) {
      const files = await this.storage.walk(extractDir);
      const targetRoot = baseDir || this.storage.documentDir(documentID);
      const assetsDir = PathUtils.join(targetRoot, "assets");
      if (options.reset !== false) await this.storage.remove(assetsDir, true);
      await this.storage.ensureDir(assetsDir);
      const map = {};
      const used = new Set();
      const prefix = String(options.namePrefix || "").replace(/[^A-Za-z0-9_-]/g, "");
      for (const source of files) {
        const ext = U.extension(source);
        if (!IMAGE_EXTENSIONS.has(ext)) continue;
        const relative = source.slice(extractDir.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
        const originalName = basename(source);
        let name = prefix + U.safeStem(originalName.replace(/\.[^.]+$/, ""), 70, "asset") + ext;
        if (used.has(name.toLowerCase())) name = `${U.safeStem(name.replace(/\.[^.]+$/, ""), 58)}-${U.hashString(relative).slice(0, 8)}${ext}`;
        used.add(name.toLowerCase());
        const destination = PathUtils.join(assetsDir, name);
        await this.storage.copyFile(source, destination);
        const stored = `assets/${name}`;
        for (const key of [normalizeAssetKey(relative), normalizeAssetKey(originalName), normalizeAssetKey(source)]) {
          if (key && !map[key]) map[key] = stored;
        }
      }
      if (options.writeMap !== false) await this.storage.writeJSON(PathUtils.join(targetRoot, "asset-map.json"), map);
      return map;
    }

    async simplifyMarkdownImages(markdown, documentID, assetMap, baseDir = null, options = {}) {
      const targetRoot = baseDir || this.storage.documentDir(documentID);
      const imagesDir = PathUtils.join(targetRoot, "images");
      if (options.reset !== false) await this.storage.remove(imagesDir, true);
      await this.storage.ensureDir(imagesDir);
      let counter = Math.max(0, Math.trunc(Number(options.imageIndexStart) || 0));
      const records = [];

      const resolveAsset = target => {
        const key = normalizeAssetKey(target);
        return assetMap[key] || assetMap[normalizeAssetKey(basename(key))] || "";
      };

      const processTarget = async (alt, target, title) => {
        counter++;
        const imageID = `IMAGE_${String(counter).padStart(3, "0")}`;
        let relative = "";
        let warning = "";
        try {
          if (/^data:image\//i.test(target) && target.includes(",")) {
            const [header, encoded] = target.split(/,(.*)/s);
            const ext = dataURIExtension(header);
            relative = `images/${imageID.toLowerCase()}${ext}`;
            await this.storage.writeBytes(PathUtils.join(targetRoot, ...relative.split("/")), decodeBase64(encoded));
          }
          else {
            const asset = resolveAsset(target);
            if (asset) {
              const ext = U.extension(asset) || ".png";
              relative = `images/${imageID.toLowerCase()}${ext}`;
              await this.storage.copyFile(
                PathUtils.join(targetRoot, ...asset.split("/")),
                PathUtils.join(targetRoot, ...relative.split("/"))
              );
            }
            else {
              warning = `未找到图片资源: ${target}`;
              relative = `images/${imageID.toLowerCase()}${extensionFromTarget(target)}`;
            }
          }
        }
        catch (error) {
          warning = `图片整理失败: ${error.message}`;
          relative = `images/${imageID.toLowerCase()}${extensionFromTarget(target)}`;
        }
        records.push({ id: imageID, alt, title, originalTarget: target, cleanTarget: relative, warning });
        return `![${imageID}](${relative})`;
      };

      const mdPattern = /!\[(?<alt>[^\]]*)\]\(\s*(?<target><[^>]+>|[^\s)]+)(?<title>\s+["'][^"']*["'])?\s*\)/gs;
      // JavaScript replacement callbacks cannot await, so collect matches and
      // replace from the end to keep every original index stable.
      const sourceMarkdown = String(markdown || "");
      const matches = [...sourceMarkdown.matchAll(mdPattern)];
      // Allocate IMAGE_001, IMAGE_002... in document order. Replacing matches
      // from the end preserves source indices without reversing image order.
      const markdownReplacements = [];
      for (const match of matches) {
        markdownReplacements.push(await processTarget(
          match.groups?.alt || "",
          String(match.groups?.target || "").replace(/^<|>$/g, ""),
          String(match.groups?.title || "").trim()
        ));
      }
      let staged = sourceMarkdown;
      for (let index = matches.length - 1; index >= 0; index--) {
        const match = matches[index];
        const replacement = markdownReplacements[index];
        staged = staged.slice(0, match.index) + replacement + staged.slice(match.index + match[0].length);
      }

      const htmlPattern = /<img\b(?<attrs>[^>]*)>/gis;
      const htmlMatches = [...staged.matchAll(htmlPattern)];
      const htmlReplacements = [];
      for (const match of htmlMatches) {
        const attrs = match.groups?.attrs || "";
        const src = attrs.match(/\bsrc\s*=\s*["'](?<value>.*?)["']/is)?.groups?.value;
        if (!src) {
          htmlReplacements.push(null);
          continue;
        }
        const alt = attrs.match(/\balt\s*=\s*["'](?<value>.*?)["']/is)?.groups?.value || "";
        htmlReplacements.push(await processTarget(alt, src, ""));
      }
      for (let index = htmlMatches.length - 1; index >= 0; index--) {
        const replacement = htmlReplacements[index];
        if (!replacement) continue;
        const match = htmlMatches[index];
        staged = staged.slice(0, match.index) + replacement + staged.slice(match.index + match[0].length);
      }

      if (options.writeMap !== false) await this.storage.writeJSON(PathUtils.join(targetRoot, "image-map.json"), records);
      return { markdown: staged, records, nextImageIndex: counter };
    }

    async locateResultFiles(extractDir) {
      const files = await this.storage.walk(extractDir);
      const byName = name => files.filter(path => basename(path).toLowerCase() === name.toLowerCase());
      const markdown = byName("full.md")[0] || files.filter(path => U.extension(path) === ".md").sort((a, b) => a.length - b.length)[0] || null;
      const layout = byName("layout.json")[0] || null;
      const model = files.find(path => /_model\.json$/i.test(path)) || null;
      const content = files.find(path => /_content_list_v2?\.json$/i.test(path)) || null;
      return { markdown, layout, model, content, files };
    }

    async parseExternalReference(filePath, cacheRoot, options = {}, emit = null, signal = null) {
      const token = this.secrets.getMinerUToken().trim();
      if (!token) throw new Error("解析参考文件前请先配置MinerU访问令牌");
      if (!/^[\x00-\x7F]+$/.test(token)) throw new Error("MinerU访问令牌包含非ASCII字符，请检查配置");
      const extension = U.extension(filePath);
      if (!C.SUPPORTED_INPUT_EXTENSIONS.has(extension)) {
        throw new Error(`暂不支持这种参考文件格式：${extension || "无扩展名"}`);
      }
      const stat = await this.storage.stat(filePath);
      if (!stat || stat.type === "directory") throw new Error(`参考文件不存在: ${basename(filePath) || filePath}`);
      const identity = U.hashString([
        filePath,
        stat.size || 0,
        stat.lastModified || 0,
        options.modelVersion || "vlm",
        Boolean(options.isOCR),
        options.enableTable !== false,
        options.enableFormula !== false
      ].join("|"));
      const root = PathUtils.join(cacheRoot, identity);
      const markdownPath = PathUtils.join(root, "reference.md");
      const metaPath = PathUtils.join(root, "reference.json");
      const cachedMeta = await this.storage.readJSON(metaPath, null);
      const cached = await this.storage.readText(markdownPath, "");
      if (cached && cachedMeta?.identity === identity) {
        emit?.({ type: "log", message: `已读取参考文件：${basename(filePath)}` });
        return {
          markdown: cached,
          identity,
          root,
          cached: true,
          meta: cachedMeta,
          imageMap: await this.storage.readJSON(PathUtils.join(root, "image-map.json"), [])
        };
      }

      await this.storage.ensureDir(root);
      const stagingDir = this.storage.temporaryDir("ref");
      await this.storage.remove(stagingDir, true);
      await this.storage.ensureDir(stagingDir);
      try {
        emit?.({ type: "status", phase: "reference-parse", message: `正在解析参考文件：${basename(filePath)}` });
        const submitted = await this.submit(filePath, options, token, signal);
        await this.upload(submitted.uploadURL, filePath, signal, event => {
          emit?.({ ...event, phase: "reference-upload", referenceName: basename(filePath) });
        });
        const resultItem = await this.poll(submitted.batchID, options, token, signal, event => {
          emit?.({ ...event, phase: "reference-poll", referenceName: basename(filePath) });
        });
        const downloaded = await this.downloadResult(resultItem, stagingDir, signal, emit);
        const extractDir = PathUtils.join(stagingDir, "mineru-result");
        await this.extractZip(downloaded.zipPath, extractDir);
        const located = await this.locateResultFiles(extractDir);
        if (!located.markdown) throw new Error(`参考文件${basename(filePath)}没有返回可用正文`);
        const rawMarkdown = await this.storage.readText(located.markdown, "");
        if (!rawMarkdown.trim()) throw new Error(`参考文件 ${basename(filePath)} 的解析正文为空`);
        const assetMap = await this.copyAssetFiles(extractDir, "", stagingDir);
        const simplified = await this.simplifyMarkdownImages(rawMarkdown, "", assetMap, stagingDir);
        const markdown = simplified.markdown;
        const parsedAt = new Date().toISOString();
        const meta = {
          identity,
          sourceName: basename(filePath),
          sourcePath: filePath,
          sourceSize: stat.size || 0,
          sourceModified: stat.lastModified || 0,
          batchID: submitted.batchID,
          imageCount: simplified.records.length,
          parsedAt
        };
        await this.storage.writeText(PathUtils.join(stagingDir, "reference.md"), markdown);
        await this.storage.writeJSON(PathUtils.join(stagingDir, "reference.json"), meta);
        const rollbackDir = PathUtils.join(root, `.rollback-${U.randomID("reference").replace(/[^A-Za-z0-9_-]/g, "")}`);
        const entries = [
          "assets", "images", "asset-map.json", "image-map.json",
          "reference.md", "reference.json"
        ].map(name => ({
          source: PathUtils.join(stagingDir, name),
          destination: PathUtils.join(root, name)
        }));
        await this.storage.publishEntriesAtomically(entries, rollbackDir);
        return {
          markdown,
          identity,
          root,
          cached: false,
          meta,
          imageMap: simplified.records
        };
      }
      finally {
        await this.storage.remove(stagingDir, true);
      }
    }

    async prepareUploadParts(filePath, stagingDir, options = {}, emit = null, signal = null) {
      if (U.extension(filePath) !== ".pdf") {
        return [{ filePath, start: 0, end: 0, pageCount: 0, temporary: false }];
      }
      if (!global.PDFLib?.PDFDocument) {
        throw new Error("PDF处理组件未就绪，请重启LitMTrans后重试");
      }
      const readBytes = await this.storage.readBytes(filePath);
      // Tests and privileged host compartments can hand us a typed array from
      // another JavaScript realm. Normalize it into pdf-lib's own realm.
      const sourceBytes = readBytes instanceof global.Uint8Array
        ? readBytes
        : global.Uint8Array.from(readBytes || []);
      let sourcePDF;
      try {
        // Zotero can open PDFs that carry an owner/permissions encryption
        // marker without requiring a user password. We only need their page
        // count here; for ordinary documents the original bytes are uploaded
        // unchanged, so accept that marker just as the Python/pdfium path did.
        sourcePDF = await global.PDFLib.PDFDocument.load(sourceBytes, {
          ignoreEncryption: true,
          updateMetadata: false
        });
      }
      catch (error) {
        throw new Error(`无法读取PDF页数；文件可能已损坏或需要打开密码：${error.message}`);
      }
      const pageCount = sourcePDF.getPageCount();
      if (pageCount <= MINERU_UPLOAD_PAGE_LIMIT) {
        return [{ filePath, start: 0, end: pageCount, pageCount, temporary: false }];
      }
      if (sourcePDF.isEncrypted) {
        // pdf-lib can inspect an encrypted PDF with ignoreEncryption, but it
        // cannot safely decrypt and rewrite its page streams for splitting.
        // Refuse before producing unreadable parts; PDFs within the service
        // limit take the unchanged-original branch above.
        throw new Error(
          `该PDF带有权限加密且共有 ${pageCount} 页，超过MinerU单文件 ${MINERU_UPLOAD_PAGE_LIMIT} 页限制。` +
          "LitMTrans无法安全拆分此类文件；请使用无密码的副本后重新添加到Zotero。"
        );
      }
      const ranges = planMinerUPageRanges(pageCount, options.pdfPageTexts || []);
      emit?.({
        type: "progress",
        phase: "mineru-split",
        progress: 5,
        message: `文献共 ${pageCount} 页，已自动拆为 ${ranges.length} 份（每份不超过 ${MINERU_UPLOAD_PAGE_LIMIT} 页）`
      });
      const partsDir = PathUtils.join(stagingDir, "upload-parts");
      await this.storage.ensureDir(partsDir);
      const parts = [];
      for (let index = 0; index < ranges.length; index++) {
        U.throwIfAborted(signal);
        const range = ranges[index];
        const partPDF = await global.PDFLib.PDFDocument.create();
        const indices = Array.from({ length: range.pageCount }, (_, offset) => range.start + offset);
        const copiedPages = await partPDF.copyPages(sourcePDF, indices);
        for (const page of copiedPages) partPDF.addPage(page);
        const partPath = PathUtils.join(
          partsDir,
          `${U.safeStem(basename(filePath).replace(/\.[^.]+$/, ""), 48, "document")}.part-${String(index + 1).padStart(3, "0")}.pdf`
        );
        await this.storage.writeBytes(partPath, await partPDF.save({ useObjectStreams: true }));
        parts.push({ filePath: partPath, ...range, temporary: true });
      }
      return parts;
    }

    async runUploadPart(part, index, total, options, token, stagingDir, emit, signal) {
      const label = total > 1 ? `第 ${index + 1}/${total} 份` : "";
      const forward = event => {
        if (!event) return;
        const progress = Number(event.progress);
        const scaled = Number.isFinite(progress)
          ? 8 + Math.round(((index + progress / 100) / total) * 80)
          : progress;
        emit?.({
          ...event,
          progress: scaled,
          message: label ? `${label}：${event.message || ""}` : event.message
        });
      };
      const submitted = await this.submit(part.filePath, options, token, signal);
      forward({ type: "progress", phase: "mineru-submit", progress: 12, message: "已创建MinerU解析任务" });
      await this.upload(submitted.uploadURL, part.filePath, signal, forward);
      const resultItem = await this.poll(submitted.batchID, options, token, signal, forward);
      const partRoot = PathUtils.join(stagingDir, "mineru-result", `part-${String(index + 1).padStart(3, "0")}`);
      await this.storage.ensureDir(partRoot);
      const downloaded = await this.downloadResult(resultItem, partRoot, signal, forward);
      const extractDir = PathUtils.join(partRoot, "extracted");
      await this.extractZip(downloaded.zipPath, extractDir);
      await this.storage.remove(downloaded.zipPath, false);
      const located = await this.locateResultFiles(extractDir);
      if (!located.markdown) throw new Error(`${label || "解析结果"}中没有找到可用正文`);
      return { part, submitted, resultItem, downloaded, extractDir, located };
    }

    async mergeUploadPartResults(results, documentID, stagingDir) {
      const rawParts = [];
      const cleanParts = [];
      const imageRecords = [];
      const canonicalAssetMap = {};
      const layoutPayloads = [];
      const modelPayloads = [];
      const contentPayloads = [];
      let nextImageIndex = 0;
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const prefix = results.length > 1 ? `p${String(index + 1).padStart(3, "0")}-` : "";
        const rawMarkdown = await this.storage.readText(result.located.markdown, "");
        const partAssetMap = await this.copyAssetFiles(result.extractDir, documentID, stagingDir, {
          reset: index === 0,
          namePrefix: prefix,
          writeMap: false
        });
        const missingAssets = localMarkdownImageTargets(rawMarkdown).filter(target => {
          const key = normalizeAssetKey(target);
          return !partAssetMap[key] && !partAssetMap[normalizeAssetKey(basename(key))];
        });
        if (missingAssets.length) {
          throw new Error(
            `MinerU第 ${index + 1} 份结果缺少 ${missingAssets.length} 个Markdown图片资源` +
            `（例如：${missingAssets.slice(0, 3).join("、")}）。解析结果不完整，请重新解析。`
          );
        }
        const simplified = await this.simplifyMarkdownImages(rawMarkdown, documentID, partAssetMap, stagingDir, {
          reset: index === 0,
          imageIndexStart: nextImageIndex,
          writeMap: false
        });
        nextImageIndex = simplified.nextImageIndex;
        rawParts.push(rawMarkdown.trim());
        cleanParts.push(simplified.markdown.trim());
        imageRecords.push(...simplified.records.map(record => ({ ...record, part: index + 1 })));
        for (const stored of Object.values(partAssetMap)) {
          canonicalAssetMap[normalizeAssetKey(stored)] = stored;
          canonicalAssetMap[normalizeAssetKey(basename(stored))] = stored;
        }
        const pageOffset = result.part.start;
        if (result.located.layout) {
          layoutPayloads.push(rebaseMinerUPayload(
            await this.storage.readJSON(result.located.layout, null),
            pageOffset,
            partAssetMap
          ));
        }
        if (result.located.model) {
          modelPayloads.push(rebaseMinerUPayload(
            await this.storage.readJSON(result.located.model, null),
            pageOffset,
            partAssetMap
          ));
        }
        if (result.located.content) {
          contentPayloads.push(rebaseMinerUPayload(
            await this.storage.readJSON(result.located.content, null),
            pageOffset,
            partAssetMap
          ));
        }
      }
      const layout = mergedMinerUJSON(layoutPayloads, "pdf_info");
      const model = mergedMinerUJSON(modelPayloads);
      const content = mergedMinerUJSON(contentPayloads);
      await this.storage.writeText(PathUtils.join(stagingDir, "full.md"), rawParts.filter(Boolean).join("\n\n"));
      await this.storage.writeText(PathUtils.join(stagingDir, "full.cleaned.md"), cleanParts.filter(Boolean).join("\n\n"));
      await this.storage.writeJSON(PathUtils.join(stagingDir, "asset-map.json"), canonicalAssetMap);
      await this.storage.writeJSON(PathUtils.join(stagingDir, "image-map.json"), imageRecords);
      if (layout) await this.storage.writeJSON(PathUtils.join(stagingDir, "layout.json"), layout);
      if (model) await this.storage.writeJSON(PathUtils.join(stagingDir, "model.json"), model);
      if (content) await this.storage.writeJSON(PathUtils.join(stagingDir, "content-list.json"), content);
      return {
        rawMarkdown: rawParts.filter(Boolean).join("\n\n"),
        markdown: cleanParts.filter(Boolean).join("\n\n"),
        records: imageRecords,
        hasLayout: Boolean(layout)
      };
    }

    async parse(item, filePath, options = {}, emit = null, signal = null) {
      const token = this.secrets.getMinerUToken().trim();
      if (!token) throw new Error("尚未配置MinerU访问令牌");
      if (!/^[\x00-\x7F]+$/.test(token)) throw new Error("MinerU访问令牌包含非ASCII字符，请检查配置");
      if (!C.SUPPORTED_INPUT_EXTENSIONS.has(U.extension(filePath))) {
        throw new Error(`暂不支持这种附件格式：${U.extension(filePath) || "无扩展名"}`);
      }
      const { id: documentID, dir } = await this.storage.ensureDocument(item);
      const sourceIdentity = await this.storage.sourceIdentity(item, filePath);
      const parseIdentity = U.hashString([
        sourceIdentity,
        options.modelVersion || "vlm",
        Boolean(options.isOCR),
        options.enableTable !== false,
        options.enableFormula !== false
      ].join("|"));
      const existing = await this.storage.getDocumentMeta(documentID);
      const cleanPath = this.storage.path(documentID, "full.cleaned.md");
      if (!options.force && existing?.parseIdentity === parseIdentity && await this.storage.exists(cleanPath)) {
        emit?.({ type: "progress", phase: "cache", progress: 100, message: "已读取文献解析结果" });
        return this.loadParsed(documentID);
      }

      // All network and ZIP work happens in a staging directory. A failed
      // reparse therefore leaves the last readable document, images, and layout
      // intact instead of half-deleting the user's cache.
      const oldClean = await this.storage.readText(cleanPath, "");
      const oldLayout = await this.storage.readText(this.storage.path(documentID, "layout.json"), "");
      const stagingDir = this.storage.temporaryDir("parse");
      await this.storage.remove(stagingDir, true);
      await this.storage.ensureDir(stagingDir);
      emit?.({ type: "progress", phase: "mineru-prepare", progress: 3, message: "正在准备MinerU解析" });

      try {
        // Keep this lightweight preflight request for service compatibility,
        // but quota is account metadata rather than document progress and
        // should not distract from the parsing messages shown to the reader.
        await this.queryQuota(token, signal);
        const uploadParts = await this.prepareUploadParts(filePath, stagingDir, options, emit, signal);
        const partResults = [];
        for (let index = 0; index < uploadParts.length; index++) {
          U.throwIfAborted(signal);
          partResults.push(await this.runUploadPart(
            uploadParts[index],
            index,
            uploadParts.length,
            options,
            token,
            stagingDir,
            emit,
            signal
          ));
        }
        emit?.({ type: "progress", phase: "mineru-finish", progress: 90, message: "MinerU解析完成，正在合并结果" });
        const merged = await this.mergeUploadPartResults(partResults, documentID, stagingDir);

        const parsedAt = new Date().toISOString();
        await this.storage.writeJSON(PathUtils.join(stagingDir, "mineru-task.json"), {
          batchID: partResults[0]?.submitted.batchID || "",
          batchIDs: partResults.map(result => result.submitted.batchID),
          zipURL: partResults[0]?.downloaded.zipURL || "",
          modelVersion: options.modelVersion || "vlm",
          isOCR: Boolean(options.isOCR),
          enableTable: options.enableTable !== false,
          enableFormula: options.enableFormula !== false,
          uploadName: partResults[0]?.submitted.uploadName || basename(filePath),
          resultItem: partResults[0]?.resultItem || null,
          autoSplit: uploadParts.length > 1,
          pageCount: uploadParts.reduce((sum, part) => sum + part.pageCount, 0),
          parts: partResults.map((result, index) => ({
            index: index + 1,
            startPage: result.part.start + 1,
            endPage: result.part.end,
            pageCount: result.part.pageCount,
            batchID: result.submitted.batchID,
            uploadName: result.submitted.uploadName,
            zipURL: result.downloaded.zipURL
          })),
          parsedAt
        });
        await this.storage.writeJSON(PathUtils.join(stagingDir, "document.json"), {
          ...(existing || {}),
          documentID,
          itemID: item.id,
          libraryID: item.libraryID,
          itemKey: item.key,
          parentItemID: item.parentID || null,
          parentItemKey: item.parentKey || "",
          sourceIdentity,
          parseIdentity,
          sourceFileName: basename(filePath),
          sourcePath: filePath,
          parsedAt,
          updatedAt: parsedAt,
          hasLayout: merged.hasLayout,
          imageCount: merged.records.length,
          autoSplit: uploadParts.length > 1,
          partCount: uploadParts.length
        });

        const newLayout = await this.storage.readText(PathUtils.join(stagingDir, "layout.json"), "");
        const stagedAssetMap = await this.storage.readJSON(PathUtils.join(stagingDir, "asset-map.json"), {});
        if (newLayout) {
          await this.storage.writeJSON(PathUtils.join(stagingDir, "layout-revision.json"), {
            version: 1,
            sourceFingerprint: U.hashString(newLayout),
            assetMapHash: U.hashString(JSON.stringify(stagedAssetMap)),
            generatedAt: parsedAt
          });
        }
        const parseEntries = [
          "mineru-result", "assets", "images", "full.md", "full.cleaned.md",
          "layout.json", "model.json", "content-list.json", "asset-map.json",
          "image-map.json", "mineru-task.json", "document.json", "layout-revision.json"
        ];
        const rollbackDir = PathUtils.join(dir, `.parse-rollback-${U.randomID("run").replace(/[^A-Za-z0-9_-]/g, "")}`);
        await this.storage.publishEntriesAtomically(
          parseEntries.map(name => ({
            source: PathUtils.join(stagingDir, name),
            destination: PathUtils.join(dir, name)
          })),
          rollbackDir
        );

        const sourceChanged = Boolean(existing) && (existing.sourceIdentity !== sourceIdentity || oldClean !== merged.markdown);
        const layoutChanged = Boolean(existing) && oldLayout !== newLayout;
        if (sourceChanged) await this.storage.clearTranslation(documentID, "stream");
        if (layoutChanged) await this.storage.clearTranslation(documentID, "layout");

        emit?.({ type: "progress", phase: "done", progress: 100, message: "解析完成" });
        return this.loadParsed(documentID);
      }
      finally {
        await this.storage.remove(stagingDir, true);
      }
    }

    async loadParsed(itemOrID) {
      const documentID = typeof itemOrID === "string" ? itemOrID : this.storage.documentID(itemOrID);
      const markdown = await this.storage.readText(this.storage.path(documentID, "full.cleaned.md"), "");
      const meta = await this.storage.getDocumentMeta(documentID);
      const hasLayout = await this.storage.exists(this.storage.path(documentID, "layout.json"));
      return {
        documentID,
        markdown,
        meta,
        hasLayout,
        layoutRevision: await this.storage.readJSON(this.storage.path(documentID, "layout-revision.json"), null),
        imageMap: await this.storage.readJSON(this.storage.path(documentID, "image-map.json"), []),
        assetMap: await this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {})
      };
    }
  }

  LitMTrans.MinerUService = MinerUService;
  LitMTrans.MinerUAsset = { normalizeAssetKey, basename };
  LitMTrans.MinerUInternals = {
    localMarkdownImageTargets,
    readPortableZip,
    readPortableZipEntry,
    extensionFromTarget,
    mineruBoundaryScore,
    chooseMinerUSplitEnd,
    planMinerUPageRanges,
    rebaseMinerUPayload,
    mergedMinerUJSON,
    MINERU_UPLOAD_PAGE_LIMIT
  };
})(this);
