/*
 * Web translation route used by LitMTrans.
 * It expects LitMTrans.HTTP.request and LitMTrans.Utils.
 */
(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const H = LitMTrans.HTTP;
  const U = LitMTrans.Utils || {};
  const GOOGLE = "google_free";
  const BING = "bing_free";
  const WEB = "free_machine";
  const EDGE = "edge_local";
  const GOOGLE_CHARS = 4500, GOOGLE_BATCH_CHARS = 4200;
  const BING_INITIAL_CHARS = 3000, BING_MIN_CHARS = 900, BING_BATCH_CHARS = 2600;
  const MIN_BATCH_CHARS = 700, BING_RETRIES = 3, BING_RETRY_DELAY = 2000;
  const BING_SESSION_TTL = 300000, BING_PARALLELISM = 2;
  const GOOGLE_PROBE_TIMEOUT = 2000, GOOGLE_TIMEOUT = 12000;
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  class WebMachineTranslationError extends Error {
    constructor(message, cause = null) { super(message); this.name = "WebMachineTranslationError"; this.cause = cause; }
  }
  const escapeRE = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Keep sentinel construction synchronous so protected ranges remain stable
  // throughout batching and response cleanup.
  function sha1(value) {
    const bytes = new TextEncoder().encode(String(value));
    const bitLength = bytes.length * 8;
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, bitLength >>> 0, false);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
    let h0=0x67452301,h1=0xEFCDAB89,h2=0x98BADCFE,h3=0x10325476,h4=0xC3D2E1F0;
    const words = new Uint32Array(80);
    for (let offset=0; offset<padded.length; offset+=64) {
      for(let i=0;i<16;i++) words[i]=view.getUint32(offset+i*4,false);
      for(let i=16;i<80;i++) { const n=words[i-3]^words[i-8]^words[i-14]^words[i-16]; words[i]=(n<<1)|(n>>>31); }
      let a=h0,b=h1,c=h2,d=h3,e=h4;
      for(let i=0;i<80;i++) { const f=i<20?(b&c)|((~b)&d):i<40?b^c^d:i<60?(b&c)|(b&d)|(c&d):b^c^d; const k=i<20?0x5A827999:i<40?0x6ED9EBA1:i<60?0x8F1BBCDC:0xCA62C1D6; const t=(((a<<5)|(a>>>27))+f+e+k+words[i])>>>0; e=d;d=c;c=(b<<30)|(b>>>2);b=a;a=t; }
      h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;
    }
    return [h0,h1,h2,h3,h4].map(n=>n.toString(16).padStart(8,"0")).join("").toUpperCase();
  }
  function htmlDecode(value) {
    let documentLike = global.document;
    try { documentLike ||= Services?.appShell?.hiddenDOMWindow?.document; } catch (_) {}
    const element = documentLike?.createElement?.("textarea");
    if (element) { element.innerHTML = String(value); return element.value; }
    // The host normally supplies a DOM decoder. Retain a lossless fallback
    // for the few test/bootstrap contexts where it does not.
    return String(value)
      .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
  }
  const removeControls = value => Array.from(String(value || "")).filter(ch => !/\p{C}/u.test(ch)).join("");
  function isCancellationError(error) {
    return Boolean(error?.cancelled || error?.name === "AbortError" || error?.name === "CancelledError");
  }
  function rethrowCancellation(error, signal) {
    if (signal?.aborted && U.throwIfAborted) U.throwIfAborted(signal);
    if (isCancellationError(error)) throw error;
  }
  const abort = signal => {
    if (!signal?.aborted) return;
    if (U.throwIfAborted) U.throwIfAborted(signal);
    throw new (U.CancelledError || Error)("用户已停止翻译。");
  };
  const sleep = (ms, signal) => U.sleep ? U.sleep(ms, signal) : new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new (U.CancelledError || Error)("用户已停止翻译。"));
    }, { once: true });
  });

  function languageCode(language, provider) {
    const raw = String(language || "").trim(), normalized = raw.toLowerCase();
    const google = { "简体中文":"zh-CN", "中文":"zh-CN", "繁体中文":"zh-TW", "英文":"en", "英语":"en", english:"en", "日文":"ja", "日语":"ja", "韩文":"ko", "韩语":"ko" };
    const bing = { "简体中文":"zh-Hans", "中文":"zh-Hans", "繁体中文":"zh-Hant", "英文":"en", "英语":"en", english:"en", "日文":"ja", "日语":"ja", "韩文":"ko", "韩语":"ko" };
    const map = provider === BING ? bing : google;
    return map[raw] || map[normalized] || normalized || "zh-CN";
  }
  function splitText(text, limit) {
    const raw = String(text || ""); if (raw.length <= limit) return raw ? [raw] : [];
    const result = []; let current = "";
    for (let part of raw.split(/(\n+|(?<=[.!?。！？；;])\s+)/)) {
      if (!part) continue;
      if (current && current.length + part.length > limit) { result.push(current); current = ""; }
      while (part.length > limit) { if (current) { result.push(current); current = ""; } result.push(part.slice(0, limit)); part = part.slice(limit); }
      current += part;
    }
    if (current) result.push(current); return result;
  }
  function shouldTranslateText(value) { const text = String(value || "").trim(); return Boolean(text) && !/^[\W\d_]+$/u.test(text) && /[A-Za-z]{3,}/.test(text); }

  class WebMachineTranslator {
    constructor(provider, targetLanguage, sourceLanguage = "auto", options = {}) {
      this.providerId = provider === WEB ? GOOGLE : String(provider || "").toLowerCase();
      if (![GOOGLE, BING].includes(this.providerId)) throw new WebMachineTranslationError(`不支持的联网翻译服务：${provider}`);
      this.targetLanguage = targetLanguage; this.sourceLanguage = sourceLanguage; this.timeout = Number(options.timeout || 30000);
      this.targetCode = languageCode(targetLanguage, this.providerId);
      this.sourceCode = !sourceLanguage || /^(auto|auto-detect|自动|自动检测|自动识别)$/i.test(String(sourceLanguage).trim()) ? "auto" : languageCode(sourceLanguage, this.providerId);
      this.bingSession = null; this.bingExpiresAt = 0;
      // Fetch credentials are deliberately omitted so cloned workers cannot
      // share Zotero's browser cookie jar. Keep only cookies returned for this
      // translator instance.
      this.cookies = new Map();
    }
    get maxChars() { return this.providerId === BING ? BING_INITIAL_CHARS : GOOGLE_CHARS; }
    cloneForWorker() { return new WebMachineTranslator(this.providerId, this.targetLanguage, this.sourceLanguage, { timeout: this.timeout }); }
    cookieHeader() {
      return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    captureCookies(response) {
      const raw = response?.headers?.get?.("set-cookie") || response?.headers?.get?.("Set-Cookie") || "";
      for (const match of String(raw).matchAll(/(?:^|,\s*)([^=;,\s]+)=([^;,]*)/g)) {
        const name = String(match[1] || "").trim();
        if (name) this.cookies.set(name, String(match[2] || "").trim());
      }
    }
    async openText(url, options = {}) {
      try {
        const headers = { ...(options.headers || {}) };
        const cookie = this.cookieHeader();
        if (cookie && !headers.Cookie && !headers.cookie) headers.Cookie = cookie;
        const response = await H.request(options.method || "GET", url, {
          body: options.body,
          headers,
          timeout: options.timeout || this.timeout,
          signal: options.signal,
          accept: options.accept || "text/html,*/*",
          credentials: "omit"
        });
        this.captureCookies(response);
        return { text: await response.text(), finalURL: response.url || url };
      }
      catch (error) {
        rethrowCancellation(error, options.signal);
        throw new WebMachineTranslationError(`联网翻译网络请求失败：${error?.message || error}`, error);
      }
    }
    async translate(text, signal) {
      const source = String(text || ""); if (!source.trim()) return source; abort(signal);
      const parts = splitText(source, this.maxChars);
      const translated = [];
      // Keep requests for one translator serial so session state and rate
      // limits remain predictable. Independent document batches use workers.
      for (const part of parts) translated.push(this.providerId === BING ? await this.translateBingAdaptive(part, this.maxChars, signal) : await this.translateGoogle(part, signal));
      return translated.join("");
    }
    async translateGoogle(text, signal) {
      const query = new URLSearchParams({ tl: this.targetCode, sl: this.sourceCode, q: text });
      const { text: page } = await this.openText(`https://translate.google.com/m?${query}`, { signal, headers: { "User-Agent": "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1)" } });
      const match = /class="(?:t0|result-container)">(.*?)</s.exec(page);
      if (!match) throw new WebMachineTranslationError("Google联网翻译暂时没有返回译文。");
      return removeControls(htmlDecode(match[1]));
    }
    async probeGoogle(signal) { await this.translateGoogle("network test", signal); }
    async bingSID(signal, forceRefresh = false) {
      if (!forceRefresh && this.bingSession && Date.now() < this.bingExpiresAt) return this.bingSession;
      const { text: page, finalURL } = await this.openText("https://www.bing.com/translator", { signal, headers: { "User-Agent": USER_AGENT } });
      const ig = /"ig":"(.*?)"/.exec(page)?.[1]; const iids = [...page.matchAll(/data-iid="(.*?)"/g)];
      const token = /params_AbusePreventionHelper\s*=\s*\[(.*?),"(.*?)",/.exec(page);
      if (!ig || !iids.length || !token) throw new WebMachineTranslationError("Bing联网翻译暂时不可用。");
      const marker = "/translator"; const baseURL = finalURL.includes(marker) ? `${finalURL.split(marker)[0].replace(/\/$/, "")}/` : "https://www.bing.com/";
      this.bingSession = { baseURL, ig, iid: iids.at(-1)[1], key: token[1], token: token[2] }; this.bingExpiresAt = Date.now() + BING_SESSION_TTL;
      return this.bingSession;
    }
    invalidateBingSession() { this.bingSession = null; this.bingExpiresAt = 0; }
    async translateBingOnce(text, signal, refreshSession = false) {
      const session = await this.bingSID(signal, refreshSession);
      const body = new URLSearchParams({ fromLang: this.sourceCode === "auto" ? "auto-detect" : this.sourceCode, to: this.targetCode, text, token: session.token, key: session.key }).toString();
      const { text: response } = await this.openText(`${session.baseURL}ttranslatev3?IG=${encodeURIComponent(session.ig)}&IID=${encodeURIComponent(session.iid)}`, { method: "POST", signal, body, accept: "application/json", headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.bing.com/translator" } });
      try { const payload = JSON.parse(response); if (payload && !Array.isArray(payload) && payload.statusCode) { this.invalidateBingSession(); throw new WebMachineTranslationError("Bing联网翻译连接已失效。"); } return removeControls(String(payload[0].translations[0].text)); }
      catch (error) { if (error instanceof WebMachineTranslationError) throw error; throw new WebMachineTranslationError("Bing联网翻译暂时无法返回译文。", error); }
    }
    async translateBing(text, signal) {
      let last; for (let attempt = 1; attempt <= BING_RETRIES; attempt++) { abort(signal); try { return await this.translateBingOnce(text, signal, attempt > 1); } catch (error) { rethrowCancellation(error, signal); last = error; if (attempt < BING_RETRIES && !String(error).includes("会话参数失效")) await sleep(BING_RETRY_DELAY, signal); } }
      throw last || new WebMachineTranslationError("Bing联网翻译失败，请稍后重试。");
    }
    async translateBingAdaptive(text, limit, signal) {
      const source = String(text || ""); if (source.length <= BING_MIN_CHARS) return this.translateBing(source, signal);
      try { return await this.translateBing(source, signal); }
      catch (error) {
        rethrowCancellation(error, signal);
        let next = Math.max(BING_MIN_CHARS, Math.min(Math.floor(limit / 2), Math.floor(source.length / 2) || BING_MIN_CHARS));
        if (next >= source.length) next = Math.max(BING_MIN_CHARS, Math.floor(source.length / 2));
        if (next <= 0 || next >= source.length) throw error;
        const parts = splitText(source, next);
        if (parts.length <= 1) throw error;
        // Keep the recursive downgrade serial. A rejected Bing session must
        // not fan out into concurrent retry requests.
        const translated = [];
        for (const part of parts) translated.push(await this.translateBingAdaptive(part, next, signal));
        return translated.join("");
      }
    }
  }

  class FallbackMachineTranslator {
    constructor(targetLanguage, sourceLanguage = "auto", log = null) { this.targetLanguage = targetLanguage; this.sourceLanguage = sourceLanguage; this.log = log; this.currentProvider = GOOGLE; this.translator = new WebMachineTranslator(GOOGLE, targetLanguage, sourceLanguage, { timeout: GOOGLE_TIMEOUT }); this.googleProbeChecked = false; this.googleProbeSucceeded = false; this.googleProbeError = ""; this.bingTranslator = null; }
    get maxChars() { return this.translator.maxChars; }
    cloneForWorker() { return this.currentProvider === BING ? this.switchToBing(new WebMachineTranslationError("Google 已被判定不可达")).cloneForWorker() : this.translator.cloneForWorker(); }
    async probeGoogleIfNeeded(signal) { if (this.currentProvider !== GOOGLE || this.googleProbeChecked) return; const probe = new WebMachineTranslator(GOOGLE, this.targetLanguage, this.sourceLanguage, { timeout: GOOGLE_PROBE_TIMEOUT }); try { await probe.probeGoogle(signal); this.googleProbeChecked = true; this.googleProbeSucceeded = true; this.googleProbeError = ""; } catch (error) { rethrowCancellation(error, signal); this.googleProbeChecked = true; this.googleProbeSucceeded = false; this.googleProbeError = String(error); throw new WebMachineTranslationError(`Google联网翻译连接失败：${error}`, error); } }
    switchToBing(_reason) { if (this.currentProvider !== BING) { this.currentProvider = BING; this.bingTranslator = new WebMachineTranslator(BING, this.targetLanguage, this.sourceLanguage); this.log?.("正在尝试Bing翻译，该服务较慢，请稍等。"); } return this.bingTranslator; }
    async translate(text, signal) { if (this.currentProvider === BING) return this.switchToBing(new WebMachineTranslationError("Google 已被判定不可达")).translate(text, signal); try { await this.probeGoogleIfNeeded(signal); return await this.translator.translate(text, signal); } catch (error) { rethrowCancellation(error, signal); return this.switchToBing(error).translate(text, signal); } }
  }

  class AsyncMutex {
    constructor() { this.locked = false; this.waiters = []; }
    async acquire(signal) {
      abort(signal);
      return new Promise((resolve, reject) => {
        const waiter = { signal, resolve, reject, onAbort: null };
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          try { abort(signal); }
          catch (error) { reject(error); }
        };
        waiter.grant = () => {
          signal?.removeEventListener("abort", waiter.onAbort);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.release();
          });
        };
        if (!this.locked) {
          this.locked = true;
          waiter.grant();
        }
        else {
          this.waiters.push(waiter);
          signal?.addEventListener("abort", waiter.onAbort, { once: true });
        }
      });
    }
    release() {
      while (this.waiters.length) {
        const waiter = this.waiters.shift();
        if (waiter.signal?.aborted) continue;
        waiter.grant();
        return;
      }
      this.locked = false;
    }
  }

  const IMAGE_INLINE = /!\[[^\]\n]*\]\([^\)\n]*\)/g, IMAGE_REFERENCE = /!\[[^\]\n]*\]\[[^\]\n]*\]/g;
  const FRAGMENTED_STATISTIC = /\\\((?<formula>[^\n]{0,360}?)\\\)(?<tail>\s*(?:(?:&(?:lt|gt);|[<>]=?)\s*)?\d[\d\s.,]*\)?)/gi;
  const SECTION_PREFIX = /^\s*((?:[IVXLCDM]+|[A-Z]|\(?\d+(?:\.\d+)*\)?)[.)])(?=\s+)/;
  const CAPTION_VERBS = /^\s*(?:shows?|illustrates?|depicts?|presents?|gives?|summarizes?|lists?|compares?|displays?|demonstrates?|reports?|exhibits?|indicates?|reveals?|suggests?|provides?|contains?|is\b|are\b|was\b|were\b|can\b|could\b|will\b|would\b|has\b|have\b|had\b)/i;
  const EQUATION_REFERENCE = /\b(?:Eq|Eqs|Equation|Equations)\.?\s+(?:(?![.;。；]\s).){0,120}[（(]\s*[A-Za-z]?\d+[A-Za-z]?\s*[)）]/gi;
  const EQUATION_NUMBER = /[（(]\s*[A-Za-z]?\d+[A-Za-z]?\s*[)）]/g;
  const AUTHOR_CITATION = /\b([A-Z][a-z]{1,})\s+(\d{1,3})(?=\s+[a-z])/g;
  const TRAILING_CITATION = /(?<=[A-Za-z\)])([.,;])\s+(\d{1,3}(?:\s*[–-]\s*\d{1,3})?(?:\s*,\s*\d{1,3})*)(?=\s+(?:[A-Z][a-z]|and\b|or\b|with\b|thereby\b|while\b|including\b|contraction\b|collapse\b|investigat(?:e|ed|es|ing)\b|investi-\s*gating\b|as\b|stud(?:y|ied|ies)\b|report(?:ed|s)?\b|demonstrat(?:e|ed|es|ing)\b|show(?:ed|s)?\b|observ(?:e|ed|es|ing)\b|analy[sz](?:e|ed|es|ing)\b))/g;
  function protectedRanges(rawText) {
    const raw = String(rawText || ""); const ranges = []; const claim = (start, end) => { if (start >= end || ranges.some(([a,b]) => start < b && end > a)) return; ranges.push([start, end]); };
    const prefix = SECTION_PREFIX.exec(raw); SECTION_PREFIX.lastIndex = 0; if (prefix) claim(prefix.index, prefix.index + prefix[0].length);
    for (const m of raw.matchAll(FRAGMENTED_STATISTIC)) { const formula = htmlDecode(m.groups.formula).replace(/\s+$/, ""); if (/(?:[<>]=?|=)$/.test(formula) || (m.groups.formula.match(/\(/g)||[]).length > (m.groups.formula.match(/\)/g)||[]).length) claim(m.index, m.index + m[0].length); }
    for (const ref of raw.matchAll(EQUATION_REFERENCE)) for (const number of ref[0].matchAll(EQUATION_NUMBER)) claim(ref.index + number.index, ref.index + number.index + number[0].length);
    const patterns = [/<(?<tag>sup|sub)\b[^>\n]*>[\s\S]*?<\/\k<tag>\s*>/gi, IMAGE_INLINE, IMAGE_REFERENCE, /\$[^$\n]+\$/g, /\\\([\s\S]*?\\\)/g, /\\\[[\s\S]*?\\\]/g, /<[^>\n]+>/g, /`[^`\n]+`/g, /https?:\/\/\S+/gi, /IMAGE_\d+/g];
    for (const re of patterns) for (const m of raw.matchAll(re)) claim(m.index, m.index + m[0].length);
    return ranges.sort((a,b) => a[0] - b[0]);
  }
  function splitInlineTokens(text) { const raw = String(text || ""), ranges = protectedRanges(raw); if (!raw) return []; if (!ranges.length) return [[false, raw]]; const pieces = []; let cursor = 0; for (const [start,end] of ranges) { if (start > cursor) pieces.push([false, raw.slice(cursor, start)]); pieces.push([true, raw.slice(start,end)]); cursor = end; } if (cursor < raw.length) pieces.push([false, raw.slice(cursor)]); return pieces; }
  function pythonCompatiblePlaceholderValue(value) {
    const raw = String(value || "");
    if (raw.startsWith("\\(") && raw.endsWith("\\)")) return `$${raw.slice(2, -2)}$`;
    return raw;
  }
  function inlinePlaceholder(index, value, pythonCompatibleTeX = false) {
    const digestValue = pythonCompatibleTeX ? pythonCompatiblePlaceholderValue(value) : value;
    return `ZXQH${index.toString(16).padStart(2,"0").toUpperCase()}${sha1(`${index}:${digestValue}`).slice(0,10)}HQXZ`;
  }
  function tolerantPattern(token) {
    const characters = Array.from(String(token));
    return characters.map((character, index) =>
      escapeRE(character) + (index < characters.length - 1 ? "[\\s_-]*" : "")
    ).join("");
  }
  function protectInlineTokens(text, pythonCompatibleTeX = false) { const placeholders = [], output = []; for (const [protectedPart, value] of splitInlineTokens(text)) { if (!protectedPart) output.push(value); else { const token = inlinePlaceholder(placeholders.length, value, pythonCompatibleTeX); placeholders.push([token, value]); output.push(` ${token} `); } } return { text: output.join(""), placeholders }; }
  function restoreInlineTokens(text, placeholders) {
    let output = String(text || "");
    const remaining = [];
    for (const [token, value] of placeholders || []) {
      const pattern = new RegExp(tolerantPattern(token), "gi");
      if (pattern.test(output)) {
        output = output.replace(pattern, () => value);
      } else {
        remaining.push([token, value]);
      }
    }
    // 容错兜底：若模型微调或遗漏了个别十六进制字符，基于 ZXQH 与索引十六进制进行模糊还原
    for (const [token, value] of remaining) {
      const match = /^ZXQH([0-9A-Fa-f]{2})/i.exec(token);
      if (!match) continue;
      const indexHex = match[1];
      const fallbackPattern = new RegExp(`ZXQH[\\s_-]*${escapeRE(indexHex)}[0-9A-Fa-f\\s_-]{6,16}(?:HQXZ)?`, "gi");
      output = output.replace(fallbackPattern, () => value);
    }
    return output;
  }
  function batchMarker(prefix, id) { return `${prefix}${id}${sha1(`${prefix}:${id}`).slice(0,8)}`; }
  function encodeTranslationBatch(items) { const tokenToItem = new Map(); const parts = items.map(([id,text], i) => { const token = String(i + 1).padStart(6,"0"); tokenToItem.set(token,id); return `[[[${batchMarker("ZXA",token)}]]]\n${text}\n[[[${batchMarker("ZXZ",token)}]]]`; }); return { text: parts.join("\n\n"), tokenToItem }; }
  function parseTranslationBatch(response, tokenToItem) { const parsed = {}; for (const [token,id] of tokenToItem) { const start = `\\[\\s*\\[\\s*\\[\\s*${tolerantPattern(batchMarker("ZXA",token))}\\s*\\]\\s*\\]\\s*\\]`; const end = `\\[\\s*\\[\\s*\\[\\s*${tolerantPattern(batchMarker("ZXZ",token))}\\s*\\]\\s*\\]\\s*\\]`; const m = new RegExp(`${start}\\s*([\\s\\S]*?)\\s*${end}`, "i").exec(String(response || "")); if (!m) return null; parsed[id] = m[1].trim(); } return parsed; }
  function restoreCitationMarkup(text) { const raw = String(text || ""); if (/<sup/i.test(raw)) return raw; return raw.replace(AUTHOR_CITATION, (_m, name, n) => `${name} <sup>${n}</sup>`).replace(TRAILING_CITATION, (_m, p, ns) => `${p} <sup>${ns.replace(/\s+/g,"")}</sup>`); }
  const chineseTarget = target => /zh|中文|汉语|简体|繁体/i.test(String(target || ""));
  function headingTranslation(source, target) { if (!chineseTarget(target)) return ""; const text = String(source || "").replace(/\s+/g," ").trim().toUpperCase(); const labels = { ABSTRACT:"摘要", AFFILIATIONS:"作者单位", ACKNOWLEDGMENTS:"致谢", ACKNOWLEDGEMENTS:"致谢", REFERENCES:"参考文献", "CONFLICT OF INTEREST":"利益冲突声明", "DATA AVAILABILITY":"数据可用性", "AUTHOR CONTRIBUTIONS":"作者贡献", FUNDING:"资金支持", "SUPPLEMENTARY MATERIAL":"补充材料", INTRODUCTION:"引言", METHODOLOGY:"方法", METHOD:"方法", METHODS:"方法", "MATERIALS AND METHODS":"材料与方法", RESULTS:"结果", DISCUSSION:"讨论", "ANALYSIS AND DISCUSSION":"分析与讨论", "RESULTS AND DISCUSSION":"结果与讨论", CONCLUSIONS:"结论", CONCLUSION:"结论" }; if (labels[text]) return labels[text]; const m = /^((?:[IVXLCDM]+|[A-Z])\.)\s+(.+)$/.exec(text); return m && labels[m[2]] ? `${m[1]} ${labels[m[2]]}` : ""; }
  function probableAuthorLine(text) { const raw = String(text || ""); return (raw.match(/\([^)]*[\u4e00-\u9fff][^)]*\)/g)||[]).length >= 2 && (raw.match(/\b[A-Z][A-Za-z-]+\s+[A-Z][A-Za-z-]+\b/g)||[]).length >= 2; }
  function qualityIssues(source, translated, target) {
    if (!chineseTarget(target)) return [];
    const issues = [], input = String(source || ""), output = String(translated || "");
    if (/^(?:我|一|二|三|四|五|六|七|八|九|十)[。．、]/.test(output)) issues.push("章节编号疑似误译");
    if (/(?:资料图|图表)\s*[。．、]*\s*\d/.test(output)) issues.push("图注标签疑似误译");
    if (/[A-Za-z0-9）\)]。(?=\s*[（(\dA-Za-z])/.test(output)) issues.push("非中文标点疑似全角化");
    if (/<sup>/i.test(input) && !/<sup>/i.test(output)) issues.push("引文上标丢失");
    if (/ZXQH[0-9A-Fa-f]{2}/i.test(output)) issues.push("存在未还原保护标记");
    if (/<\/?(?:b|PP)\d+/i.test(output)) issues.push("存在异常标签残留");
    if (/(?:图|表)\s*\d+[A-Za-z]?\s*[:：.]\s*(?:图|表)\s*[:：.]*\s*\d+/i.test(output)) issues.push("存在重复图表标号");
    if (/(?:[IVXLCDM]+|[A-Z]|\d+(?:\.\d+)*)[.)]\s*[:：]/.test(output)) issues.push("标题编号存在多余冒号");
    return issues;
  }
  function normalizeAcademic(source, translated, target) {
    let output = String(translated || "").trim();
    const sourceText = String(source || "");
    const heading = headingTranslation(sourceText, target);
    if (heading) return heading;
    if (!output) return output;

    if (chineseTarget(target)) {
      // 1. 章节与标号前缀检测（如 "A. "、"1.1 "）
      let sectionMarker = "";
      const prefix = SECTION_PREFIX.exec(sourceText);
      SECTION_PREFIX.lastIndex = 0;
      if (prefix) {
        const marker = prefix[1].slice(0, -1), punct = prefix[1].slice(-1);
        sectionMarker = `${marker}${punct}`;
        output = output
          .replace(new RegExp(`^\\s*(?:(?:${escapeRE(marker)})[.。．、)]\\s*)+`, "i"), "")
          .replace(/^[\s:：.。．、\-–—~,，]+/, "");
      }

      // 2. 图表题注 vs 普通正文句分析
      const capMatch = /^\s*(fig(?:ure)?|table)\.?\s*([A-Za-z]?\d+[A-Za-z]?|[IVXLCDM]+)(?:\.|\b)/i.exec(sourceText);
      if (capMatch) {
        const label = /^fig/i.test(capMatch[1]) ? "图" : "表";
        const num = capMatch[2];
        const afterCap = sourceText.slice(capMatch.index + capMatch[0].length);
        const isBodySentence = CAPTION_VERBS.test(afterCap);
        if (isBodySentence) {
          // 普通陈述句（如 "Figure 5 shows..." -> Edge 译为 "图:5 ,分别显示了..." 或 "图:<sup>5</sup> ,分别显示了..."）
          output = output.replace(
            new RegExp(`^\\s*(?:[,，:：.。．、\\-–—~]*\\s*)?(?:资料图|图表|插图|图|表格|表|fig(?:ure)?|table)\\s*[:：.。．、]*\\s*(?:<sup>)?\\s*${escapeRE(num)}\\s*(?:<\\/sup>)?\\s*[,，:：.。．、]*\\s*`, "i"),
            `${label} ${num} `
          );
        } else {
          // 真正的图表题注：循环剥除所有多余重复的图表标签前缀
          const capLeadPattern = new RegExp(
            `^\\s*(?:[,，:：.。．、\\-–—~]*\\s*)?(?:资料图|图表|插图|图|表格|表|fig(?:ure)?|table)\\s*[:：.。．、]*\\s*(?:<sup>)?\\s*${escapeRE(num)}\\s*(?:<\\/sup>)?\\s*[:：.。．、,，\\-–—~]*\\s*`,
            "i"
          );
          while (capLeadPattern.test(output)) {
            output = output.replace(capLeadPattern, "");
          }
          output = output.replace(/^[\s,，:：.。．、\-–—~]+/, "");
          output = `${label} ${num}${output ? `. ${output}` : ""}`;
        }
      }

      // 3. 组装章节编号（若有）
      if (sectionMarker) {
        output = output
          .replace(new RegExp(`^\\s*(?:(?:${escapeRE(sectionMarker.slice(0, -1))})[.。．、)]\\s*)+`, "i"), "")
          .replace(/^[\s:：.。．、\-–—~,，]+/, "");
        output = `${sectionMarker}${output ? ` ${output}` : ""}`;
      }

      // 4. 公式引用标号规范化
      const numbers = [];
      for (const ref of sourceText.matchAll(EQUATION_REFERENCE)) {
        for (const number of ref[0].matchAll(EQUATION_NUMBER)) {
          const id = number[0].replace(/[（）()\s]/g, "");
          if (!numbers.includes(id)) numbers.push(id);
        }
      }
      output = output.replace(
        /(?<![A-Za-z0-9])(?:[~～〜]\s*)([A-Za-z]?\d+[A-Za-z]?)\s*[!！](?![A-Za-z0-9])/g,
        "($1)"
      );
      for (const id of numbers) {
        const escaped = escapeRE(id);
        output = output
          .replace(new RegExp(`(?:Eq(?:uation)?s?|方程|公式|式)\\s*[.。．、:]?\\s*[（(]\\s*${escaped}\\s*[)）]`, "gi"), `式 (${id})`)
          .replace(new RegExp(`(?:[~～〜]\\s*)?${escaped}\\s*[!！]`, "g"), `式 (${id})`)
          .replace(new RegExp(`(?<![A-Za-z0-9])(?:式|方程)\\s*${escaped}(?![A-Za-z0-9])`, "g"), `式 (${id})`);
      }
      output = output
        .replace(/(?:方程|公式)\s*[。.．]\s*(式\s*\()/g, "$1")
        .replace(/\)\s*(和|与|及)\s*式/g, ") $1式");

      // 5. 剥除模型幻觉伪标签碎片
      output = output
        .replace(/PP\d*><\/b\d+>/gi, "")
        .replace(/4>4>/g, "")
        .replace(/<\/?(?:b|PP)\d*[^>]*>/gi, "")
        .replace(/<\/?(?:b|PP)\d+/gi, "")
        .replace(/<b\s+[^>]*>/gi, "");

      // 6. 通用连续退化死循环去重（连续重复 >= 2 次的长子句仅保留 1 次）
      const clauseRegex = /([^，。！？；\n]{8,120}[，。！？；\s]*)\1{1,}/gu;
      for (let i = 0; i < 3; i++) {
        const next = output.replace(clauseRegex, "$1");
        if (next === output) break;
        output = next;
      }

      // 7. 公式说明与“其中”后冒号清理（如 "其中 : $Q$ : 是" -> "其中 $Q$ 是"）
      output = output
        .replace(/(^|[，。；\n\s])(其中|式中)\s*[:：]\s*(?=[$（(\\\w\u4e00-\u9fa5])/gu, "$1$2 ")
        .replace(/(\$[^$\n]+\$)\s*[:：]\s*(?=(?:[是为指]|代表|表示|等于|即为|[a-zA-Z\u4e00-\u9fa5]))/g, "$1 ")
        .replace(/(\\\([^\n]+?\\\))\s*[:：]\s*(?=(?:[是为指]|代表|表示|等于|即为|[a-zA-Z\u4e00-\u9fa5]))/g, "$1 ")
        .replace(/(?<=[$A-Za-z0-9_\\\)）])\s*[:：]\s*(?=(?:[是为指]|代表|表示|等于|即为))/g, " ");

      // 8. 子图标签与题注标点清洗
      output = output
        .replace(/(?<![。！？!?])[,，\s]+$/gm, "")
        .replace(/(?<![。！？!?])[:：]{2,}$/gm, "");
      if (!/[:：]\s*$/.test(sourceText)) {
        output = output.replace(/(?<![。！？!?])[:：\s]+$/gm, "");
      }
      output = output
        .replace(/(^|[\n\s])(\([a-z]\)|（[a-z]）)\s*[,，:：\s]+(?=[\n\s]|$|!\[)/gim, "$1$2 ")
        .replace(/(\([a-z]\)|（[a-z]）)\s*[,，:：]+\s*(?=[A-Za-z\u4e00-\u9fa5!\[])/gim, "$1 ")
        .replace(/(\([a-z]\)\s*[^:：\n]+?)\s*[:：]\s*(图\s*\d+|表\s*\d+)/gi, "$1. $2")
        .replace(/(\([a-z]\)|（[a-z]）)\s*[,，:：]\s*(图\s*\d+|表\s*\d+)/gi, "$1 $2")
        .replace(/^[\s,，:：.。．、\-–—~]+(?=(?:图|表|Figure|Table|\([a-z]\)|（[a-z]）))/gi, "");

      // 9. Markdown 图片前后病态孤立逗号/冒号清理
      output = output
        .replace(/(?:^|[ \t]*[,，:：]+[ \t]*)+(!\[[^\]\n]+\]\([^\)\n]+\))/g, "\n\n$1")
        .replace(/(!\[[^\]\n]+\]\([^\)\n]+\))[ \t]*[,，:：\s]*(图\s*\d+|表\s*\d+|\([a-z]\)|（[a-z]）)/gi, "$1\n\n$2")
        .replace(/(!\[[^\]\n]+\]\([^\)\n]+\))[ \t]*[,，:：]+[ \t]*/g, "$1 ");

      // 10. 标题、上标与残留标号冒号消噪
      output = output
        .replace(/(^|[\n#\s])((?:[IVXLCDM]+|[A-Z]|\d+(?:\.\d+)*)[.)]?)\s*[:：]\s*(?=[A-Za-z\u4e00-\u9fa5])/gm, "$1$2 ")
        .replace(/(<sup>[^<]+<\/sup>)\s*[:：]\s*/g, "$1 ")
        .replace(/(<sub>[^<]+<\/sub>)\s*[:：]\s*/g, "$1 ")
        .replace(/[:：]{2,}/g, "：")
        .replace(/[,，]{2,}/g, "，")
        .replace(/[,，]\s*[:：]|[:：]\s*[,，]/g, "：")
        .replace(/(图\s*\d+[A-Za-z]?)\.?\s*(?:资料图|图表|插图|图|表格|表)\s*[:：.]*\s*(?:<sup>)?\s*\d*[A-Za-z]?\s*(?:<\/sup>)?\s*[,，:：.]*/gi, "$1. ");
    }
    return output.trim();
  }

  function markdownBlocks(text) { const blocks=[], current=[]; let fence=false, math=false; const flush=()=>{if(current.length)blocks.push(current.splice(0).join(""));}; for(const line of String(text||"").split(/(?<=\n)/)){const stripped=line.trim(), f=/^(?:```|~~~)/.test(stripped), table=/^\|.*\|$/.test(stripped);if(f){if(!fence&&current.length)flush();current.push(line);fence=!fence;if(!fence)flush();continue;}if(fence){current.push(line);continue;}if(/^\$\$/.test(stripped)){if(!math&&current.length)flush();current.push(line);if(stripped==="$$")math=!math;if(!math&&stripped==="$$")flush();continue;}if(math){current.push(line);continue;}if(table){if(current.length&&!current.at(-1).trim().startsWith("|"))flush();current.push(line);continue;}if(!stripped){current.push(line);flush();continue;}if(stripped.startsWith("#")&&current.length)flush();current.push(line);}flush();return blocks; }
  function markdownItem(block) { const stripped=String(block||"").trim(); if(!stripped||/^(?:```|~~~|\$\$|\\\[)/.test(stripped)||/\\\]$/.test(stripped)||/^!\[[^\]]*\]\([^)]+\)\s*$/.test(stripped))return null;const lines=String(block).split(/\r?\n/).filter(x=>x.trim());if(lines.length&&lines.every(x=>/^\|.*\|$/.test(x.trim())))return null;const h=/^(\s{0,3}#{1,6}\s+)(.*?)(\s*#*\s*)(\n?)$/s.exec(block);if(h)return [h[1],h[2],h[3]+h[4]];const o=/^(\s*)(.*?)(\s*)$/s.exec(block);return o?[o[1],o[2],o[3]]:["",block,""]; }

  class WebMachineTranslationService {
    constructor(options = {}) {
      this.edgeDownloadConsent = options.edgeDownloadConsent || null;
      this.edgeProfileDir = options.edgeProfileDir || null;
      this.edgeMutex = new AsyncMutex();
      this.activeEdgeTranslator = null;
    }
    isEdge(options = {}) { return String(options.provider || "").trim().toLowerCase() === EDGE; }
    async withEdgeTranslator(options, task) {
      if (!LitMTrans.EdgeLocalTranslator) throw new Error("Edge本地翻译服务未加载，请重启Zotero后重试。");
      if (this.edgeMutex.locked) options.log?.("另一个Edge本地翻译任务正在运行，本任务将在其完成后继续。");
      const release = await this.edgeMutex.acquire(options.signal);
      const translator = new LitMTrans.EdgeLocalTranslator(options.targetLanguage, options.sourceLanguage, {
        log: options.log,
        downloadConsent: options.edgeDownloadConsent || this.edgeDownloadConsent,
        profileDir: options.edgeProfileDir || this.edgeProfileDir || undefined
      });
      this.activeEdgeTranslator = translator;
      const stop = () => { void translator.close(); };
      options.signal?.addEventListener("abort", stop, { once: true });
      try { return await task(translator); }
      finally {
        options.signal?.removeEventListener("abort", stop);
        try { await translator.endJob(); }
        finally {
          if (this.activeEdgeTranslator === translator) this.activeEdgeTranslator = null;
          release();
        }
      }
    }
    async shutdown() {
      const translator = this.activeEdgeTranslator;
      this.activeEdgeTranslator = null;
      if (translator) await translator.close();
    }
    async translatePlain(translator, text, signal) { if(!shouldTranslateText(text))return text; const protectedText=protectInlineTokens(text); if(!shouldTranslateText(protectedText.text))return text; return restoreInlineTokens(await translator.translate(protectedText.text,signal),protectedText.placeholders); }
    batchLimit(translator) { const provider=String(translator.currentProvider || translator.providerId || "").toLowerCase();return provider===EDGE?Number(translator.maxChars||3000):(provider===BING?BING_BATCH_CHARS:GOOGLE_BATCH_CHARS); }
    packItems(items,limit){const batches=[],current=[];for(const item of items){const candidate=[...current,item];if(current.length&&encodeTranslationBatch(candidate).text.length>limit){batches.push(current.splice(0));current.push(item);}else current.push(item);}if(current.length)batches.push(current);return batches;}
    async translatePacked(translator,items,limit,signal){if(!items.length)return {};abort(signal);if(items.length===1){const [id,text]=items[0];return {[id]:await this.translatePlain(translator,text,signal)};}const packed=encodeTranslationBatch(items);if(packed.text.length<=limit){try{const parsed=parseTranslationBatch(await translator.translate(packed.text,signal),packed.tokenToItem);if(parsed)return parsed;}catch(error){rethrowCancellation(error,signal);/* recursive split below */}}if(limit<=MIN_BATCH_CHARS){const out={};for(const [id,text]of items)out[id]=await this.translatePlain(translator,text,signal);return out;}const middle=Math.max(1,Math.floor(items.length/2));return {...await this.translatePacked(translator,items.slice(0,middle),Math.max(MIN_BATCH_CHARS,Math.floor(limit/2)),signal),...await this.translatePacked(translator,items.slice(middle),Math.max(MIN_BATCH_CHARS,Math.floor(limit/2)),signal)};}
    async translateItems(items, options = {}) {
      if (!options.translator && this.isEdge(options)) {
        return this.withEdgeTranslator(options, translator => this.translateItems(items, { ...options, translator }));
      }
      const translator = options.translator || new FallbackMachineTranslator(options.targetLanguage, options.sourceLanguage, options.log);
      const translations = {}, pending = [];
      const provider = String(translator.currentProvider || translator.providerId || "").toLowerCase();
      for (const [id, text] of items) {
        abort(options.signal);
        if (shouldTranslateText(text)) {
          const protectedText = protectInlineTokens(text, provider === EDGE);
          pending.push([id, protectedText.text]);
          translations[`__placeholders__${id}`] = protectedText.placeholders;
        }
        else translations[id] = text;
      }
      const limit = this.batchLimit(translator);
      const batches = this.packItems(pending, limit);
      if (provider === EDGE) {
        let completed = 0;
        for (let index = 0; index < batches.length; index++) {
          abort(options.signal);
          const batch = batches[index];
          options.log?.(`Edge本地翻译批次${index + 1}/${batches.length}，共${batch.length}个文本块，正在逐块处理…`);
          for (const [id, protectedText] of batch) {
            abort(options.signal);
            const translatedText = await translator.translate(protectedText, options.signal);
            translations[id] = restoreInlineTokens(translatedText, translations[`__placeholders__${id}`] || []);
            delete translations[`__placeholders__${id}`];
            completed++;
            options.liveUpdate?.({ ...translations });
          }
          options.log?.(`Edge本地翻译已完成${completed}/${pending.length}个待翻译文本块。`);
        }
        return Object.fromEntries(items.map(([id, source]) => [id, translations[id] ?? source]));
      }
      const parallel = new Map();
      if (String(translator.currentProvider || "").toLowerCase() === BING && batches.length > 1) {
        const workers = Math.min(BING_PARALLELISM, batches.length);
        options.log?.("正在使用Bing联网免费机翻处理文献。");
        const assignments = Array.from({ length: workers }, (_, worker) =>
          Array.from({ length: batches.length }, (_, index) => index).filter(index => index % workers === worker)
        );
        await Promise.all(assignments.map(async indexes => {
          const worker = translator.cloneForWorker();
          for (const index of indexes) {
            abort(options.signal);
            parallel.set(index, await this.translatePacked(worker, batches[index], this.batchLimit(worker), options.signal));
          }
        }));
      }
      let completed = 0;
      for (let index = 0; index < batches.length; index++) {
        abort(options.signal);
        const batch = batches[index];
        options.log?.(`联网免费机翻进度：第${index + 1}/${batches.length}部分。`);
        const result = parallel.get(index) || await this.translatePacked(translator, batch, limit, options.signal);
        for (const [id, text] of Object.entries(result)) {
          translations[id] = restoreInlineTokens(text, translations[`__placeholders__${id}`] || []);
          delete translations[`__placeholders__${id}`];
          completed++;
        }
        options.liveUpdate?.({ ...translations });
        abort(options.signal);
        options.log?.(`联网免费机翻已完成${completed}/${pending.length}部分。`);
      }
      return Object.fromEntries(items.map(([id, source]) => [id, translations[id] ?? source]));
    }
    async translateMarkdown(markdown, options = {}) {
      if (!options.translator && this.isEdge(options)) {
        return this.withEdgeTranslator(options, translator => this.translateMarkdown(markdown, { ...options, translator }));
      }
      const blocks = markdownBlocks(markdown);
      const translated = [...blocks];
      const wrappers = new Map(), sources = new Map(), items = [];
      let direct = 0;
      for (let index = 0; index < blocks.length; index++) {
        abort(options.signal);
        const item = markdownItem(blocks[index]);
        if (!item) continue;
        const [prefix, text, suffix] = item;
        const id = `md${String(index + 1).padStart(4, "0")}`;
        wrappers.set(id, [index, prefix, suffix]);
        sources.set(id, text);
        const deterministic = headingTranslation(text, options.targetLanguage);
        if (deterministic) {
          translated[index] = prefix + deterministic + suffix;
          direct++;
        }
        else if (probableAuthorLine(text)) {
          translated[index] = prefix + text + suffix;
          direct++;
        }
        else items.push([id, restoreCitationMarkup(text)]);
      }
      const update = partial => {
        abort(options.signal);
        const preview = [...translated];
        for (const [id, text] of Object.entries(partial)) {
          const wrapper = wrappers.get(id);
          if (wrapper) preview[wrapper[0]] = wrapper[1] + normalizeAcademic(sources.get(id), text, options.targetLanguage) + wrapper[2];
        }
        options.liveUpdate?.(preview.join(""));
      };
      const result = await this.translateItems(items, { ...options, liveUpdate: update });
      abort(options.signal);
      for (const [id, text] of Object.entries(result)) {
        const [index, prefix, suffix] = wrappers.get(id);
        translated[index] = prefix + normalizeAcademic(sources.get(id), text, options.targetLanguage) + suffix;
      }
      let qualityHits = 0;
      for (const [id, wrapper] of wrappers) {
        const [index, prefix, suffix] = wrapper;
        let content = String(translated[index] || "");
        if (prefix && content.startsWith(prefix)) content = content.slice(prefix.length);
        if (suffix && content.endsWith(suffix)) content = content.slice(0, -suffix.length);
        const issues = qualityIssues(sources.get(id), content, options.targetLanguage);
        if (issues.length) {
          qualityHits++;
          options.log?.(`第${id}部分翻译结果需要核对：${issues.join("、")}`);
        }
      }
      options.log?.(`${this.isEdge(options) ? "流式Edge本地翻译" : "流式联网免费机翻"}完成，${qualityHits ? `有${qualityHits}处内容需要核对。` : "结果已整理。"}`);
      return translated.join("");
    }
    async translateRecords(records, options = {}) {
      if (!options.translator && this.isEdge(options)) {
        return this.withEdgeTranslator(options, translator => this.translateRecords(records, { ...options, translator }));
      }
      const translations = {}, items = [], sources = new Map(), allRecords = [...(records || [])];
      const translator = options.translator || new FallbackMachineTranslator(options.targetLanguage, options.sourceLanguage, options.log);
      let direct = 0;
      for (const record of allRecords) {
        abort(options.signal);
        const id = String(record.block_id ?? record.id ?? "");
        const text = String(record.text || "");
        sources.set(id, text);
        const deterministic = headingTranslation(text, options.targetLanguage);
        if (deterministic) {
          translations[id] = deterministic;
          direct++;
        }
        else if (probableAuthorLine(text)) {
          translations[id] = text;
          direct++;
        }
        else items.push([id, restoreCitationMarkup(text)]);
      }
      const publishProgress = partial => {
        abort(options.signal);
        // `partial` contains every item that has gone through the machine
        // route, including source-only items that are deliberately preserved.
        // Add the records handled by local rules so this counter uses the same
        // all-records denominator shown to the user.
        const handled = direct + items.filter(([id]) => Object.hasOwn(partial, id)).length;
        options.liveUpdate?.(`正在进行排版翻译…\n\n- 已处理：${handled}/${allRecords.length}\n- 当前服务：${translatorLabel(translator)}`);
      };
      publishProgress({});
      const result = await this.translateItems(items, {
        ...options,
        translator,
        liveUpdate: publishProgress
      });
      Object.assign(translations, result);
      let warnings = 0;
      for (const [id, source] of sources) {
        abort(options.signal);
        translations[id] = normalizeAcademic(source, translations[id] ?? source, options.targetLanguage);
        const issues = qualityIssues(source, translations[id], options.targetLanguage);
        if (issues.length) {
          warnings++;
          options.log?.(`第${id}部分翻译结果需要核对：${issues.join("、")}`);
        }
      }
      options.log?.(`${this.isEdge(options) ? "排版Edge本地翻译" : "排版联网免费机翻"}完成，${warnings ? `有${warnings}处内容需要核对。` : "结果已整理。"}`);
      return translations;
    }
  }
  function translatorLabel(translator){const provider=String(translator?.currentProvider||WEB).toLowerCase();return provider===EDGE?"Edge本地翻译":(provider===BING?"Bing联网免费机翻":"联网免费机翻");}

  function isWebMachineProvider(value) {
    return U.isWebMachineProvider
      ? U.isWebMachineProvider(value)
      : [WEB, GOOGLE, BING, EDGE].includes(String(value || "").trim().toLowerCase());
  }
  function providerLabel(value) { const provider=String(value || "").trim().toLowerCase();return provider===EDGE?"Edge本地翻译":(provider===BING?"Bing联网免费机翻":"联网免费机翻"); }
  function protectInline(text) { const result = protectInlineTokens(text); return { output: result.text, placeholders: result.placeholders }; }
  function restoreInline(text, placeholders) { return restoreInlineTokens(text, placeholders); }
  function encodeBatch(items) { const result = encodeTranslationBatch(items); return { text: result.text, map: result.tokenToItem }; }
  function parseBatch(response, map) { return parseTranslationBatch(response, map); }

  LitMTrans.WebMachineTranslationService = WebMachineTranslationService;
  LitMTrans.WebMachineTranslation = {
    PROVIDER: WEB, GOOGLE, BING, EDGE, isWebMachineProvider, providerLabel,
    splitText, splitInlineTokens, protectInline, restoreInline, encodeBatch,
    parseBatch, markdownBlocks, normalizeAcademic, restoreCitationMarkup, qualityIssues
  };
})(this);
