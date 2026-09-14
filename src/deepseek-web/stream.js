(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};

  class DeepSeekSSEParser {
    constructor() {
      this.buffer = "";
      this.event = [];
      this.decoder = typeof TextDecoder === "function" ? new TextDecoder() : null;
    }

    push(chunk, final = false) {
      let text;
      if (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) {
        text = this.decoder ? this.decoder.decode(chunk, { stream: !final }) : String(chunk);
      } else {
        text = String(chunk || "");
      }
      if (final && this.decoder) text += this.decoder.decode();
      this.buffer += text;
      const records = [];
      let match;
      while ((match = this.buffer.match(/^(.*?)(\r\n|\n|\r)/))) {
        this.buffer = this.buffer.slice(match[0].length);
        this._line(match[1], records);
      }
      if (final && this.buffer) {
        this._line(this.buffer, records);
        this.buffer = "";
      }
      if (final) {
        this._flush(records);
        this.buffer = "";
      }
      return records;
    }

    _line(line, records) {
      if (line === "") return this._flush(records);
      if (line.startsWith(":")) return;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.event.push(value);
    }

    _flush(records) {
      if (!this.event.length) return;
      const value = this.event.join("\n");
      const pending = this.event.slice();
      this.event = [];
      if (!value || value === "[DONE]") return;
      try {
        records.push(JSON.parse(value));
      } catch (_) {
        for (const item of pending) {
          try { records.push(JSON.parse(item)); }
          catch (_) { records.push({ __malformed: true, raw: item }); }
        }
      }
    }
  }

  class DeepSeekReplyAccumulator {
    constructor() {
      this.body = "";
      this.reasoning = "";
      this.currentType = "RESPONSE";
      this.finished = false;
      this.searchResults = [];
      this.openById = new Map();
      this.references = [];
      this.events = [];
      this.malformed = 0;
      this.lastProgress = false;
    }

    _isThinking(type) {
      return typeof type === "string" && type.toUpperCase().includes("THINK");
    }

    _urlIndex() {
      const result = new Map();
      this.searchResults.forEach((url, index) => {
        if (url && !result.has(url)) result.set(url, index);
      });
      return result;
    }

    _resolveCitations(text, refs = this.references) {
      if (!Array.isArray(refs) || !refs.length) return String(text || "");
      const urls = this._urlIndex();
      let index = 0;
      return String(text || "").replace(/\[reference:\d+\]/g, () => {
        const ref = refs[index++];
        if (!ref || ref.type !== "TOOL_OPEN") return "";
        const url = this.openById.get(ref.id);
        const position = urls.get(url);
        return position === undefined ? "" : `[citation:${position + 1}]`;
      });
    }

    _append(type, value, kind = "delta") {
      if (typeof value !== "string" || !value) return;
      const target = this._isThinking(type || this.currentType) ? "reasoning" : "body";
      const text = target === "body" ? this._resolveCitations(value) : value;
      this[target] += text;
      this.lastProgress = true;
      this.events.push({
        type: target === "body"
          ? (kind === "snapshot" ? "text_snapshot" : "text_delta")
          : (kind === "snapshot" ? "reasoning_snapshot" : "reasoning_delta"),
        text,
        delta: text
      });
    }

    _fragments(fragments, mode = "append") {
      const body = [];
      const reasoning = [];
      const opened = [];
      for (const fragment of Array.isArray(fragments) ? fragments : []) {
        if (!fragment || typeof fragment !== "object") continue;
        const type = typeof fragment.type === "string" ? fragment.type : this.currentType;
        this.currentType = type;
        const content = typeof fragment.content === "string" ? fragment.content : "";
        if (content) (this._isThinking(type) ? reasoning : body).push(content);
        if (type === "TOOL_OPEN") {
          const result = fragment.result;
          if (typeof fragment.id === "number" && typeof result?.url === "string" && result.url) {
            this.openById.set(fragment.id, result.url);
          }
          if (typeof result?.title === "string" && result.title) opened.push(result.title);
        }
      }
      if (mode === "snapshot") {
        const nextBody = body.join("");
        const nextReasoning = reasoning.join("");
        this.body = nextBody;
        this.reasoning = nextReasoning;
        this.events.push({ type: "text_snapshot", text: nextBody, delta: nextBody });
        this.events.push({ type: "reasoning_snapshot", text: nextReasoning, delta: nextReasoning });
        this.lastProgress = Boolean(nextBody || nextReasoning);
      } else {
        this._append("RESPONSE", body.join(""));
        this._append("THINK", reasoning.join(""));
      }
      if (opened.length) {
        const note = `\n\n浏览 ${opened.length} 个页面\n${opened.map(title => `- ${title}`).join("\n")}\n\n`;
        this.reasoning += note;
        this.events.push({ type: "reasoning_delta", text: note, delta: note });
        this.lastProgress = true;
      }
    }

    _batch(ops) {
      let content = "";
      let refs = this.references;
      const fragments = [];
      for (const item of Array.isArray(ops) ? ops : []) {
        if (!item || typeof item !== "object") continue;
        if (item.p === "content" && item.o === "APPEND" && typeof item.v === "string") content += item.v;
        if (item.p === "references" && Array.isArray(item.v)) refs = item.v;
        if (item.p === "fragments" && item.o === "APPEND" && Array.isArray(item.v)) fragments.push(...item.v);
      }
      this.references = refs;
      if (fragments.length) this._fragments(fragments);
      if (content) this._append(this.currentType, this._resolveCitations(content, refs));
    }

    apply(record) {
      this.lastProgress = false;
      if (!record || typeof record !== "object") return;
      if (record.__malformed) { this.malformed++; return; }
      const value = record.v;
      if (value && typeof value === "object" && !Array.isArray(value) && value.response) {
        const fragments = value.response?.fragments;
        if (Array.isArray(fragments)) this._fragments(fragments, "snapshot");
        return;
      }
      if (record.p === "response/fragments" && record.o === "APPEND" && Array.isArray(value)) {
        this._fragments(value);
        return;
      }
      if (typeof record.p === "string") {
        if (record.p === "response/fragments/-1/content" && record.o !== "SET" && typeof value === "string") {
          this._append(this.currentType, value);
        } else if (record.p === "response/fragments/-1/results" && record.o === "SET" && Array.isArray(value)) {
          for (const item of value) {
            if (typeof item?.url === "string" && item.url) this.searchResults.push(item.url);
          }
          const note = `\n\n搜索到 ${value.length} 个网页\n\n`;
          this.reasoning += note;
          this.events.push({ type: "reasoning_delta", text: note, delta: note });
          this.lastProgress = true;
        } else if (record.p === "response/status" && record.o === "SET" && value === "FINISHED") {
          this.finished = true;
        } else if (record.o === "BATCH" && Array.isArray(value)) {
          this._batch(value);
        }
        return;
      }
      if (Array.isArray(value)) this._batch(value);
      else if (typeof value === "string") this._append(this.currentType, value);
    }

    result() {
      const content = this.body.trim();
      const reasoning = this.reasoning.trim();
      return {
        content,
        reasoning,
        finished: this.finished,
        events: this.events.splice(0),
        malformed: this.malformed,
        progressed: this.lastProgress
      };
    }
  }

  function createStreamDispatcher(callbacks = {}) {
    const parser = new DeepSeekSSEParser();
    const accumulator = new DeepSeekReplyAccumulator();
    let emittedBodyLength = 0;
    let emittedReasoningLength = 0;

    return {
      feed(chunk, final = false) {
        const records = parser.push(chunk, final);
        for (const record of records) {
          accumulator.apply(record);
        }
        const state = accumulator.result();
        if (state.events.length) {
          for (const ev of state.events) {
            if (ev.type === "text_delta") {
              callbacks.onText?.(ev.delta);
              emittedBodyLength += ev.delta.length;
            } else if (ev.type === "reasoning_delta") {
              callbacks.onReasoning?.(ev.delta);
              emittedReasoningLength += ev.delta.length;
            } else if (ev.type === "text_snapshot") {
              const delta = ev.text.slice(emittedBodyLength);
              if (delta) {
                callbacks.onText?.(delta);
                emittedBodyLength = ev.text.length;
              }
            } else if (ev.type === "reasoning_snapshot") {
              const delta = ev.text.slice(emittedReasoningLength);
              if (delta) {
                callbacks.onReasoning?.(delta);
                emittedReasoningLength = ev.text.length;
              }
            }
          }
        }
        return {
          finished: accumulator.finished || final,
          body: accumulator.body,
          reasoning: accumulator.reasoning
        };
      },
      getResult() {
        return {
          content: accumulator.body.trim(),
          reasoning: accumulator.reasoning.trim(),
          finished: accumulator.finished
        };
      },
      isFinished() {
        return accumulator.finished;
      }
    };
  }

  LitMTrans.DeepSeekWeb.DeepSeekSSEParser = DeepSeekSSEParser;
  LitMTrans.DeepSeekWeb.DeepSeekReplyAccumulator = DeepSeekReplyAccumulator;
  LitMTrans.DeepSeekWeb.createStreamDispatcher = createStreamDispatcher;
})(this);
