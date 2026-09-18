(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};

  // KDH 格式专有 XOR 解密密钥 ("FZHMEI")
  const KDH_PASSPHRASE = new Uint8Array([0x46, 0x5A, 0x48, 0x4D, 0x45, 0x49]);

  /**
   * CAJConverter: 纯 JavaScript CAJ-Family 格式解析与 PDF 转换引擎
   * 规范参考 caj2pdf-rs 架构与字节分析文档 (docs/format-analysis.md)：
   * - PDF: pass-through 直接透传
   * - KDH: 丢弃 254 字节头，FZHMEI 循环 XOR 解密，截断至最后一个 %%EOF
   * - CAJ: 提取内嵌 PDF 数据段，补全缺失的 /Catalog 与 /Pages 顶层字典，精准生成标准 xref 交叉引用表
   * - HN / C8: 早期知网 JBIG 压缩图像流，精准识别并给予用户专业说明
   */
  class CAJConverter {
    /**
     * 判断文件扩展名是否为 .caj
     * @param {string} filename
     * @returns {boolean}
     */
    static isCAJExtension(filename) {
      return /\.caj$/i.test(String(filename || "").trim());
    }

    /**
     * 依据字节魔数精确探测文件格式类型 (对齐 caj2pdf-rs 格式规范)
     * @param {Uint8Array} bytes
     * @returns {"PDF"|"KDH"|"CAJ"|"HN"|"C8"|"TEB"|"UNKNOWN"}
     */
    static detectFormat(bytes) {
      if (!bytes || bytes.length < 4) return "UNKNOWN";

      // 1. C8: 单字节 0xC8
      if (bytes[0] === 0xC8) return "C8";

      // 2. HN no-TOC 变体: 前 4 字节为 "HN\xc8\x00"
      if (bytes[0] === 0x48 && bytes[1] === 0x4E && bytes[2] === 0xC8 && bytes[3] === 0x00) {
        return "HN";
      }

      // 3. %PDF 标头
      if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
        return "PDF";
      }

      // 4. KDH 标头: "KDH " (0x4B 0x44 0x48 0x20)
      if (bytes[0] === 0x4B && bytes[1] === 0x44 && bytes[2] === 0x48 && bytes[3] === 0x20) {
        return "KDH";
      }

      // 5. CAJ 标头: "CAJ " (0x43 0x41 0x4A 0x20) 或 "CAJ\0"
      if (bytes[0] === 0x43 && bytes[1] === 0x41 && bytes[2] === 0x4A && (bytes[3] === 0x20 || bytes[3] === 0x00)) {
        return "CAJ";
      }

      // 6. HN with-TOC 变体: "HN\0\0"
      if (bytes[0] === 0x48 && bytes[1] === 0x4E) {
        return "HN";
      }

      // 7. TEB 标头: "TEB" (0x54 0x45 0x42)
      if (bytes[0] === 0x54 && bytes[1] === 0x45 && bytes[2] === 0x42) {
        return "TEB";
      }

      // 前 1024 字节内模糊搜索 %PDF
      const scanLimit = Math.min(bytes.length - 4, 1024);
      for (let i = 0; i < scanLimit; i++) {
        if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) {
          return "PDF";
        }
      }

      return "UNKNOWN";
    }

    /**
     * 判断二进制流是否属于 CAJ-Family 文档
     * @param {Uint8Array} bytes
     * @returns {boolean}
     */
    static isCAJBytes(bytes) {
      const format = CAJConverter.detectFormat(bytes);
      return format === "CAJ" || format === "KDH" || format === "HN" || format === "C8" || format === "TEB";
    }

    /**
     * 将支持的 CAJ 家族文件转换为 PDF 字节流
     * @param {Uint8Array} bytes
     * @returns {Promise<Uint8Array>}
     */
    static async convertToPDF(bytes) {
      if (!bytes || bytes.length < 16) {
        throw new Error("文件大小异常，无法解析为有效的文献文档");
      }

      const format = CAJConverter.detectFormat(bytes);

      switch (format) {
        case "PDF":
          return CAJConverter._convertPDF(bytes);

        case "KDH":
          return CAJConverter._convertKDH(bytes);

        case "CAJ":
          return CAJConverter._convertCAJ(bytes);

        case "HN":
        case "C8":
          throw new Error(
            `此 CAJ 使用 ${format} 格式，当前版本暂不支持转换。\n` +
            "请通过 Zotero 默认方式打开，或先用 CAJViewer 导出为 PDF。"
          );

        case "TEB":
          throw new Error("当前文件为知网 TEB (Apabi) 专有矢量格式，暂不支持直接解包。");

        default:
          throw new Error("未识别的 CAJ 文档格式标头，可能文件已损坏或非知网论文格式。");
      }
    }

    /**
     * PDF 变体：知网直接保存或改名，直接返回标准 PDF 数据
     */
    static _convertPDF(bytes) {
      return bytes;
    }

    /**
     * KDH 变体：丢弃 254 字节头，执行 6 字节 FZHMEI 循环 XOR 解密，截断至最后一个 %%EOF
     */
    static _convertKDH(bytes) {
      if (bytes.length <= 254) {
        throw new Error("KDH 文件数据过短，无法解密");
      }

      const payload = bytes.subarray(254);
      const decrypted = new Uint8Array(payload.length);
      const keyLen = KDH_PASSPHRASE.length;

      for (let i = 0; i < payload.length; i++) {
        decrypted[i] = payload[i] ^ KDH_PASSPHRASE[i % keyLen];
      }

      // 验证解密后是否以 %PDF- 开头
      const isPDF = decrypted[0] === 0x25 && decrypted[1] === 0x50 && decrypted[2] === 0x44 && decrypted[3] === 0x46;
      if (!isPDF) {
        throw new Error("KDH 解密后未找到标准 PDF 标头，可能采用了未知的加密密钥");
      }

      // 只接受带 startxref 且指向交叉引用结构的文件尾，保留最后一次增量更新。
      const tailStart = Math.max(0, decrypted.length - 65536);
      const tail = new TextDecoder("latin1").decode(decrypted.subarray(tailStart));
      const endings = [...tail.matchAll(/startxref\s+(\d+)\s+%%EOF(?=[\r\n\t ]|$)/g)];
      for (let i = endings.length - 1; i >= 0; i--) {
        const entry = endings[i];
        const offset = Number(entry[1]);
        if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= tailStart + entry.index) continue;
        const target = new TextDecoder("latin1").decode(decrypted.subarray(offset, offset + 80));
        if (!/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(target)) continue;
        const end = tailStart + entry.index + entry[0].length;
        const result = new Uint8Array(end + 1);
        result.set(decrypted.subarray(0, end));
        result[end] = 10;
        return result;
      }
      throw new Error("KDH 解密后的 PDF 尾部不完整，无法安全转换");
    }

    /**
     * 标准 CAJ 变体：提取内嵌 PDF 对象、扫描并补全 Catalog/Pages、精确生成 xref 交叉引用表
     */
    static async _convertCAJ(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      let pageNum = 0;
      try {
        if (bytes.length >= 0x14) {
          pageNum = view.getInt32(0x10, true);
        }
      } catch (_) {}

      // 读取目录 (TOC) 信息
      const outlines = CAJConverter._readCAJTOC(bytes, view);

      // 定位内嵌 PDF 数据起始偏移
      let pdfStart = -1;
      if (bytes.length >= 0x18) {
        try {
          const pdfStartPointer = view.getInt32(0x14, true);
          if (pdfStartPointer > 0 && pdfStartPointer + 4 <= bytes.length) {
            pdfStart = view.getInt32(pdfStartPointer, true);
          }
        } catch (_) {}
      }

      // 容错：通过扫描 " 0 obj" 定位
      if (pdfStart <= 0 || pdfStart >= bytes.length) {
        const objMarker = new TextEncoder().encode(" 0 obj");
        pdfStart = CAJConverter._indexOfBytes(bytes, objMarker, 0, Math.min(bytes.length, 65536));
        if (pdfStart !== -1) {
          while (pdfStart > 0 && bytes[pdfStart - 1] !== 0x0A && bytes[pdfStart - 1] !== 0x0D) {
            pdfStart--;
          }
        }
      }

      if (pdfStart <= 0 || pdfStart >= bytes.length) {
        throw new Error("无法在 CAJ 文件中定位到内嵌的 PDF 数据流");
      }

      // 定位最后一个 endobj 结束位置
      const endobjMarker = new TextEncoder().encode("endobj");
      const lastEndobj = CAJConverter._lastIndexOfBytes(bytes, endobjMarker);
      if (lastEndobj === -1 || lastEndobj <= pdfStart) {
        throw new Error("CAJ 中的 PDF 数据对象段不完整");
      }
      const lastEOF = CAJConverter._lastIndexOfBytes(bytes, new TextEncoder().encode("%%EOF"));
      const pdfEnd = lastEOF > lastEndobj ? lastEOF + 5 : lastEndobj + endobjMarker.length;

      // 提取核心 PDF 字节流
      const rawPdfBytes = bytes.subarray(pdfStart, pdfEnd);
      return CAJConverter._assembleStandardPDF(rawPdfBytes, pageNum, outlines);
    }

    /**
     * 读取 CAJ 格式的 308-byte TOC 目录表 (对齐 docs/format-analysis.md § 3.2)
     */
    static _readCAJTOC(bytes, view) {
      const outlines = [];
      try {
        if (bytes.length < 0x114) return outlines;
        const tocCount = view.getInt32(0x110, true);
        if (tocCount <= 0 || tocCount > 2000) return outlines;

        const gbkDecoder = new TextDecoder("gb18030");

        for (let i = 0; i < tocCount; i++) {
          const offset = 0x114 + i * 308;
          if (offset + 308 > bytes.length) break;

          // 0x000..0x100: Title (256 bytes GBK, NUL-terminated)
          let ttlEnd = offset;
          while (ttlEnd < offset + 256 && bytes[ttlEnd] !== 0) {
            ttlEnd++;
          }
          let title = "";
          try {
            title = gbkDecoder.decode(bytes.subarray(offset, ttlEnd)).trim();
          } catch (_) {}

          // 0x118..0x124: Page number (12 ASCII bytes, NUL-terminated)
          let pgEnd = offset + 0x118;
          while (pgEnd < offset + 0x118 + 12 && bytes[pgEnd] !== 0) {
            pgEnd++;
          }
          const pageStr = new TextDecoder("ascii").decode(bytes.subarray(offset + 0x118, pgEnd)).trim();
          const page = parseInt(pageStr, 10) || 1;

          // 0x130..0x134: Level (i32 LE, 1 = top-level)
          let level = 1;
          try {
            level = view.getInt32(offset + 0x130, true);
          } catch (_) {}

          if (title) {
            outlines.push({ title, page, level: Math.max(1, level) });
          }
        }
      } catch (_) {}
      return outlines;
    }

    /**
     * 重建并装配标准 PDF 字节流，补充顶层 Catalog/Pages，重建精准 xref
     */
    static async _assembleStandardPDF(rawPdfBytes, expectedPages, outlines = []) {
      const { PDFParser, PDFWriter, PDFDict, PDFArray, PDFName, PDFRef, PDFHexString } = global.PDFLib;
      const name = value => PDFName.of(value);
      const header = new TextEncoder().encode("%PDF-1.7\n");
      const input = new Uint8Array(header.length + rawPdfBytes.length + 1);
      input.set(header);
      input.set(rawPdfBytes, header.length);
      input[input.length - 1] = 10;
      // 使用 PDF 解析器处理二进制流、对象流与引用，避免正则跨对象误匹配。
      const context = await PDFParser.forBytesWithOptions(input, 100, true).parseDocument();
      if (context.trailerInfo.Encrypt) throw new Error("此 CAJ 内嵌 PDF 已加密，无法转换");
      const nodes = new Map();
      for (const [ref, obj] of context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        const type = obj.get(name("Type"));
        if (type === name("Page") || type === name("Pages")) nodes.set(String(ref), { ref, obj });
      }
      if (![...nodes.values()].some(({ obj }) => obj.get(name("Type")) === name("Page"))) {
        throw new Error("CAJ 中未找到可用的 PDF 页面");
      }
      const missing = new Map();
      for (const { ref, obj } of nodes.values()) {
        const parent = obj.get(name("Parent"));
        if (!parent) continue;
        if (!(parent instanceof PDFRef)) throw new Error("CAJ 页树父节点引用无效");
        if (!nodes.has(String(parent))) {
          if (context.lookup(parent)) throw new Error("CAJ 页树父节点不是页面目录");
          const entry = missing.get(String(parent)) || { ref: parent, kids: [] };
          entry.kids.push(ref);
          missing.set(String(parent), entry);
        }
      }
      for (const { ref, kids } of missing.values()) {
        const obj = context.obj({ Type: "Pages", Kids: kids, Count: 0 });
        context.assign(ref, obj);
        nodes.set(String(ref), { ref, obj });
      }
      const roots = [...nodes.values()].filter(({ obj }) => !obj.has(name("Parent")));
      if (!roots.length) throw new Error("CAJ 页树没有根节点");
      let root;
      if (roots.length === 1 && roots[0].obj.get(name("Type")) === name("Pages")) root = roots[0];
      else {
        const obj = context.obj({ Type: "Pages", Kids: roots.map(node => node.ref), Count: 0 });
        root = { ref: context.register(obj), obj };
        nodes.set(String(root.ref), root);
        for (const node of roots) node.obj.set(name("Parent"), root.ref);
      }
      const pages = [];
      const visited = new Set();
      const visit = (ref, depth = 0) => {
        const key = String(ref);
        if (depth > 256 || visited.has(key)) throw new Error("CAJ 页树存在循环或重复引用");
        visited.add(key);
        const node = nodes.get(key);
        if (!node) throw new Error("CAJ 页树引用了缺失的页面");
        if (node.obj.get(name("Type")) === name("Page")) { pages.push(ref); return 1; }
        const kids = node.obj.lookup(name("Kids"), PDFArray);
        let count = 0;
        for (let i = 0; i < kids.size(); i++) {
          const child = kids.get(i);
          const childNode = nodes.get(String(child));
          if (!childNode) throw new Error("CAJ 页树引用了缺失的页面");
          childNode.obj.set(name("Parent"), ref);
          count += visit(child, depth + 1);
        }
        node.obj.set(name("Count"), context.obj(count));
        return count;
      };
      visit(root.ref);
      if (visited.size !== nodes.size || (expectedPages > 0 && pages.length !== expectedPages)) {
        throw new Error("CAJ 页数或页树不完整，已停止转换");
      }
      let catalog = context.lookup(context.trailerInfo.Root);
      if (!(catalog instanceof PDFDict) || catalog.get(name("Type")) !== name("Catalog")) {
        catalog = context.obj({ Type: "Catalog" });
        context.trailerInfo.Root = context.register(catalog);
      }
      catalog.set(name("Pages"), root.ref);
      if (outlines.length && !catalog.has(name("Outlines"))) {
        const tree = { obj: context.obj({ Type: "Outlines" }), children: [], level: 0 };
        tree.ref = context.register(tree.obj);
        const stack = [tree];
        for (const entry of outlines) {
          if (!pages[entry.page - 1]) continue;
          while (stack.length > 1 && stack[stack.length - 1].level >= entry.level) stack.pop();
          const parent = stack[stack.length - 1];
          const node = { obj: context.obj({ Title: PDFHexString.fromText(entry.title), Parent: parent.ref,
            Dest: [pages[entry.page - 1], name("Fit")] }), children: [], level: entry.level };
          node.ref = context.register(node.obj);
          parent.children.push(node);
          stack.push(node);
        }
        const link = node => {
          let count = 0;
          node.children.forEach((child, i, siblings) => {
            if (i) child.obj.set(name("Prev"), siblings[i - 1].ref);
            if (i + 1 < siblings.length) child.obj.set(name("Next"), siblings[i + 1].ref);
            count += 1 + link(child);
          });
          if (node.children.length) {
            node.obj.set(name("First"), node.children[0].ref);
            node.obj.set(name("Last"), node.children[node.children.length - 1].ref);
            node.obj.set(name("Count"), context.obj(count));
          }
          return count;
        };
        link(tree);
        catalog.set(name("Outlines"), tree.ref);
      }
      return PDFWriter.forContext(context, 100).serializeToBuffer();
    }

    static _indexOfBytes(source, target, fromIndex = 0, toIndex = source.length) {
      const limit = Math.min(source.length - target.length, toIndex);
      for (let i = fromIndex; i <= limit; i++) {
        let match = true;
        for (let j = 0; j < target.length; j++) {
          if (source[i + j] !== target[j]) {
            match = false;
            break;
          }
        }
        if (match) return i;
      }
      return -1;
    }

    static _lastIndexOfBytes(source, target) {
      for (let i = source.length - target.length; i >= 0; i--) {
        let match = true;
        for (let j = 0; j < target.length; j++) {
          if (source[i + j] !== target[j]) {
            match = false;
            break;
          }
        }
        if (match) return i;
      }
      return -1;
    }
  }

  LitMTrans.CAJConverter = CAJConverter;
})(typeof globalThis !== "undefined" ? globalThis : this);
