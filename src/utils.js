(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const PREF_BRANCH = "extensions.litmtrans.";
  const LEGACY_PREF_BRANCH = "extensions.ai-literature-translator.";
  const LANGUAGE_SUGGESTIONS = Object.freeze([
    "简体中文", "繁体中文", "英文", "日文", "韩文", "德文", "法文", "西班牙文", "意大利文", "葡萄牙文", "俄文"
  ]);
  const LANGUAGE_NAME_ALIASES = Object.freeze({
    "中文": "简体中文", "汉语": "简体中文", "简体汉语": "简体中文",
    "繁体汉语": "繁体中文",
    "英语": "英文", "english": "英文",
    "日语": "日文", "japanese": "日文",
    "韩语": "韩文", "korean": "韩文",
    "德语": "德文", "german": "德文",
    "法语": "法文", "french": "法文",
    "西班牙语": "西班牙文", "spanish": "西班牙文",
    "意大利语": "意大利文", "italian": "意大利文",
    "葡萄牙语": "葡萄牙文", "portuguese": "葡萄牙文",
    "俄语": "俄文", "russian": "俄文"
  });

  function normalizeLanguageName(value, fallback = "") {
    const raw = String(value || "").trim();
    if (!raw) return String(fallback || "").trim();
    return LANGUAGE_NAME_ALIASES[raw] || LANGUAGE_NAME_ALIASES[raw.toLowerCase()] || raw;
  }

  function base64Function(name) {
    const direct = global?.[name];
    if (typeof direct === "function") return direct.bind(global);
    const hiddenWindow = global?.Services?.appShell?.hiddenDOMWindow;
    const fallback = hiddenWindow?.[name];
    if (typeof fallback === "function") return fallback.bind(hiddenWindow);
    throw new Error(`当前Zotero运行环境缺少 ${name} Base64 编解码器`);
  }

  function base64Encode(binary) {
    return base64Function("btoa")(String(binary || ""));
  }

  function base64Decode(value) {
    return base64Function("atob")(String(value || ""));
  }

  function encodeBytesBase64(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      binary += String.fromCharCode(...source.subarray(offset, Math.min(source.length, offset + chunkSize)));
    }
    return base64Encode(binary);
  }

  function detectImageMimeType(bytes, fallback = "image/png") {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    if (data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === "RIFF" && String.fromCharCode(...data.subarray(8, 12)) === "WEBP") return "image/webp";
    if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...data.subarray(0, 6)))) return "image/gif";
    if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return "image/bmp";
    if (data.length >= 12 && data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x0c && data[4] === 0x6a && data[5] === 0x50 && data[6] === 0x20 && data[7] === 0x20) return "image/jp2";
    const prefix = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 256))).replace(/^\uFEFF/, "").trimStart().toLowerCase();
    if (prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"))) return "image/svg+xml";
    return String(fallback || "image/png").toLowerCase();
  }

  function decodeImageDataURL(value, win = null) {
    const raw = String(value || "").trim();
    const commaIndex = raw.indexOf(",");
    if (commaIndex === -1 || !/^data:/i.test(raw)) throw new Error("图片数据格式无效");
    const header = raw.slice(0, commaIndex);
    const mimeMatch = header.match(/^data:([^;,]+)/i);
    let declaredMime = (mimeMatch ? mimeMatch[1] : "").toLowerCase().trim();
    if (declaredMime === "image/jpg" || declaredMime === "image/pjpeg") declaredMime = "image/jpeg";
    else if (declaredMime === "image/x-png") declaredMime = "image/png";
    else if (declaredMime === "image/x-ms-bmp") declaredMime = "image/bmp";

    const isBase64 = /;\s*base64(?:\s*;|\s*$)/i.test(header);
    const payload = raw.slice(commaIndex + 1);
    let bytes;
    if (isBase64) {
      const decoder = win?.atob?.bind(win) || globalThis.atob?.bind(globalThis) || (typeof base64Decode === "function" ? base64Decode : null);
      if (!decoder) throw new Error("当前Zotero环境不能解码图片数据");
      const cleanB64 = payload.replace(/\s+/g, "");
      const binary = decoder(cleanB64);
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    }
    else {
      const text = decodeURIComponent(payload);
      bytes = new TextEncoder().encode(text);
    }

    const detectedMime = detectImageMimeType(bytes, declaredMime || "image/png");
    const mimeType = (declaredMime && declaredMime.startsWith("image/") && declaredMime !== "image/x-unknown")
      ? declaredMime
      : detectedMime;

    const validMimes = new Set([
      "image/png", "image/jpeg", "image/webp", "image/gif",
      "image/bmp", "image/jp2", "image/svg+xml"
    ]);
    if (!validMimes.has(mimeType)) {
      throw new Error("图片数据格式无效");
    }
    return { mimeType, bytes };
  }

  const PROVIDERS = Object.freeze({
    free_machine: {
      id: "free_machine",
      name: "联网免费机翻",
      defaultBaseURL: "",
      defaultModel: "",
      appendV1: false,
      supportsReasoning: false,
      supportsImages: false,
      supportsChat: false,
      webMachine: true
    },
    edge_local: {
      id: "edge_local",
      name: "Edge本地翻译",
      defaultBaseURL: "",
      defaultModel: "",
      appendV1: false,
      supportsReasoning: false,
      supportsImages: false,
      supportsChat: false,
      webMachine: true,
      localMachine: true
    },
    deepseek_web: {
      id: "deepseek_web",
      name: "DeepSeek 官方网页端",
      defaultBaseURL: "https://chat.deepseek.com",
      defaultModel: "deepseek-web",
      appendV1: false,
      supportsReasoning: true,
      supportsImages: true,
      supportsChat: true,
      webDriver: true
    },
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      defaultBaseURL: "https://api.deepseek.com",
      defaultModel: "deepseek-chat",
      appendV1: false,
      supportsReasoning: true,
      supportsImages: false
    },
    oneapi: {
      id: "oneapi",
      name: "OneAPI / NewAPI",
      defaultBaseURL: "",
      defaultModel: "gpt-5.6-luna",
      appendV1: true,
      supportsReasoning: true,
      supportsImages: true
    },
    openai_compatible: {
      id: "openai_compatible",
      name: "OpenAI 兼容接口",
      defaultBaseURL: "",
      defaultModel: "gpt-5.6-luna",
      appendV1: true,
      supportsReasoning: true,
      supportsImages: true
    },
    gemini: {
      id: "gemini",
      name: "Google Gemini",
      defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-3.5-flash",
      appendV1: false,
      supportsReasoning: true,
      supportsImages: true
    },
    siliconflow: {
      id: "siliconflow",
      name: "硅基流动 (SiliconFlow)",
      defaultBaseURL: "https://api.siliconflow.cn/v1",
      defaultModel: "",
      appendV1: true,
      supportsReasoning: false,
      supportsImages: false
    },
    zai: {
      id: "zai",
      name: "Z.ai",
      defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "",
      appendV1: false,
      supportsReasoning: true,
      supportsImages: false
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      defaultBaseURL: "https://openrouter.ai/api/v1",
      defaultModel: "",
      appendV1: true,
      supportsReasoning: true,
      supportsImages: true
    }
  });
  // Older builds exposed the two web engines as separate providers.  They
  // are now one resilient Google-first/Bing-fallback route, but saved
  // preferences must continue to resolve to that route instead of falling
  // through to the OpenAI-compatible provider.
  const PROVIDER_ALIASES = Object.freeze({
    google_free: "free_machine",
    bing_free: "free_machine",
    machine_translate: "free_machine"
  });

  const SUPPORTED_INPUT_EXTENSIONS = new Set([
    ".pdf", ".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp",
    ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".html", ".htm",
    ".md", ".markdown", ".txt"
  ]);

  class CancelledError extends Error {
    constructor(message = "操作已停止") {
      super(message);
      this.name = "CancelledError";
      this.cancelled = true;
    }
  }

  function newAbortController(window = null) {
    // Bootstrap scripts do not always expose browser Web APIs as globals.
    // Prefer a real Zotero window. Accessing hiddenDOMWindow can itself throw
    // NS_ERROR_FAILURE in recent Zotero/Firefox process configurations, so it
    // is strictly a guarded last-resort candidate.
    const candidates = [];
    if (window) candidates.push(window);
    try {
      candidates.push(Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser"));
    }
    catch (_) {}
    try {
      candidates.push(Services.appShell.hiddenDOMWindow);
    }
    catch (_) {}
    try { candidates.push(globalThis); }
    catch (_) {}
    for (const candidate of candidates) {
      if (typeof candidate?.AbortController === "function") return new candidate.AbortController();
    }
    throw new Error("当前Zotero环境不支持可取消的网络请求（AbortController 不可用）");
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) {
      throw new CancelledError(typeof signal.reason === "string" ? signal.reason : "操作已停止");
    }
  }

  function sleep(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
      if (!signal) return;
      const onAbort = () => {
        clearTimeout(timer);
        reject(new CancelledError(typeof signal.reason === "string" ? signal.reason : "操作已停止"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function randomID(prefix = "id") {
    let value = "";
    try {
      value = crypto.randomUUID().replace(/-/g, "");
    }
    catch (_) {
      value = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
    return `${prefix}-${value}`;
  }

  function hashString(value) {
    const text = String(value ?? "");
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 ^= code;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= code + ((i + 1) * 131);
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
  }

  function sha256Fallback(value) {
    const bytes = value instanceof Uint8Array
      ? value
      : (global.TextEncoder ? new global.TextEncoder().encode(String(value ?? "")) : Uint8Array.from(unescape(encodeURIComponent(String(value ?? ""))), ch => ch.charCodeAt(0)));
    const words = new Uint32Array(Math.ceil((bytes.length + 9) / 64) * 16);
    const padded = new Uint8Array(words.buffer);
    padded.set(bytes);
    const bitLength = bytes.length * 8;
    const end = bytes.length;
    padded[end] = 0x80;
    padded[padded.length - 4] = (bitLength >>> 24) & 255;
    padded[padded.length - 3] = (bitLength >>> 16) & 255;
    padded[padded.length - 2] = (bitLength >>> 8) & 255;
    padded[padded.length - 1] = bitLength & 255;
    const K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
    for(let offset=0;offset<padded.length;offset+=64){
      const w=new Uint32Array(64);
      for(let i=0;i<16;i++){const p=offset+i*4;w[i]=((padded[p]<<24)|(padded[p+1]<<16)|(padded[p+2]<<8)|padded[p+3])>>>0;}
      for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];const s0=rotr(x,7)^rotr(x,18)^(x>>>3),s1=rotr(y,17)^rotr(y,19)^(y>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;
      for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^(~e&g),t1=(hh+S1+ch+K[i]+w[i])>>>0;const S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&b)^(a&c)^(b&c),t2=(S0+maj)>>>0;hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+hh)>>>0;
    }
    return [h0,h1,h2,h3,h4,h5,h6,h7].map(v=>v.toString(16).padStart(8,"0")).join("");
  }

  async function sha256Hex(value) {
    const text = String(value ?? "");
    try {
      if (global.crypto?.subtle && global.TextEncoder) {
        const digest = await global.crypto.subtle.digest("SHA-256", new global.TextEncoder().encode(text));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      }
    }
    catch (_) {}
    return sha256Fallback(text);
  }

  async function sha256Bytes(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    try {
      if (global.crypto?.subtle) {
        const digest = await global.crypto.subtle.digest("SHA-256", source);
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      }
    }
    catch (_) {}
    return sha256Fallback(source);
  }

  function opaqueCacheKey(...parts) {
    const source = parts.map(part => String(part ?? "")).join("\u241f");
    let hex = hashString(`cache-a\u241f${source}`) + hashString(`cache-b\u241f${source}`);
    hex = `${hex.slice(0, 12)}5${hex.slice(13, 16)}${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17)}`;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  function randomCacheKey() {
    try { return crypto.randomUUID(); }
    catch (_) { return opaqueCacheKey("random", randomID("cache"), Date.now(), Math.random()); }
  }

  function safeStem(value, maxLength = 80, fallback = "document") {
    if (LitMTrans.PortedCore?.safe_document_stem) {
      return LitMTrans.PortedCore.safe_document_stem(String(value || ""), fallback, maxLength);
    }
    let stem = String(value || "").trim().replace(/\s+/g, "-");
    stem = stem.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, "-");
    stem = stem.replace(/-{2,}/g, "-").replace(/^[-._\s]+|[-._\s]+$/g, "");
    if (!stem) stem = fallback;
    if (stem.length > maxLength) stem = stem.slice(0, maxLength).replace(/[-._\s]+$/g, "") || fallback;
    return stem;
  }

  function extension(path) {
    const name = String(path || "").split(/[\\/]/).pop() || "";
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index).toLowerCase() : "";
  }

  const CHAT_IMAGE_EXTENSION_BY_MIME = Object.freeze({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/jp2": ".jp2",
    "image/svg+xml": ".svg"
  });

  function chatImageExtension(mimeType, fileName = "") {
    return CHAT_IMAGE_EXTENSION_BY_MIME[String(mimeType || "").trim().toLowerCase()]
      || extension(fileName)
      || ".png";
  }

  function localTimestampToken(value = Date.now()) {
    const date = value instanceof Date ? value : new Date(value);
    const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
    const pad = (number, width = 2) => String(number).padStart(width, "0");
    return (
      `${safeDate.getFullYear()}${pad(safeDate.getMonth() + 1)}${pad(safeDate.getDate())}-` +
      `${pad(safeDate.getHours())}${pad(safeDate.getMinutes())}${pad(safeDate.getSeconds())}-` +
      pad(safeDate.getMilliseconds(), 3)
    );
  }

  function pastedImageName(capturedAt = Date.now(), sequence = 1, mimeType = "image/png") {
    const ordinal = Math.max(1, Math.trunc(Number(sequence) || 1));
    return `粘贴图片-${localTimestampToken(capturedAt)}-${String(ordinal).padStart(2, "0")}${chatImageExtension(mimeType)}`;
  }

  function isIdentifiedPastedImageName(value) {
    return /^粘贴图片-\d{8}-\d{6}-\d{3}-\d{2,}\.(?:png|jpe?g|webp|gif|bmp|jp2|svg)$/i.test(String(value || "").trim());
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHTML(value).replace(/`/g, "&#96;");
  }

  function normalizeError(error) {
    if (!error) return { name: "Error", message: "未知错误", stack: "" };
    if (typeof error === "string") return { name: "Error", message: error, stack: "" };
    return {
      name: String(error.name || "Error"),
      message: String(error.message || error),
      stack: String(error.stack || ""),
      cancelled: Boolean(error.cancelled || error.name === "AbortError" || error.name === "CancelledError")
    };
  }

  function isMinerUTokenCredentialError(error) {
    const status = Number(error?.status || 0);
    if (status === 401) return true;
    const text = typeof error === "string"
      ? error
      : [error?.message, error?.detail, error?.body].filter(Boolean).join(" ");
    return /\bHTTP\s*401\b/i.test(text)
      || /\bA0211\b/i.test(text)
      || /user\s+token\s+expired/i.test(text)
      || /(?:token|令牌).{0,24}(?:expired|invalid|过期|失效|无效)/i.test(text);
  }

  function clonePlain(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function getPref(name, fallback) {
    try {
      const value = Zotero.Prefs.get(PREF_BRANCH + name, true);
      return value === undefined || value === null ? fallback : value;
    }
    catch (_) {
      return fallback;
    }
  }

  function setPref(name, value) {
    Zotero.Prefs.set(PREF_BRANCH + name, value, true);
  }

  function clearPref(name) {
    try {
      Zotero.Prefs.clear(PREF_BRANCH + name, true);
    }
    catch (_) {}
  }

  function migrateLegacyPreferences() {
    const marker = "migration.legacyPreferencesV1";
    if (getPref(marker, false)) return;
    try {
      const legacyBranch = Services.prefs.getBranch(LEGACY_PREF_BRANCH);
      for (const name of legacyBranch.getChildList("")) {
        if (Services.prefs.prefHasUserValue(PREF_BRANCH + name)) continue;
        const legacy = Zotero.Prefs.get(LEGACY_PREF_BRANCH + name, true);
        if (legacy !== undefined && legacy !== null) {
          Zotero.Prefs.set(PREF_BRANCH + name, legacy, true);
        }
      }
      setPref(marker, true);
    }
    catch (error) {
      try { Zotero.debug(`[LitMTrans] Legacy preference migration deferred: ${error}`); }
      catch (_) {}
    }
  }

  function normalizeProviderID(providerID) {
    const requested = String(providerID || "oneapi").trim().toLowerCase();
    if (requested === "deepseek_web") return "deepseek_web";
    const canonical = PROVIDER_ALIASES[requested]
      || (requested.endsWith("_web") ? "free_machine" : requested);
    return PROVIDERS[canonical] ? canonical : "oneapi";
  }

  function providerSpec(providerID) {
    return PROVIDERS[normalizeProviderID(providerID)] || PROVIDERS.oneapi;
  }

  function isWebMachineProvider(providerID) {
    if (providerID === "deepseek_web") return false;
    return Boolean(providerSpec(providerID).webMachine);
  }

  function isOpenAICompatibleGateway(providerID) {
    return ["oneapi", "openai_compatible"].includes(normalizeProviderID(providerID));
  }

  function modelNameTokens(model) {
    return String(model || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  function chooseChatModel(models, current = "") {
    const ids = Array.isArray(models) ? models : [];
    if (current && ids.includes(current)) return current;
    for (const keyword of ["mini", "flash", "lite"]) {
      const match = ids.find(model => modelNameTokens(model).includes(keyword));
      if (match) return match;
    }
    return ids[0] || current;
  }

  function isProbablyImageModel(model) {
    const name = String(model || "").trim().toLowerCase();
    return [
      "image", "img", "dall", "flux", "stable-diffusion", "sdxl",
      "midjourney", "ideogram", "recraft", "seedream", "jimeng",
      "kling-image"
    ].some(marker => name.includes(marker));
  }

  function chooseTranslationModel(provider, models, current = "") {
    const ids = Array.isArray(models) ? models : [];
    if (current && ids.includes(current)) return current;
    const preferred = {
      deepseek: ["deepseek-reasoner", "deepseek-chat"],
      oneapi: ["gpt-5-pro", "gpt-5", "gpt-4.1", "gpt-4o"],
      openai_compatible: ["gpt-5-pro", "gpt-5", "gpt-4.1", "gpt-4o"],
      gemini: [
        "gemini-3.5-flash",
        "gemini-3.1-flash-lite",
        "gemini-3.1-pro-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite"
      ]
    }[String(provider || "").toLowerCase()] || [];
    for (const wanted of preferred) {
      const match = ids.find(model => model.toLowerCase() === wanted);
      if (match) return match;
    }
    if (provider === "zai") {
      const flash = ids.find(model => modelNameTokens(model).includes("flash"));
      if (flash) return flash;
    }
    for (const quality of ["ultra", "max", "pro", "reasoner"]) {
      const match = ids.find(model => modelNameTokens(model).includes(quality));
      if (match) return match;
    }
    return ids[0] || current;
  }

  function normalizeBaseURL(baseURL, providerID = "oneapi") {
    const provider = String(providerID || "oneapi").toLowerCase();
    const spec = providerSpec(provider);
    let url = String(baseURL || "").trim().replace(/\/+$/g, "");
    if (!url) url = spec.defaultBaseURL;
    if (provider === "gemini" || /generativelanguage\.googleapis\.com/i.test(url)) {
      if (LitMTrans.PortedCore?.normalize_ai_base_url) return LitMTrans.PortedCore.normalize_ai_base_url(url, "gemini");
      return url
        .replace(/\/v1beta\/openai$/i, "/v1beta")
        .replace(/\/v1\/openai$/i, "/v1beta")
        .replace(/\/openai$/i, "")
        .replace(/\/+$/g, "");
    }
    url = url
      .replace(/\/(?:chat\/completions|responses|messages|images\/generations|images\/edits|models)$/i, "")
      .replace(/\/+$/g, "");
    if (url && spec.appendV1 && !/\/v\d+(?:beta\d*)?$/i.test(url)) {
      url += "/v1";
    }
    else if (url && !spec.appendV1 && /\/v1$/i.test(url)) {
      url = url.slice(0, -3).replace(/\/+$/g, "");
    }
    return url;
  }

  function endpointURL(baseURL, suffix, providerID = "oneapi") {
    const root = normalizeBaseURL(baseURL, providerID).replace(/\/+$/g, "");
    if (!root) throw new Error("尚未配置API地址");
    const path = String(suffix || "").replace(/^\/+/, "");
    // SiliconFlow's /models endpoint also exposes embedding and reranker
    // models. Restrict the result to chat models so refresh cannot populate
    // unusable choices in the settings panel.
    if (String(providerID || "").toLowerCase() === "siliconflow" && path === "models") {
      return `${root}/${path}?sub_type=chat`;
    }
    return `${root}/${path}`;
  }

  function createLocalFile(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file;
  }

  function fileURI(path) {
    return Services.io.newFileURI(createLocalFile(path)).spec;
  }

  function resourceURL(documentID, relativePath = "") {
    const encodedDoc = encodeURIComponent(String(documentID || ""));
    const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const encodedPath = normalized.split("/").map(part => encodeURIComponent(part)).join("/");
    return `resource://litmtrans-data/${encodedDoc}/${encodedPath}`;
  }

  function stripCodeFence(text) {
    let value = String(text || "").trim();
    const match = value.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : value;
  }

  const LATEX_SIMPLE_ESCAPE_COMMANDS = new Set([
    "nu", "nabla", "neq", "neg", "not", "notag", "notin", "nexists", "natural", "nobreakspace", "nobreakdash", "noalign", "nonumber", "nonumberline", "norm", "normalfont", "newcommand", "newenvironment", "newtheorem", "nocite", "numberwithin", "ne", "ncong", "ngeq", "ngeqq", "ngeqslant", "ngtr", "nleq", "nleqq", "nleqslant", "nless", "nmid", "nparallel", "nprec", "npreceq", "nrightarrow", "nRightarrow", "nsubset", "nsubseteq", "nsucc", "nsucceq", "nsupset", "nsupseteq", "ntriangleleft", "ntrianglelefteq", "ntriangleright", "ntrianglerighteq",
    "rho", "right", "rangle", "rbrace", "rceil", "rfloor", "rvert", "rVert", "ref", "relax", "renewcommand", "renewenvironment", "renewtheorem", "raisebox", "raggedleft", "raggedright", "roman", "rm", "rmfamily", "rule", "root", "rotatebox", "resizebox", "rightarrow", "rightharpoonup", "rightharpoondown", "rightleftarrows", "rightleftharpoons",
    "text", "textbf", "textit", "textrm", "textsf", "texttt", "textsl", "textsc", "textmd", "textup", "textnormal", "textstyle", "textcolor", "textwidth", "textheight", "textsuperscript", "textsubscript", "theoremstyle", "thispagestyle", "thanks", "title", "tableofcontents",
    "tau", "theta", "tilde", "times", "top", "to", "tfrac", "tbinom", "tag", "tan", "tanh", "tiny", "thinspace", "thickspace", "today", "triangle", "triangledown", "triangleleft", "triangleright", "tt", "ttfamily", "twocolumn", "typeout", "toprule", "midrule", "bottomrule"
  ]);

  function isLatexSimpleEscape(text, index) {
    const next = text[index + 1];
    if (next === "b" || next === "f") return /[a-zA-Z]/.test(text[index + 2] || "");
    if (!["n", "r", "t"].includes(next)) return false;
    const command = text.slice(index + 1).match(/^([a-zA-Z]+)/)?.[1] || "";
    return LATEX_SIMPLE_ESCAPE_COMMANDS.has(command);
  }

  function extractJSONObject(text) {
    let value = stripCodeFence(text);
    const candidates = [value];
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(value.slice(start, end + 1));
    let lastError = null;
    for (const candidate of candidates) {
      const repaired = repairInvalidJSONEscapes(candidate);
      const variants = repaired !== candidate ? [repaired, candidate] : [candidate];
      for (const variant of variants) {
        try {
          return JSON.parse(variant);
        }
        catch (error) {
          lastError = error;
        }
      }
    }
    if (lastError) throw lastError;
    throw new Error("模型返回内容无法解析，请稍后重试");
  }

  function repairInvalidJSONEscapes(text) {
    const validSimple = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t"]);
    let output = "";
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char !== "\\") {
        output += char;
        continue;
      }
      const next = text[index + 1];
      if (next && validSimple.has(next)) {
        if (isLatexSimpleEscape(text, index)) {
          output += "\\\\";
        }
        else {
          output += char + next;
          index++;
        }
      }
      else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
        output += text.slice(index, index + 6);
        index += 5;
      }
      else {
        output += "\\\\";
      }
    }
    return output;
  }

  function cleanText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  }

  function collapseWhitespace(value) {
    return cleanText(value).replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function markerDetected(text, marker) {
    if (!marker) return false;
    if (String(text || "").includes(marker)) return true;
    const digits = String(marker).replace(/\D/g, "");
    if (!digits) return false;
    const pattern = new RegExp(digits.split("").map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_\\-.,:;|/\\\\]*"));
    return pattern.test(String(text || ""));
  }

  function stripMarker(text, marker) {
    let value = String(text || "");
    const index = value.lastIndexOf(marker);
    if (index >= 0) value = value.slice(0, index);
    return value
      .replace(/(?:结束标记|截止标记|完成标记|end\s*marker|completion\s*token)\s*[:：]?\s*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n";
  }

  function targetLanguageInstruction(targetLanguage) {
    const language = String(targetLanguage || "简体中文").trim();
    if (language === "简体中文" || language === "繁体中文") {
      return `Use ${language}. Prefer standard academic Chinese terminology and retain necessary English abbreviations.`;
    }
    return `Use ${language}. Do not switch to Chinese unless Chinese source text itself must be translated into ${language}.`;
  }

  function redactLocalPaths(text) {
    return String(text || "").replace(/^(来源|文件路径)\s*:\s*(?:[a-z]:[\\/]|\\\\)[^\r\n]*$/gim, "$1: [本地路径已隐藏]");
  }

  function throttled(callback, interval = 100) {
    let timer = null;
    let pendingArgs = null;
    return (...args) => {
      pendingArgs = args;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const current = pendingArgs;
        pendingArgs = null;
        callback(...current);
      }, interval);
    };
  }

  function imageAnchorKey(source) {
    const value = String(source || "").trim().replace(/\\/g, "/");
    return value ? `image:${hashString(value)}` : "";
  }

  function sharedImageAnchorKeys(sourceKeys, targetKeys) {
    const source = (Array.isArray(sourceKeys) ? sourceKeys : [])
      .map(key => String(key || ""))
      .filter(Boolean);
    const target = (Array.isArray(targetKeys) ? targetKeys : [])
      .map(key => String(key || ""))
      .filter(Boolean);
    const counts = values => values.reduce((result, key) => {
      result.set(key, (result.get(key) || 0) + 1);
      return result;
    }, new Map());
    const sourceCounts = counts(source);
    const targetCounts = counts(target);
    return source.filter(key => sourceCounts.get(key) === 1 && targetCounts.get(key) === 1);
  }

  LitMTrans.Constants = {
    PREF_BRANCH,
    LEGACY_PREF_BRANCH,
    PROVIDERS,
    LANGUAGE_SUGGESTIONS,
    SUPPORTED_INPUT_EXTENSIONS,
    MINERU_API_BASE: "https://mineru.net/api/v4",
    USER_AGENT: "LitMTrans/2.0.0",
    TRANSLATABLE_LAYOUT_TYPES: new Set([
      "title", "text", "table_caption", "table_footnote", "chart_caption", "image_caption", "image_footnote"
    ])
  };

  LitMTrans.Utils = {
    base64Encode,
    base64Decode,
    CancelledError,
    newAbortController,
    throwIfAborted,
    sleep,
    randomID,
    hashString,
    sha256Hex,
    sha256Bytes,
    opaqueCacheKey,
    randomCacheKey,
    safeStem,
    extension,
    chatImageExtension,
    localTimestampToken,
    pastedImageName,
    isIdentifiedPastedImageName,
    escapeHTML,
    escapeAttribute,
    normalizeError,
    isMinerUTokenCredentialError,
    clonePlain,
    getPref,
    setPref,
    clearPref,
    migrateLegacyPreferences,
    normalizeProviderID,
    normalizeLanguageName,
    providerSpec,
    isWebMachineProvider,
    isOpenAICompatibleGateway,
    chooseChatModel,
    chooseTranslationModel,
    isProbablyImageModel,
    normalizeBaseURL,
    endpointURL,
    createLocalFile,
    fileURI,
    resourceURL,
    stripCodeFence,
    extractJSONObject,
    cleanText,
    collapseWhitespace,
    markerDetected,
    stripMarker,
    targetLanguageInstruction,
    redactLocalPaths,
    throttled,
    imageAnchorKey,
    sharedImageAnchorKeys,
    encodeBytesBase64,
    detectImageMimeType,
    decodeImageDataURL
  };
})(this);
