(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function byteLength(value) {
    try { return new TextEncoder().encode(String(value || "")).byteLength; }
    catch (_) { return unescape(encodeURIComponent(String(value || ""))).length; }
  }

  function decodeUtf8(bytes) {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
    catch (_) {
      let binary = "";
      for (const value of bytes || []) binary += String.fromCharCode(value);
      try { return decodeURIComponent(escape(binary)); }
      catch (_) { return binary; }
    }
  }

  function findHeaderTerminator(bytes, length = bytes.length, from = 0) {
    for (let index = Math.max(0, from); index + 3 < length; index++) {
      if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
    }
    return -1;
  }

  function requestMethod(headerText) {
    return String(headerText || "").split(/\r?\n/, 1)[0].split(/\s+/, 2)[0].toUpperCase();
  }

  function headerValue(headerText, name) {
    const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return String(headerText || "").match(new RegExp(`^${escaped}:[ \\t]*([^\\r\\n]*)$`, "im"))?.[1]?.trim() || "";
  }

  function parseContentLength(headerText) {
    const value = headerValue(headerText, "Content-Length");
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function joinBytes(chunks, length) {
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk.subarray ? chunk.subarray(0, length - offset) : chunk, offset);
      offset += chunk.length;
      if (offset >= length) break;
    }
    return output;
  }

  function normalizeChunk(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return Uint8Array.from(value || []);
  }

  function incomplete(reason, options = {}) {
    const status = reason === "too-large" ? 413 : reason === "missing-content-length" || reason === "chunked" || reason === "transfer-encoding" ? 411 : 400;
    const messages = {
      "no-data": "No HTTP request data",
      "headers-truncated": "Incomplete HTTP request headers",
      "body-truncated": "Incomplete HTTP request body",
      "too-large": "Request body too large",
      "missing-content-length": "Content-Length is required for POST request bodies",
      chunked: "Chunked request bodies are not supported",
      "transfer-encoding": "Unsupported Transfer-Encoding"
    };
    return {
      complete: false,
      error: messages[reason] || "Incomplete HTTP request",
      status,
      incompleteReason: reason,
      totalBytesRead: Number(options.totalBytesRead || 0),
      bodyBytesRead: Number(options.bodyBytesRead || 0)
    };
  }

  /**
   * 读取一条带 Content-Length 的 HTTP 请求。reader 只需提供 available/readBytes，
   * 因而可以在 Zotero XPCOM 输入流和 Node 测试桩之间复用同一套边界逻辑。
   */
  async function readHttpRequest(reader, options = {}) {
    const maxRequestSize = Math.max(1, Number(options.maxRequestSize || 16 * 1024 * 1024));
    const maxWaitAttempts = Math.max(1, Number(options.maxWaitAttempts ?? 500));
    const waitMs = Math.max(0, Number(options.waitMs ?? 10));
    const sleep = typeof options.sleep === "function" ? options.sleep : ms => new Promise(resolve => setTimeout(resolve, ms));
    const chunks = [];
    let totalBytesRead = 0;
    let headerEnd = -1;
    let contentLength = null;
    let expectedTotal = null;
    let waitAttempts = 0;

    while (true) {
      if (expectedTotal != null && totalBytesRead >= expectedTotal) break;
      if (totalBytesRead >= maxRequestSize) return incomplete("too-large", { totalBytesRead });

      let available = 0;
      try { available = Math.max(0, Number(await reader.available()) || 0); }
      catch (_) { available = 0; }
      if (!available) {
        waitAttempts += 1;
        if (waitAttempts > maxWaitAttempts) {
          if (!totalBytesRead) return incomplete("no-data", { totalBytesRead });
          return incomplete(headerEnd < 0 ? "headers-truncated" : "body-truncated", {
            totalBytesRead,
            bodyBytesRead: headerEnd < 0 ? 0 : Math.max(0, totalBytesRead - headerEnd - 4)
          });
        }
        await sleep(waitMs);
        continue;
      }

      waitAttempts = 0;
      const remaining = expectedTotal == null ? maxRequestSize - totalBytesRead : expectedTotal - totalBytesRead;
      const requested = Math.max(1, Math.min(available, remaining, headerEnd < 0 ? 8192 : 65536));
      let part;
      try { part = normalizeChunk(await reader.readBytes(requested)); }
      catch (_) { return incomplete(headerEnd < 0 ? "headers-truncated" : "body-truncated", { totalBytesRead }); }
      if (!part.length) continue;
      if (part.length > remaining) part = part.subarray(0, remaining);
      chunks.push(part);
      totalBytesRead += part.length;
      if (headerEnd < 0) {
        const bytes = joinBytes(chunks, totalBytesRead);
        headerEnd = findHeaderTerminator(bytes);
        if (headerEnd >= 0) {
          const headerText = decodeUtf8(bytes.subarray(0, headerEnd));
          const transferEncoding = headerValue(headerText, "Transfer-Encoding");
          if (transferEncoding) {
            return incomplete(/\bchunked\b/i.test(transferEncoding) ? "chunked" : "transfer-encoding", { totalBytesRead });
          }
          contentLength = parseContentLength(headerText);
          if (requestMethod(headerText) === "POST" && contentLength == null) {
            return incomplete("missing-content-length", { totalBytesRead });
          }
          contentLength = contentLength == null ? 0 : contentLength;
          expectedTotal = headerEnd + 4 + contentLength;
          if (expectedTotal > maxRequestSize) return incomplete("too-large", { totalBytesRead });
        }
      }
    }

    const bytes = joinBytes(chunks, totalBytesRead);
    if (headerEnd < 0) return incomplete("headers-truncated", { totalBytesRead });
    const bodyStart = headerEnd + 4;
    const bodyBytes = bytes.subarray(bodyStart, bodyStart + contentLength);
    if (bodyBytes.length < contentLength) return incomplete("body-truncated", { totalBytesRead, bodyBytesRead: bodyBytes.length });
    return {
      complete: true,
      headerText: decodeUtf8(bytes.subarray(0, headerEnd)),
      body: decodeUtf8(bodyBytes),
      contentLength,
      bodyBytesRead: bodyBytes.length,
      totalBytesRead,
      trailingBytes: bytes.length > bodyStart + contentLength ? bytes.subarray(bodyStart + contentLength) : new Uint8Array()
    };
  }

  Agent.MCPHttpRequestReader = { byteLength, decodeUtf8, findHeaderTerminator, parseContentLength, readHttpRequest };
})(this);
