(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const C = LitMTrans.Constants;

  class HTTPError extends Error {
    constructor(message, status = 0, body = "", retryAfterMs = 0) {
      super(message);
      this.name = "HTTPError";
      this.status = status;
      this.body = body;
      this.retryAfterMs = Math.max(0, Number(retryAfterMs || 0));
    }
  }

  function retryAfterMilliseconds(headers, now = Date.now()) {
    const value = String(headers?.get?.("retry-after") || "").trim();
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Number(now || Date.now())) : 0;
  }

  class RequestTimeoutError extends Error {
    constructor(message = "模型请求超时") {
      super(message);
      this.name = "RequestTimeoutError";
      this.timeout = true;
    }
  }

  class StreamTimeoutError extends RequestTimeoutError {
    constructor(message = "模型流式响应等待超时") {
      super(message);
      this.name = "StreamTimeoutError";
    }
  }

  function linkedController(signal, timeoutMs) {
    const controller = U.newAbortController();
    let timer = null;
    let timedOut = false;
    const abortFromParent = () => controller.abort(signal?.reason || "操作已停止");
    if (signal) {
      if (signal.aborted) abortFromParent();
      else signal.addEventListener("abort", abortFromParent, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort("请求超时");
      }, timeoutMs);
    }
    return {
      controller,
      get timedOut() { return timedOut; },
      cleanup() {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abortFromParent);
      }
    };
  }

  function readStreamChunk(reader, timeoutMs, message) {
    const duration = Math.max(0, Number(timeoutMs || 0));
    if (!duration) return reader.read();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { void reader.cancel(message); } catch (_) {}
        reject(new StreamTimeoutError(message));
      }, duration);
      Promise.resolve(reader.read()).then(
        value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  async function responseTextSafe(response) {
    try {
      return await response.text();
    }
    catch (_) {
      return "";
    }
  }

  async function request(method, url, options = {}) {
    const {
      token = "",
      headers = {},
      json = undefined,
      body = undefined,
      timeout = 60000,
      signal = null,
      accept = "application/json",
      // Web translation relies on Bing's short-lived Translator session.
      // Keep the default privacy posture for all existing API calls; the
      // dedicated service supplies only its own per-translator cookies when
      // the host permits that header.
      credentials = "omit"
    } = options;
    const link = linkedController(signal, timeout);
    const requestHeaders = {
      "Accept": accept,
      "User-Agent": C.USER_AGENT,
      ...headers
    };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    let requestBody = body;
    if (json !== undefined) {
      requestHeaders["Content-Type"] = "application/json; charset=utf-8";
      requestBody = JSON.stringify(json);
    }
    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: link.controller.signal,
        redirect: "follow",
        credentials,
        cache: "no-store"
      });
      if (!response.ok) {
        const detail = await responseTextSafe(response);
        throw new HTTPError(
          `HTTP ${response.status}: ${detail.slice(0, 4000) || response.statusText}`,
          response.status,
          detail,
          retryAfterMilliseconds(response.headers)
        );
      }
      return response;
    }
    catch (error) {
      if (link.timedOut && !signal?.aborted) {
        throw new RequestTimeoutError(`网络请求超过 ${Math.ceil(timeout / 1000)} 秒仍未完成`);
      }
      if (link.controller.signal.aborted || signal?.aborted || error?.name === "AbortError") {
        throw new U.CancelledError(String(link.controller.signal.reason || signal?.reason || "操作已停止"));
      }
      throw error;
    }
    finally {
      link.cleanup();
    }
  }

  async function requestJSON(method, url, options = {}) {
    const response = await request(method, url, { ...options, accept: "application/json" });
    const text = await responseTextSafe(response);
    try {
      return text ? JSON.parse(text) : {};
    }
    catch (_) {
      throw new HTTPError(`接口返回不是JSON: ${text.slice(0, 800)}`, response.status, text);
    }
  }

  async function requestBytes(url, options = {}) {
    const response = await request("GET", url, { ...options, accept: "application/octet-stream,*/*" });
    return new Uint8Array(await response.arrayBuffer());
  }

  async function uploadBytes(url, bytes, options = {}) {
    // MinerU's OSS presigned upload URL signs the exact headers. In particular,
    // its current file-urls/batch response expects no Content-Type header; a
    // browser-added application/octet-stream value invalidates the signature.
    return request("PUT", url, {
      ...options,
      body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      headers: { ...(options.headers || {}) },
      accept: "*/*"
    });
  }

  async function retry(operation, options = {}) {
    const {
      attempts = 4,
      signal = null,
      shouldRetry = error => (
        !(error instanceof HTTPError)
        || error.status === 408
        || error.status === 429
        || error.status >= 500
      ),
      onRetry = null,
      baseDelay = 1000
    } = options;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      U.throwIfAborted(signal);
      try {
        return await operation(attempt);
      }
      catch (error) {
        lastError = error;
        if (attempt >= attempts || !shouldRetry(error)) throw error;
        onRetry?.(error, attempt + 1, attempts);
        await U.sleep(Math.min(baseDelay * Math.pow(2, attempt - 1), 20000), signal);
      }
    }
    throw lastError || new Error("请求失败");
  }

  function extractOpenAIText(result) {
    const choices = Array.isArray(result?.choices) ? result.choices : [];
    if (choices.length) {
      const choice = choices[0] || {};
      const message = choice.message || {};
      let content = message.content ?? choice.text ?? "";
      if (Array.isArray(content)) {
        content = content.map(item => {
          if (typeof item === "string") return item;
          return String(item?.text ?? item?.content ?? "");
        }).join("");
      }
      if (content) return String(content).trim();
    }
    if (result?.output_text) return String(result.output_text).trim();
    const parts = [];
    for (const item of Array.isArray(result?.output) ? result.output : []) {
      if (String(item?.type || "").toLowerCase() === "reasoning") continue;
      for (const block of Array.isArray(item?.content) ? item.content : []) {
        if (String(block?.type || "").toLowerCase().includes("reason")) continue;
        parts.push(String(block?.text ?? block?.content ?? ""));
      }
    }
    return parts.join("").trim();
  }

  function stringifyReasoning(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(stringifyReasoning).join("");
    if (typeof value === "object") {
      return ["content", "text", "summary", "reasoning_content", "reasoning", "thinking", "thought", "analysis"]
        .map(key => stringifyReasoning(value[key])).join("");
    }
    return String(value);
  }

  function firstReasoningValue(container) {
    if (!container || typeof container !== "object") return "";
    // Gateways sometimes expose the same public reasoning delta through both
    // an alias and reasoning_details.  Those representations are alternatives,
    // not fragments to concatenate.
    for (const key of [
      "reasoning_details", "reasoning", "reasoning_content", "reasoning_text",
      "reasoning_summary", "thinking", "thought", "analysis"
    ]) {
      const value = stringifyReasoning(container[key]);
      if (value) return value;
    }
    return "";
  }

  function extractStreamParts(event) {
    let text = "";
    let reasoning = "";
    const choices = Array.isArray(event?.choices) ? event.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta || {};
      const message = choice?.message || {};
      let content = delta.content ?? delta.text ?? message.content ?? choice?.text ?? "";
      if (Array.isArray(content)) {
        content = content.map(item => typeof item === "string" ? item : String(item?.text ?? item?.content ?? "")).join("");
      }
      text += String(content || "");
      reasoning += firstReasoningValue(delta) || firstReasoningValue(message) || firstReasoningValue(choice);
    }
    if (!reasoning) reasoning = firstReasoningValue(event);
    if (!text && ["response.output_text.delta", "output_text_delta", "text_delta"].includes(event?.type) && event?.delta) {
      text = String(event.delta);
    }
    if (!text && ["message.delta", "content.delta"].includes(event?.type) && event?.delta) {
      const delta = event.delta;
      text = typeof delta === "object"
        ? String(delta.text ?? delta.content ?? "")
        : String(delta);
    }
    if (event?.type === "content_block_delta" && event?.delta && typeof event.delta === "object") {
      if (event.delta.type === "text_delta") text = String(event.delta.text || "");
      if (!reasoning && event.delta.type === "thinking_delta") reasoning = String(event.delta.thinking || "");
    }
    for (const output of Array.isArray(event?.output) ? event.output : []) {
      const isReasoning = String(output?.type || "").toLowerCase() === "reasoning";
      for (const block of Array.isArray(output?.content) ? output.content : []) {
        const value = block?.text ?? block?.summary ?? block?.content ?? "";
        if (!reasoning && (isReasoning || String(block?.type || "").toLowerCase().includes("reason"))) reasoning = stringifyReasoning(value);
      }
    }
    if (!reasoning && event?.type === "response.reasoning_summary_text.delta" && event?.delta) {
      reasoning = String(event.delta);
    }
    for (const key of ["reasoning_delta", "thinking_delta", "analysis_delta"]) {
      if (!reasoning && event?.[key] !== undefined && event?.[key] !== null) reasoning = stringifyReasoning(event[key]);
    }
    return {
      text,
      reasoning,
      usage: event?.usage || choices[0]?.usage || null,
      model: String(event?.model || choices[0]?.model || event?.response?.model || "").trim()
    };
  }

  function trailingTagPrefixLength(value, tag) {
    const text = String(value || "");
    const max = Math.min(text.length, tag.length - 1);
    for (let length = max; length > 0; length--) {
      if (text.endsWith(tag.slice(0, length))) return length;
    }
    return 0;
  }

  async function streamOpenAI(url, payload, options = {}) {
    const {
      token = "",
      headers = {},
      timeout = 300000,
      signal = null,
      onText = null,
      onReasoning = null,
      onUsage = null,
      firstEventTimeout = 0,
      inactivityTimeout = 0
    } = options;
    const link = linkedController(signal, timeout);
    const requestHeaders = {
      "Authorization": token ? `Bearer ${token}` : undefined,
      "Content-Type": "application/json; charset=utf-8",
      "Accept": "text/event-stream, application/json",
      ...headers
    };
    for (const key of Object.keys(requestHeaders)) {
      if (requestHeaders[key] === undefined || requestHeaders[key] === "") delete requestHeaders[key];
    }

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
        signal: link.controller.signal,
        redirect: "follow",
        credentials: "omit",
        cache: "no-store"
      });
      if (!response.ok) {
        const detail = await responseTextSafe(response);
        throw new HTTPError(
          `HTTP ${response.status}: ${detail.slice(0, 4000) || response.statusText}`,
          response.status,
          detail,
          retryAfterMilliseconds(response.headers)
        );
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/event-stream") || !response.body) {
        const text = await responseTextSafe(response);
        let result;
        try { result = JSON.parse(text); }
        catch (_) { throw new HTTPError(`接口返回无法解析: ${text.slice(0, 1200)}`, response.status, text); }
        const parsed = extractStreamParts(result);
        const content = extractOpenAIText(result) || parsed.text;
        const taggedReasoning = [parsed.reasoning].filter(Boolean);
        const visible = String(content || "").replace(/<(think|thought)>([\s\S]*?)<\/\1>/g, (_, _tag, value) => {
          taggedReasoning.push(String(value || ""));
          return "";
        });
        if (taggedReasoning.length) onReasoning?.(taggedReasoning.join(""));
        if (visible) onText?.(visible);
        if (result?.usage) onUsage?.(result.usage);
        if (!visible) throw new Error("模型接口没有返回正文");
        return {
          text: visible,
          reasoning: taggedReasoning.join(""),
          usage: result?.usage || null,
          model: String(result?.model || result?.response?.model || "").trim()
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let fullText = "";
      let fullReasoning = "";
      let finalUsage = null;
      let actualModel = "";
      let activeThoughtTag = "";
      let taggedPending = "";

      const appendVisible = value => {
        if (!value) return;
        fullText += value;
        onText?.(value);
      };
      const appendReasoning = value => {
        if (!value) return;
        fullReasoning += value;
        onReasoning?.(value);
      };
      const processTaggedText = raw => {
        let value = taggedPending + String(raw || "");
        taggedPending = "";
        while (value) {
          if (activeThoughtTag) {
            const closeTag = `</${activeThoughtTag}>`;
            const index = value.indexOf(closeTag);
            if (index >= 0) {
              appendReasoning(value.slice(0, index));
              value = value.slice(index + closeTag.length);
              activeThoughtTag = "";
              continue;
            }
            const keep = trailingTagPrefixLength(value, closeTag);
            appendReasoning(keep ? value.slice(0, -keep) : value);
            taggedPending = keep ? value.slice(-keep) : "";
            break;
          }
          const openings = ["think", "thought"]
            .map(name => ({ name, tag: `<${name}>`, index: value.indexOf(`<${name}>`) }))
            .filter(item => item.index >= 0);
          if (openings.length) {
            const opening = openings.sort((left, right) => left.index - right.index)[0];
            appendVisible(value.slice(0, opening.index));
            value = value.slice(opening.index + opening.tag.length);
            activeThoughtTag = opening.name;
            continue;
          }
          const keep = Math.max(
            trailingTagPrefixLength(value, "<think>"),
            trailingTagPrefixLength(value, "<thought>")
          );
          appendVisible(keep ? value.slice(0, -keep) : value);
          taggedPending = keep ? value.slice(-keep) : "";
          break;
        }
      };

      const processEvent = rawEvent => {
        const dataLines = String(rawEvent || "").split(/\r?\n/)
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trim());
        if (!dataLines.length) return false;
        const data = dataLines.join("\n");
        if (!data || data === "[DONE]") return data === "[DONE]";
        let event;
        try { event = JSON.parse(data); }
        catch (_) { return false; }
        const parts = extractStreamParts(event);
        if (parts.model) actualModel = parts.model;
        if (parts.reasoning) {
          appendReasoning(parts.reasoning);
        }
        if (parts.text) {
          processTaggedText(parts.text);
        }
        if (parts.usage) {
          finalUsage = parts.usage;
          onUsage?.(parts.usage);
        }
        return false;
      };

      const drainEvents = () => {
        let done = false;
        let boundary;
        // Standards-compliant SSE events are separated by a blank line.
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const eventText = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (processEvent(eventText)) return true;
        }
        // A number of OpenAI-compatible gateways emit one complete `data:`
        // JSON record per newline without the required blank separator. Process
        // only lines whose payload is already valid JSON so split network chunks
        // and legitimate multi-line SSE events remain buffered safely.
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, boundary);
          const trimmed = line.trim();
          if (!trimmed) {
            buffer = buffer.slice(boundary + 1);
            continue;
          }
          if (!trimmed.startsWith("data:")) break;
          const payloadText = trimmed.slice(5).trim();
          if (payloadText !== "[DONE]") {
            try { JSON.parse(payloadText); }
            catch (_) { break; }
          }
          buffer = buffer.slice(boundary + 1);
          if (processEvent(line)) return true;
        }
        return done;
      };

      let done = false;
      let receivedChunk = false;
      while (!done) {
        U.throwIfAborted(signal);
        const waitMs = receivedChunk ? inactivityTimeout : firstEventTimeout;
        const chunk = await readStreamChunk(
          reader,
          waitMs,
          receivedChunk
            ? `模型流式响应连续 ${Math.ceil(waitMs / 1000)} 秒没有新数据`
            : `模型在 ${Math.ceil(waitMs / 1000)} 秒内没有返回首个流式数据`
        );
        if (chunk.done) break;
        receivedChunk = true;
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n?/g, "\n");
        done = drainEvents();
      }
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n?/g, "\n");
      if (!done) done = drainEvents();
      if (!done && buffer.trim()) processEvent(buffer);
      if (taggedPending) {
        if (activeThoughtTag) appendReasoning(taggedPending);
        else appendVisible(taggedPending);
        taggedPending = "";
      }
      if (done) {
        try { await reader.cancel(); } catch (_) {}
      }
      if (!fullText.trim()) throw new Error("模型流式接口没有返回正文");
      return { text: fullText.trim(), reasoning: fullReasoning, usage: finalUsage, model: actualModel };
    }
    catch (error) {
      if (link.timedOut && !signal?.aborted) {
        throw new RequestTimeoutError(`模型请求超过 ${Math.ceil(timeout / 1000)} 秒仍未完成`);
      }
      if (link.controller.signal.aborted || signal?.aborted || error?.name === "AbortError") {
        throw new U.CancelledError(String(link.controller.signal.reason || signal?.reason || "操作已停止"));
      }
      throw error;
    }
    finally {
      link.cleanup();
    }
  }


  function geminiUsageToOpenAI(value) {
    const normalized = LitMTrans.PortedCore?.normalizeUsage
      ? LitMTrans.PortedCore.normalizeUsage(value)
      : {
          inputTokens: Number(value?.input_tokens || value?.prompt_tokens || value?.inputTokenCount || 0),
          outputTokens: Number(value?.output_tokens || value?.completion_tokens || value?.outputTokenCount || 0),
          totalTokens: Number(value?.total_tokens || value?.totalTokenCount || 0),
          cachedInputTokens: Number(value?.cached_input_tokens || 0),
          reasoningTokens: Number(value?.reasoning_tokens || 0)
        };
    const cachedInputTokens = Number(
      normalized.cachedInputTokens
      || value?.cachedContentTokenCount
      || value?.cached_content_token_count
      || value?.promptTokenDetails?.cachedTokenCount
      || 0
    );
    return {
      prompt_tokens: normalized.inputTokens,
      completion_tokens: normalized.outputTokens,
      total_tokens: normalized.totalTokens || normalized.inputTokens + normalized.outputTokens,
      prompt_tokens_details: { cached_tokens: cachedInputTokens },
      completion_tokens_details: { reasoning_tokens: normalized.reasoningTokens }
    };
  }

  function parseGeminiInteractionEvent(event, eventName = "") {
    const value = event && typeof event === "object" ? { ...event } : {};
    if (!value.type && eventName) value.type = eventName;
    if (LitMTrans.PortedCore?.parseGeminiInteractionEvent) {
      const parsed = LitMTrans.PortedCore.parseGeminiInteractionEvent(value);
      return {
        ...parsed,
        usage: parsed.usage ? geminiUsageToOpenAI(parsed.usage) : null
      };
    }
    const type = String(value.type || eventName || "");
    const delta = value.delta && typeof value.delta === "object" ? value.delta : {};
    const text = /thought|reason/i.test(String(delta.type || "")) ? "" : String(delta.text || delta.content || value.text || "");
    const reasoning = /thought|reason/i.test(String(delta.type || "")) ? String(delta.text || delta.content || "") : "";
    return {
      text,
      reasoning,
      usage: value.usage ? geminiUsageToOpenAI(value.usage) : null,
      model: String(value.model || value.interaction?.model || ""),
      done: /completed|done|failed|error/i.test(type),
      error: value.error?.message || (/failed|error/i.test(type) ? String(value.message || "Gemini请求失败") : "")
    };
  }

  async function streamGeminiInteractions(url, payload, options = {}) {
    const {
      apiKey = "",
      headers = {},
      timeout = 300000,
      signal = null,
      onText = null,
      onReasoning = null,
      onUsage = null,
      firstEventTimeout = 0,
      inactivityTimeout = 0
    } = options;
    const link = linkedController(signal, timeout);
    const requestHeaders = {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json; charset=utf-8",
      "Accept": "text/event-stream, application/json",
      ...headers
    };
    for (const key of Object.keys(requestHeaders)) {
      if (requestHeaders[key] === undefined || requestHeaders[key] === "") delete requestHeaders[key];
    }

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
        signal: link.controller.signal,
        redirect: "follow",
        credentials: "omit",
        cache: "no-store"
      });
      if (!response.ok) {
        const detail = await responseTextSafe(response);
        throw new HTTPError(
          `HTTP ${response.status}: ${detail.slice(0, 4000) || response.statusText}`,
          response.status,
          detail,
          retryAfterMilliseconds(response.headers)
        );
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/event-stream") || !response.body) {
        const text = await responseTextSafe(response);
        let result;
        try { result = text ? JSON.parse(text) : {}; }
        catch (_) { throw new HTTPError(`Gemini接口返回无法解析: ${text.slice(0, 1200)}`, response.status, text); }
        const parsed = parseGeminiInteractionEvent({ ...result, type: result.type || "interaction.completed" });
        const visible = parsed.text || LitMTrans.PortedCore?.extractGeminiInteractionText?.(result) || "";
        const reasoning = parsed.reasoning || LitMTrans.PortedCore?.extractGeminiThoughtSummary?.(result) || "";
        const usage = parsed.usage || (result.usage ? geminiUsageToOpenAI(result.usage) : null);
        if (parsed.error) throw new HTTPError(parsed.error, response.status, text);
        if (!visible.trim()) throw new Error("Gemini接口没有返回正文");
        if (reasoning) onReasoning?.(reasoning);
        onText?.(visible);
        if (usage) onUsage?.(usage);
        return { text: visible.trim(), reasoning, usage, model: parsed.model || String(result.model || "") };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let fullText = "";
      let fullReasoning = "";
      let finalUsage = null;
      let actualModel = "";
      let terminal = false;
      let receivedChunk = false;

      const processFrame = rawFrame => {
        const lines = String(rawFrame || "").split(/\r?\n/);
        let eventName = "";
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) return false;
        const data = dataLines.join("\n").trim();
        if (!data || data === "[DONE]") return data === "[DONE]";
        let event;
        try { event = JSON.parse(data); }
        catch (_) { return false; }
        const parsed = parseGeminiInteractionEvent(event, eventName);
        if (parsed.error) throw new HTTPError(parsed.error, 0, data);
        if (parsed.model) actualModel = parsed.model;
        if (parsed.reasoning) {
          fullReasoning += parsed.reasoning;
          onReasoning?.(parsed.reasoning);
        }
        if (parsed.text) {
          fullText += parsed.text;
          onText?.(parsed.text);
        }
        if (parsed.usage) {
          finalUsage = parsed.usage;
          onUsage?.(parsed.usage);
        }
        return Boolean(parsed.done);
      };

      const drain = () => {
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (processFrame(frame)) return true;
        }
        return false;
      };

      while (!terminal) {
        U.throwIfAborted(signal);
        const waitMs = receivedChunk ? inactivityTimeout : firstEventTimeout;
        const chunk = await readStreamChunk(
          reader,
          waitMs,
          receivedChunk
            ? `Gemini流式响应连续 ${Math.ceil(waitMs / 1000)} 秒没有新数据`
            : `Gemini在 ${Math.ceil(waitMs / 1000)} 秒内没有返回首个流式数据`
        );
        if (chunk.done) break;
        receivedChunk = true;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, "\n");
        terminal = drain();
      }
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n?/g, "\n");
      if (!terminal) terminal = drain();
      if (!terminal && buffer.trim()) processFrame(buffer);
      if (terminal) {
        try { await reader.cancel(); } catch (_) {}
      }
      if (!fullText.trim()) throw new Error("Gemini流式接口没有返回正文");
      return { text: fullText.trim(), reasoning: fullReasoning, usage: finalUsage, model: actualModel };
    }
    catch (error) {
      if (link.timedOut && !signal?.aborted) {
        throw new RequestTimeoutError(`Gemini请求超过 ${Math.ceil(timeout / 1000)} 秒仍未完成`);
      }
      if (link.controller.signal.aborted || signal?.aborted || error?.name === "AbortError") {
        throw new U.CancelledError(String(link.controller.signal.reason || signal?.reason || "操作已停止"));
      }
      throw error;
    }
    finally {
      link.cleanup();
    }
  }

  LitMTrans.HTTP = {
    HTTPError,
    RequestTimeoutError,
    StreamTimeoutError,
    retryAfterMilliseconds,
    request,
    requestJSON,
    requestBytes,
    uploadBytes,
    retry,
    extractOpenAIText,
    extractStreamParts,
    streamOpenAI,
    geminiUsageToOpenAI,
    parseGeminiInteractionEvent,
    streamGeminiInteractions
  };
})(this);
