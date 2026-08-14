/*
 * Microsoft Edge on-device translation bridge.
 *
 * Edge exposes its Translator API only inside Edge.  Zotero therefore starts
 * a short-lived, headless Edge profile and talks to its page through the
 * loopback-only DevTools endpoint.  No source text is sent to a web service.
 */
(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const PROVIDER = "edge_local";
  const MAX_CHARS = 3000;
  const START_TIMEOUT = 8000;
  const COMMAND_TIMEOUT = 30000;
  const LONG_TRANSLATION_TIMEOUT = 90000;
  const PROCESS_EXIT_GRACE = 5000;
  const HOST_TITLE = "LitMTrans Edge Local Translation";

  class EdgeLocalTranslationError extends Error {
    constructor(message, cause = null) {
      super(message);
      this.name = "EdgeLocalTranslationError";
      this.cause = cause;
    }
  }

  function abort(signal) {
    if (!signal?.aborted) return;
    if (U?.throwIfAborted) U.throwIfAborted(signal);
    const error = new (U?.CancelledError || Error)(String(signal.reason || "用户已停止翻译。"));
    error.cancelled = true;
    throw error;
  }

  function sleep(milliseconds, signal = null) {
    abort(signal);
    return new Promise((resolve, reject) => {
      let onAbort = null;
      const timer = setTimeout(() => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, Number(milliseconds || 0)));
      if (!signal) return;
      onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        try { abort(signal); }
        catch (error) { reject(error); }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function languageCode(language) {
    const raw = U?.normalizeLanguageName ? U.normalizeLanguageName(language) : String(language || "").trim();
    const normalized = raw.toLowerCase().replace(/_/g, "-");
    const mapping = {
      "简体中文": "zh-Hans", "中文": "zh-Hans", "zh": "zh-Hans", "zh-cn": "zh-Hans", "zh-hans": "zh-Hans",
      "繁体中文": "zh-Hant", "zh-tw": "zh-Hant", "zh-hant": "zh-Hant",
      "英文": "en", "英语": "en", "english": "en", "en": "en",
      "日文": "ja", "日语": "ja", "japanese": "ja", "ja": "ja",
      "韩文": "ko", "韩语": "ko", "korean": "ko", "ko": "ko",
      "德文": "de", "德语": "de", "german": "de", "de": "de",
      "法文": "fr", "法语": "fr", "french": "fr", "fr": "fr",
      "西班牙文": "es", "西班牙语": "es", "spanish": "es", "es": "es",
      "意大利文": "it", "意大利语": "it", "italian": "it", "it": "it",
      "葡萄牙文": "pt", "葡萄牙语": "pt", "portuguese": "pt", "pt": "pt",
      "俄文": "ru", "俄语": "ru", "russian": "ru", "ru": "ru"
    };
    return mapping[raw] || mapping[normalized] || normalized;
  }

  function baseLanguage(code) {
    return String(code || "").split("-", 1)[0].toLowerCase();
  }

  const ENGLISH_OCR_CONFUSABLES = new Map([
    ["\u0726", "D"], // Syriac Pe, commonly emitted for an italic mathematical D.
    ["\u0739", "W"],
    ["\u0734", "R"],
    ["\u0750", "t"],
    ["\u073d", "a"],
    ["\u0751", "u"]
  ]);

  function normalizeOCRSource(text, sourceLanguage) {
    const source = String(text || "");
    if (baseLanguage(languageCode(sourceLanguage)) !== "en") return source;
    return Array.from(source, character => ENGLISH_OCR_CONFUSABLES.get(character) || character).join("");
  }

  function replaceOCRReplacementCharacters(text) {
    // U+FFFD means that OCR could not identify the original glyph. Edge's
    // on-device Translator may return an empty result for a request containing
    // it, so use a visible question mark instead of aborting the document.
    return String(text || "").replace(/\uFFFD/g, "?");
  }

  function splitEmptyTranslationRetryText(text) {
    const source = String(text || "").trim();
    if (source.length < 48) return [];
    const lines = source.split(/\r?\n+/).map(part => part.trim()).filter(Boolean);
    if (lines.length > 1) return lines;
    const sentences = source.split(/(?<=[.!?。！？；;])\s+/).map(part => part.trim()).filter(Boolean);
    if (sentences.length > 1) return sentences;
    const middle = Math.floor(source.length / 2);
    let boundary = -1;
    for (let distance = 0; distance < Math.floor(source.length / 4); distance++) {
      for (const candidate of [middle + distance, middle - distance]) {
        if (/\s/.test(source[candidate] || "")) { boundary = candidate; break; }
      }
      if (boundary >= 0) break;
    }
    if (boundary < 24 || source.length - boundary < 24) return [];
    return [source.slice(0, boundary).trim(), source.slice(boundary).trim()];
  }

  function shortenProtectedPlaceholders(text) {
    const mappings = [];
    const output = String(text || "").replace(/ZXQH[0-9A-F]{12}HQXZ/gi, token => {
      const alias = `LTMKEEP${mappings.length.toString(16).padStart(2, "0").toUpperCase()}`;
      mappings.push([alias, token]);
      return alias;
    });
    return { output, mappings };
  }

  function restoreShortPlaceholders(text, mappings) {
    let output = String(text || "");
    for (const [alias, token] of mappings || []) {
      const pattern = new RegExp(alias, "gi");
      const matches = output.match(pattern) || [];
      if (matches.length !== 1) return "";
      output = output.replace(pattern, token);
    }
    return output;
  }

  function isPlaceholderSensitiveEdgeError(error) {
    return /UnknownError|generic failures|Uncaught \(in promise\)/i.test(String(error?.message || error));
  }

  function splitEdgeLocalRetryText(text) {
    const source = String(text || "");
    if (source.length < 48) return null;
    const middle = Math.floor(source.length / 2);
    for (let distance = 0; distance <= Math.floor(source.length / 4); distance++) {
      for (const index of [middle + distance, middle - distance]) {
        if (index < 0 || index >= source.length || !/\s/.test(source[index])) continue;
        const separator = source.slice(index).match(/^\s+/)?.[0] || "";
        const left = source.slice(0, index).trimEnd();
        const right = source.slice(index + separator.length).trimStart();
        if (left.length >= 24 && right.length >= 24) return { left, separator, right };
      }
    }
    return null;
  }

  function platformIsWindows() {
    try { return Services.appinfo.OS === "WINNT"; }
    catch (_) { return false; }
  }

  function browserWindow() {
    // Zotero 9 can expose appShell while its hiddenDOMWindow getter still
    // throws NS_ERROR_FAILURE during startup. A real main window is also a
    // better home for DOM constructors whose WebIDL bindings expect a Window.
    try {
      const win = Zotero.getMainWindow?.();
      if (win) return win;
    }
    catch (_) {}
    try { return Services.appShell.hiddenDOMWindow || null; }
    catch (_) { return null; }
  }

  function subprocessModule() {
    const importer = global.ChromeUtils || (typeof ChromeUtils !== "undefined" ? ChromeUtils : null);
    if (!importer?.importESModule) throw new EdgeLocalTranslationError("当前Zotero版本不支持启动Edge子进程。");
    return importer.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
  }

  async function pathExists(path) {
    try { return await IOUtils.exists(path); }
    catch (_) { return false; }
  }

  async function containsLargeFile(directory, depth = 0) {
    if (depth > 8 || !await pathExists(directory)) return false;
    let children;
    try { children = await IOUtils.getChildren(directory); }
    catch (_) { return false; }
    for (const child of children) {
      try {
        const stat = await IOUtils.stat(child);
        if (stat.type === "regular" && Number(stat.size || 0) >= 1024 * 1024) return true;
        if (stat.type === "directory" && await containsLargeFile(child, depth + 1)) return true;
      }
      catch (_) {}
    }
    return false;
  }

  class DevToolsConnection {
    constructor(socket, options = {}) {
      this.socket = socket;
      this.defaultTimeout = Number(options.timeout || COMMAND_TIMEOUT);
      this.nextID = 0;
      this.pending = new Map();
      socket.addEventListener("message", event => this.onMessage(event));
      socket.addEventListener("close", () => this.rejectAll(new EdgeLocalTranslationError("Edge本地翻译连接已关闭。")));
      socket.addEventListener("error", () => this.rejectAll(new EdgeLocalTranslationError("Edge本地翻译连接发生错误。")));
    }

    static connect(url, options = {}) {
      const domWindow = options.window || browserWindow();
      const WebSocketConstructor = options.WebSocket || domWindow?.WebSocket;
      if (typeof WebSocketConstructor !== "function") {
        return Promise.reject(new EdgeLocalTranslationError("当前Zotero运行环境缺少WebSocket支持。"));
      }
      return new Promise((resolve, reject) => {
        let socket;
        try { socket = new WebSocketConstructor(String(url)); }
        catch (error) { reject(new EdgeLocalTranslationError(`无法连接Edge本地翻译：${error?.message || error}`, error)); return; }
        const timer = setTimeout(() => {
          try { socket.close(); } catch (_) {}
          reject(new EdgeLocalTranslationError("连接Edge本地翻译超时。"));
        }, Number(options.timeout || START_TIMEOUT));
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          resolve(new DevToolsConnection(socket, options));
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new EdgeLocalTranslationError("无法建立Edge本地翻译WebSocket连接。"));
        }, { once: true });
      });
    }

    onMessage(event) {
      let message;
      try { message = JSON.parse(String(event?.data || "")); }
      catch (_) { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (message.error) pending.reject(new EdgeLocalTranslationError(`Edge DevTools错误：${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result || {});
    }

    rejectAll(error) {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.cleanup?.();
        pending.reject(error);
      }
      this.pending.clear();
    }

    command(method, params = {}, options = {}) {
      abort(options.signal);
      const id = ++this.nextID;
      const timeout = Number(options.timeout || this.defaultTimeout);
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.cleanup?.();
          try { abort(options.signal); }
          catch (error) { reject(error); }
        };
        const timer = setTimeout(() => {
          this.pending.delete(id);
          if (options.signal) options.signal.removeEventListener("abort", onAbort);
          reject(new EdgeLocalTranslationError(`Edge本地翻译命令超时：${method}`));
        }, timeout);
        this.pending.set(id, {
          resolve,
          reject,
          timer,
          cleanup: () => options.signal?.removeEventListener("abort", onAbort)
        });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        try { this.socket.send(JSON.stringify({ id, method, params })); }
        catch (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(new EdgeLocalTranslationError(`无法发送Edge本地翻译命令：${error?.message || error}`, error));
        }
      });
    }

    async evaluate(expression, options = {}) {
      const response = await this.command("Runtime.evaluate", {
        expression: String(expression),
        awaitPromise: true,
        returnByValue: true
      }, options);
      if (response.exceptionDetails) {
        const detail = response.exceptionDetails.exception?.description
          || response.exceptionDetails.text
          || "Edge脚本执行失败";
        throw new EdgeLocalTranslationError(`Edge本地翻译错误：${detail}`);
      }
      const result = response.result || {};
      if (result.type === "undefined") return undefined;
      return result.value;
    }

    close() {
      this.rejectAll(new EdgeLocalTranslationError("Edge本地翻译连接已关闭。"));
      try { this.socket.close(); } catch (_) {}
    }
  }

  class EdgeLocalTranslator {
    constructor(targetLanguage, sourceLanguage, options = {}) {
      this.providerId = PROVIDER;
      this.currentProvider = PROVIDER;
      this.targetLanguage = String(targetLanguage || "").trim();
      this.sourceLanguage = String(sourceLanguage || "").trim();
      this.targetCode = languageCode(this.targetLanguage);
      this.sourceCode = languageCode(this.sourceLanguage);
      this.log = options.log || null;
      this.downloadConsent = options.downloadConsent || null;
      this.profileDir = options.profileDir || PathUtils.join(Zotero.Profile.dir, "litmtrans", "edge-local-translation");
      this.subprocess = options.subprocess || null;
      this.fetch = options.fetch || null;
      this.allocatePort = options.allocatePort || null;
      this.connectDevTools = options.connectDevTools || null;
      this.runSystemCommand = options.runSystemCommand || null;
      this.process = null;
      this.connection = null;
      this.edgeExecutable = "";
      this.debugPort = 0;
      this.edgeProcessPID = 0;
      this.sessionCreated = false;
      this.downloadDeclined = false;
      this.ocrNormalizationLogged = false;
    }

    get maxChars() { return MAX_CHARS; }

    async resolveEdgeExecutable() {
      if (this.edgeExecutable && await pathExists(this.edgeExecutable)) return this.edgeExecutable;
      const subprocess = this.subprocess || subprocessModule();
      const environment = subprocess.getEnvironment?.() || {};
      const roots = [environment["PROGRAMFILES(X86)"], environment.PROGRAMFILES, environment.LOCALAPPDATA].filter(Boolean);
      const candidates = roots.map(root => PathUtils.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
      candidates.push(
        PathUtils.join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        PathUtils.join("C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe")
      );
      for (const candidate of [...new Set(candidates)]) {
        if (await pathExists(candidate)) {
          this.edgeExecutable = candidate;
          return candidate;
        }
      }
      throw new EdgeLocalTranslationError("未检测到Microsoft Edge。");
    }

    allocateDebugPort() {
      if (this.allocatePort) return Number(this.allocatePort());
      const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      server.init(-1, true, -1);
      const port = Number(server.port);
      server.close();
      return port;
    }

    async hostPage() {
      await IOUtils.makeDirectory(this.profileDir, { createAncestors: true, ignoreExisting: true });
      const page = PathUtils.join(this.profileDir, "translator-host.html");
      await IOUtils.writeUTF8(page, `<!doctype html><meta charset="utf-8"><title>${HOST_TITLE}</title>`, { mode: "overwrite" });
      return page;
    }

    fetchFunction() {
      if (this.fetch) return this.fetch;
      if (typeof global.fetch === "function") return global.fetch.bind(global);
      const domWindow = browserWindow();
      if (typeof domWindow?.fetch === "function") return domWindow.fetch.bind(domWindow);
      throw new EdgeLocalTranslationError("当前Zotero运行环境缺少本地HTTP请求能力。");
    }

    async systemCommand(name, arguments_, timeout = COMMAND_TIMEOUT) {
      if (this.runSystemCommand) {
        const result = await this.runSystemCommand(name, arguments_, { timeout });
        return typeof result === "string" ? { stdout: result, exitCode: 0 } : (result || { stdout: "", exitCode: 0 });
      }
      const subprocess = this.subprocess || subprocessModule();
      const environment = subprocess.getEnvironment?.() || {};
      const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || "C:\\Windows";
      let command = PathUtils.join(systemRoot, "System32", name);
      if (!await pathExists(command)) command = await subprocess.pathSearch(name);
      const process = await subprocess.call({ command, arguments: arguments_ || [], stderr: "ignore" });
      const output = (async () => {
        let value = "";
        if (!process.stdout?.readString) return value;
        while (true) {
          const chunk = await process.stdout.readString();
          if (!chunk) return value;
          value += chunk;
        }
      })();
      const completed = Promise.all([process.wait(), output]);
      let timer = null;
      const timeoutMarker = {};
      let result;
      try {
        result = await Promise.race([
          completed,
          new Promise(resolve => { timer = setTimeout(() => resolve(timeoutMarker), Math.max(1, Number(timeout || COMMAND_TIMEOUT))); })
        ]);
      }
      finally {
        if (timer) clearTimeout(timer);
      }
      if (result === timeoutMarker) {
        try { await process.kill(0); } catch (_) {}
        try { await completed; } catch (_) {}
        throw new EdgeLocalTranslationError(`Windows命令执行超时：${name}`);
      }
      return { exitCode: Number(result[0]?.exitCode ?? process.exitCode ?? 0), stdout: String(result[1] || "") };
    }

    async edgePIDForDebugPort(port) {
      if (!platformIsWindows() || !Number(port)) return 0;
      try {
        const { stdout } = await this.systemCommand("netstat.exe", ["-ano", "-p", "tcp"], 3000);
        const suffix = `:${Number(port)}`;
        for (const line of String(stdout || "").split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[0].toUpperCase() === "TCP" && parts[1].endsWith(suffix) && /^\d+$/.test(parts.at(-1))) {
            return Number(parts.at(-1));
          }
        }
      }
      catch (_) {}
      return 0;
    }

    async pidIsRunning(pid) {
      if (!Number(pid)) return false;
      try {
        const { stdout } = await this.systemCommand("tasklist.exe", ["/FI", `PID eq ${Number(pid)}`, "/NH"], 2000);
        return String(stdout || "").includes(String(Number(pid)));
      }
      catch (_) {
        // Match the Python implementation's conservative behavior: if the
        // probe fails, assume Edge is still alive and proceed to taskkill.
        return true;
      }
    }

    async start(signal = null) {
      if (this.connection) return;
      abort(signal);
      if (!platformIsWindows()) throw new EdgeLocalTranslationError("Edge本地翻译仅支持Windows。");
      if (!this.sourceCode || /^(?:auto|自动)/i.test(this.sourceCode)) {
        throw new EdgeLocalTranslationError("Edge本地翻译需要指定源语言，不能使用自动识别。");
      }
      if (!this.targetCode) throw new EdgeLocalTranslationError("Edge本地翻译需要指定目标语言。");
      const executable = await this.resolveEdgeExecutable();
      const port = this.allocateDebugPort();
      const page = await this.hostPage();
      const subprocess = this.subprocess || subprocessModule();
      this.process = await subprocess.call({
        command: executable,
        arguments: [
          "--headless=new",
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          "--remote-allow-origins=*",
          `--user-data-dir=${this.profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-background-mode",
          U.fileURI(page)
        ],
        stderr: "ignore"
      });
      this.debugPort = port;
      const deadline = Date.now() + START_TIMEOUT;
      let tab = null;
      const fetchFunction = this.fetchFunction();
      try {
        while (Date.now() < deadline) {
          abort(signal);
          try {
            const response = await fetchFunction(`http://127.0.0.1:${port}/json`, { cache: "no-store" });
            if (response.ok) {
              const tabs = await response.json();
              tab = (Array.isArray(tabs) ? tabs : []).find(item => item?.title === HOST_TITLE);
              if (tab?.webSocketDebuggerUrl) break;
            }
          }
          catch (_) {}
          await sleep(100, signal);
        }
        if (!tab?.webSocketDebuggerUrl) throw new EdgeLocalTranslationError("Edge本地翻译启动超时。");
        // Edge may relaunch itself and let the original Subprocess handle exit.
        // The process listening on this job's private DevTools port is the
        // reliable owner to wait for and, if necessary, terminate as a tree.
        this.edgeProcessPID = await this.edgePIDForDebugPort(port);
        this.connection = this.connectDevTools
          ? await this.connectDevTools(tab.webSocketDebuggerUrl, { signal })
          : await DevToolsConnection.connect(tab.webSocketDebuggerUrl, { timeout: START_TIMEOUT });
      }
      catch (error) {
        await this.close();
        throw error;
      }
    }

    async evaluate(expression, options = {}) {
      await this.start(options.signal);
      return this.connection.evaluate(expression, options);
    }

    async command(method, params = {}, options = {}) {
      await this.start(options.signal);
      return this.connection.command(method, params, options);
    }

    async hasCachedLanguageModel() {
      const pairDirectory = PathUtils.join(
        this.profileDir,
        "EdgeTranslateKitLanguagePack",
        `${baseLanguage(this.sourceCode)}-${baseLanguage(this.targetCode)}`
      );
      return containsLargeFile(pairDirectory);
    }

    async downloadModel(signal, reportProgress = true) {
      const options = JSON.stringify({ sourceLanguage: this.sourceCode, targetLanguage: this.targetCode });
      const button = await this.evaluate(
        "(()=>{const old=document.getElementById('litmtrans-download-model');if(old)old.remove();"
        + "const b=document.createElement('button');b.id='litmtrans-download-model';b.textContent='Download';document.body.appendChild(b);"
        + "window.__litmtransDownloadState={done:false,error:'',loaded:0,total:0};"
        + `b.onclick=async()=>{try{const s=await Translator.create({...${options},monitor:m=>m.addEventListener('downloadprogress',e=>{window.__litmtransDownloadState.loaded=e.loaded;window.__litmtransDownloadState.total=e.total})});s.destroy();window.__litmtransDownloadState.done=true}catch(e){window.__litmtransDownloadState.error=e.name+': '+e.message}};`
        + "const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()",
        { signal }
      );
      const point = JSON.parse(String(button || "{}"));
      await this.command("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, { signal });
      await this.command("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, { signal });
      let lastPercent = -1;
      while (true) {
        abort(signal);
        const rawState = await this.evaluate("JSON.stringify(window.__litmtransDownloadState)", { signal });
        const state = JSON.parse(String(rawState || "{}"));
        const total = Number(state.total || 0);
        const percent = total ? Math.floor(Number(state.loaded || 0) * 100 / total) : 0;
        if (reportProgress && this.log && percent !== lastPercent && (percent === 100 || Math.floor(percent / 5) !== Math.floor(lastPercent / 5))) {
          this.log(`Edge本地翻译语言模型下载进度：${percent}%`);
        }
        lastPercent = percent;
        if (state.error) throw new EdgeLocalTranslationError(`Edge本地翻译语言模型下载失败：${state.error}`);
        if (state.done) return;
        await sleep(250, signal);
      }
    }

    async ensureAvailable(signal, allowDownload = false, reportDownloadProgress = true) {
      const options = { sourceLanguage: this.sourceCode, targetLanguage: this.targetCode };
      const availability = await this.evaluate(`Translator.availability(${JSON.stringify(options)})`, { signal });
      if (availability === "available") return;
      if (availability === "downloadable" && allowDownload) {
        await this.downloadModel(signal, reportDownloadProgress);
        return this.ensureAvailable(signal, false, reportDownloadProgress);
      }
      // The original implementation deliberately closes this first probe and
      // starts a fresh Edge process after consent (or when activating a cached
      // model). This is required for reliable user-gesture/model activation.
      await this.close();
      if (["downloadable", "downloading"].includes(String(availability || ""))) {
        throw new EdgeLocalTranslationError("Edge本地翻译语言模型尚未下载。");
      }
      throw new EdgeLocalTranslationError(`Edge本地翻译不支持该语言对（${availability || "unknown"}）。`);
    }

    async ensureSession(signal) {
      if (this.sessionCreated) return;
      try {
        await this.ensureAvailable(signal);
      }
      catch (error) {
        if (!String(error?.message || error).includes("尚未下载") || typeof this.downloadConsent !== "function") throw error;
        if (this.downloadDeclined) throw new EdgeLocalTranslationError("用户未同意下载Edge本地翻译语言模型。", error);
        if (await this.hasCachedLanguageModel()) {
          this.log?.("正在启用已下载的Edge本地翻译语言模型…");
          await this.ensureAvailable(signal, true, false);
        }
        else {
          const approved = await this.downloadConsent(this.sourceLanguage, this.targetLanguage);
          abort(signal);
          if (!approved) {
            this.downloadDeclined = true;
            throw new EdgeLocalTranslationError("用户未同意下载Edge本地翻译语言模型。", error);
          }
          this.log?.("用户已同意，正在下载Edge本地翻译语言模型…");
          await this.ensureAvailable(signal, true, true);
        }
      }
      const options = JSON.stringify({ sourceLanguage: this.sourceCode, targetLanguage: this.targetCode });
      await this.evaluate(`(async()=>{window.__litmtransEdgeTranslator=await Translator.create(${options});return true})()`, { signal });
      this.sessionCreated = true;
      this.log?.("Edge本地翻译语言模型已就绪。");
    }

    async translateOnce(source, signal) {
      return this.evaluate(
        `window.__litmtransEdgeTranslator.translate(${JSON.stringify(source)})`,
        { signal, timeout: source.length > MAX_CHARS ? LONG_TRANSLATION_TIMEOUT : COMMAND_TIMEOUT }
      );
    }

    cleanTranslationResult(result) {
      if (typeof result === "string" && result.trim()) {
        return Array.from(result).filter(character => !/\p{C}/u.test(character)).join("");
      }
      return "";
    }

    async translateSource(source, signal, depth = 0, initialResult = undefined) {
      const result = initialResult === undefined ? await this.translateOnce(source, signal) : initialResult;
      const cleaned = this.cleanTranslationResult(result);
      if (cleaned) return cleaned;
      const parts = depth < 2 ? splitEmptyTranslationRetryText(source) : [];
      if (parts.length < 2) throw new EdgeLocalTranslationError("Edge本地翻译没有返回译文。");
      if (depth === 0) this.log?.("Edge本地翻译遇到空结果，正在拆分该文本块重试…");
      const translated = [];
      for (const part of parts) {
        abort(signal);
        translated.push(await this.translateSource(part, signal, depth + 1));
      }
      return translated.join("\n");
    }

    async translate(text, signal = null) {
      let source = String(text || "");
      if (!source.trim()) return source;
      const safeSource = replaceOCRReplacementCharacters(source);
      if (safeSource !== source) {
        source = safeSource;
        this.log?.("检测到 OCR 缺失字符（�），已用 ? 安全替换后交由 Edge 本地翻译。");
      }
      await this.ensureSession(signal);
      try {
        let originalResult;
        try {
          originalResult = await this.translateOnce(source, signal);
        }
        catch (error) {
          const shortened = shortenProtectedPlaceholders(source);
          if (!isPlaceholderSensitiveEdgeError(error)) throw error;
          this.log?.(shortened.mappings.length
            ? "当前文本块触发Edge占位符异常，正在重建会话并使用短保护标记重试…"
            : "当前文本块触发Edge本地翻译异常，正在重建会话并原文重试…");
          // A rejected Translator.translate() promise can poison this Edge
          // Translator object: every later call fails even when its input is
          // valid. Recreate the browser-backed session before the fallback.
          await this.close();
          abort(signal);
          await this.ensureSession(signal);
          try {
            const retryResult = await this.translateOnce(shortened.mappings.length ? shortened.output : source, signal);
            const restoredResult = shortened.mappings.length
              ? restoreShortPlaceholders(retryResult, shortened.mappings)
              : retryResult;
            const restoredTranslation = this.cleanTranslationResult(restoredResult);
            if (restoredTranslation) return restoredTranslation;
          }
          catch (retryError) {
            await this.close();
            if (!shortened.mappings.length) return this.translateBySegmentsAfterError(source, retryError, signal);
            return this.translateByProtectedSegmentsAfterError(source, retryError, signal);
          }
          // A non-empty response can still be unusable when Edge rewrites a
          // short marker and restoration fails. It must use the same local
          // marker-preserving recovery path as a rejected retry promise.
          await this.close();
          if (!shortened.mappings.length) return this.translateBySegmentsAfterError(source, error, signal);
          return this.translateByProtectedSegmentsAfterError(source, error, signal);
        }
        const originalTranslation = this.cleanTranslationResult(originalResult);
        if (originalTranslation) return originalTranslation;

        const normalized = normalizeOCRSource(source, this.sourceCode);
        if (normalized !== source) {
          const normalizedResult = await this.translateOnce(normalized, signal);
          const normalizedTranslation = this.cleanTranslationResult(normalizedResult);
          if (!this.ocrNormalizationLogged) {
            this.ocrNormalizationLogged = true;
            this.log?.("当前文本块返回空结果，已尝试修正常见的英文OCR字形。");
          }
          if (normalizedTranslation) return normalizedTranslation;
          return await this.translateSource(normalized, signal, 0, normalizedResult);
        }
        return await this.translateSource(source, signal, 0, originalResult);
      }
      catch (error) {
        await this.close();
        throw error;
      }
    }

    async translateBySegmentsAfterError(source, originalError, signal) {
      const split = splitEdgeLocalRetryText(source);
      if (!split) throw originalError;
      this.log?.("当前文本块重试仍失败，正在拆分为两段继续使用 Edge 本地翻译…");
      const translated = [];
      try {
        for (const part of [split.left, split.right]) {
          await this.ensureSession(signal);
          const result = this.cleanTranslationResult(await this.translateOnce(part, signal));
          if (!result) throw originalError;
          translated.push(result);
          await this.close();
        }
      }
      catch (error) {
        await this.close();
        throw error;
      }
      return translated.join(split.separator);
    }

    async translateByProtectedSegmentsAfterError(source, originalError, signal) {
      const parts = String(source || "").split(/(ZXQH[0-9A-F]{12}HQXZ)/gi);
      if (parts.length < 3) throw originalError;
      this.log?.("短保护标记重试仍失败，正在保留公式/引文标记并分段使用 Edge 本地翻译…");
      const translated = [];
      try {
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index];
          if (index % 2 || !part.trim()) {
            translated.push(part);
          }
          else {
            translated.push(await this.translate(part, signal));
          }
        }
      }
      catch (error) {
        await this.close();
        throw error;
      }
      return translated.join("");
    }

    async close() {
      const connection = this.connection;
      this.connection = null;
      this.sessionCreated = false;
      if (connection) {
        try { await connection.command("Browser.close", {}, { timeout: 2000 }); }
        catch (_) {}
        connection.close();
      }
      const process = this.process;
      this.process = null;
      const targetPID = Number(this.edgeProcessPID || process?.pid || 0);
      this.edgeProcessPID = 0;
      this.debugPort = 0;
      if (platformIsWindows() && targetPID) {
        const deadline = Date.now() + PROCESS_EXIT_GRACE;
        let running = await this.pidIsRunning(targetPID);
        while (running && Date.now() < deadline) {
          await sleep(100);
          running = await this.pidIsRunning(targetPID);
        }
        if (!running) return;
        try {
          await this.systemCommand("taskkill.exe", ["/PID", String(targetPID), "/T", "/F"], 5000);
          return;
        }
        catch (_) {}
      }
      if (process && process.exitCode == null) {
        try { await process.kill(0); }
        catch (_) {}
      }
    }

    async endJob() { await this.close(); }
  }

  LitMTrans.EdgeLocalTranslator = EdgeLocalTranslator;
  LitMTrans.EdgeLocalTranslation = {
    PROVIDER,
    MAX_CHARS,
    languageCode,
    normalizeOCRSource,
    replaceOCRReplacementCharacters,
    splitEdgeLocalRetryText,
    splitEmptyTranslationRetryText,
    EdgeLocalTranslationError,
    DevToolsConnection
  };
})(this);
