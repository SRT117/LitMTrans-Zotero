(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  const CONTROL_TIMEOUT_MS = 15000;
  const DOWNLOAD_TIMEOUT_MS = 180000;
  const LOGIN_TIMEOUT_MS = 600000;

  function joinPath(...parts) {
    try { return global.PathUtils?.join?.(...parts) || parts.filter(Boolean).join("/"); }
    catch (_) { return parts.filter(Boolean).join("/"); }
  }

  function jsonFromResponse(text) {
    const value = String(text || "").trim();
    if (!value) return {};
    try { return JSON.parse(value); }
    catch (_) {
      const rows = value.split(/\r?\n/).filter(line => line.startsWith("data:"));
      for (let index = rows.length - 1; index >= 0; index--) {
        try { return JSON.parse(rows[index].slice(5).trim()); } catch (_) {}
      }
    }
    throw new Error("ScanSci MCP 返回无法解析");
  }

  function parseResultValue(value) {
    if (typeof value !== "string") return value;
    const text = value.replace(/^\uFEFF/, "").trim();
    try { return JSON.parse(text); } catch (_) { return Agent.Contracts?.redactText?.(value) ?? value; }
  }

  function normalizeScanSciToolResult(response) {
    let value = response?.result || response || {};
    for (let depth = 0; depth < 6; depth++) {
      if (typeof value === "string") {
        const parsed = parseResultValue(value);
        if (parsed === value) break;
        value = parsed;
        continue;
      }
      if (value?.structuredContent && typeof value.structuredContent === "object") {
        value = value.structuredContent;
        continue;
      }
      if (Array.isArray(value?.content)) {
        const text = value.content.find(row => row?.type === "text")?.text;
        if (typeof text === "string") {
          const parsed = parseResultValue(text);
          if (parsed !== text) {
            value = parsed;
            continue;
          }
          value = parsed;
        }
        break;
      }
      if (typeof value?.text === "string") {
        const parsed = parseResultValue(value.text);
        if (parsed !== value.text) {
          value = parsed;
          continue;
        }
        if (Object.keys(value).length === 1) {
          value = parsed;
          continue;
        }
        value = { ...value, text: parsed };
      }
      if (value?.result && typeof value.result === "object") {
        value = value.result;
        continue;
      }
      if (typeof value?.result === "string") {
        const parsed = parseResultValue(value.result);
        if (parsed !== value.result) {
          value = parsed;
          continue;
        }
      }
      break;
    }
    return Agent.Contracts?.redact ? Agent.Contracts.redact(value) : value;
  }

  function normalizeScanSciDownloadResult(response) {
    let value = normalizeScanSciToolResult(response);
    if (typeof value === "string") value = { text: value };
    else if (value?.text && Object.keys(value).length === 1) value = parseResultValue(value.text);
    if (!value || typeof value !== "object") value = { value };
    const path = String(value.file || value.path || value.pdfPath || value.output_path || "");
    const source = value.source || value.doi || value.identifier || value.sourceURL || "";
    const success = value.success === false ? false : value.success === true || Boolean(path);
    const result = { ...value, success, path, source };
    return Agent.Contracts?.redact ? Agent.Contracts.redact(result) : result;
  }

  function codedError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
  }

  function recordShutdownProbe(name, value) {
    try {
      const utils = LitMTrans.Utils;
      if (utils?.getPref?.("agentTestShutdownProbe", false) && utils.getPref("agentTestShutdownProbeQuitStarted", false)) {
        utils.setPref(name, value);
        global.Services?.prefs?.savePrefFile?.(null);
      }
    }
    catch (_) {}
  }

  function withScanSciProxyEnvironment(launch, environment = global.Services?.env) {
    if (typeof launch !== "function") return undefined;
    if (!environment || typeof environment.get !== "function" || typeof environment.set !== "function") return launch();
    const read = name => {
      try { return String(environment.get(name) || "").trim(); }
      catch (_) { return ""; }
    };
    const original = read("SCANSCI_PDF_PROXY");
    if (original) return launch();
    const proxy = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"].map(read).find(Boolean);
    if (!proxy) return launch();
    try { environment.set("SCANSCI_PDF_PROXY", proxy); }
    catch (_) { return launch(); }
    try { return launch(); }
    finally { try { environment.set("SCANSCI_PDF_PROXY", ""); } catch (_) {} }
  }

  class ScanSciMCPClient {
    constructor(runtime, options = {}) {
      this.runtime = runtime;
      this.storage = options.storage || runtime?.storage;
      this.options = options;
      this.process = null;
      this.processMeta = null;
      this.preferredPort = Number(options.port || 0) || 0;
      this.port = 0;
      this.endpoint = String(options.endpoint || "");
      this.sessionID = "";
      this.requestID = 0;
      this.started = false;
      this.initialized = false;
      this.availableTools = new Set();
      this.toolSchemas = [];
      this.lastError = "";
    }

    timeoutFor(payload, options = {}) {
      if (options.timeoutMs !== undefined && options.timeoutMs !== null) return Number(options.timeoutMs) || CONTROL_TIMEOUT_MS;
      const method = String(payload?.method || "");
      const tool = String(payload?.params?.name || "");
      if (method === "tools/call" && tool === "scansci_pdf_download") return Number(options.downloadTimeoutMs || this.options.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS) || DOWNLOAD_TIMEOUT_MS;
      if (method === "tools/call" && tool === "scansci_pdf_login") return Number(options.loginTimeoutMs || this.options.loginTimeoutMs || LOGIN_TIMEOUT_MS) || LOGIN_TIMEOUT_MS;
      return Number(options.controlTimeoutMs || this.options.controlTimeoutMs || CONTROL_TIMEOUT_MS) || CONTROL_TIMEOUT_MS;
    }

    choosePort(excluded = new Set(), usePreferred = false) {
      if (usePreferred && this.preferredPort && !excluded.has(this.preferredPort)) return this.preferredPort;
      for (let attempt = 0; attempt < 20; attempt++) {
        const port = 42000 + Math.floor(Math.random() * 5000);
        if (!excluded.has(port)) return port;
      }
      return 42000 + Math.floor(Math.random() * 5000);
    }

    async spawnProcess(executable, args) {
      const factory = global.Cc?.["@mozilla.org/process/util;1"];
      if (!factory || !global.Ci?.nsIProcess) throw new Error("当前 Zotero 运行时缺少进程启动组件");
      const process = factory.createInstance(global.Ci.nsIProcess);
      process.init(LitMTrans.Utils.createLocalFile(executable));
      const meta = { process, killIssued: false, exited: false };
      this.process = process;
      this.processMeta = meta;
      try {
        withScanSciProxyEnvironment(() => process.runAsync(args, args.length, {
          observe: (_subject, topic, data) => {
            if (topic !== "process-failed" && topic !== "process-finished") return;
            if (this.process !== process || this.processMeta !== meta) return;
            meta.exited = true;
            this.process = null;
            this.processMeta = null;
            this.started = false;
            this.initialized = false;
            this.availableTools.clear();
            this.toolSchemas = [];
            this.lastError = `ScanSci 进程已退出：${data || topic}`;
            this.runtime?.invalidateHealth?.("scansci-process-exit");
          }
        }));
      }
      catch (error) {
        if (this.process === process) this.process = null;
        this.processMeta = null;
        throw error;
      }
    }

    async killProcess() {
      const process = this.process;
      const meta = this.processMeta;
      this.process = null;
      this.processMeta = null;
      if (process && meta && !meta.killIssued && !meta.exited) {
        meta.killIssued = true;
        const attempts = Math.max(0, Number(LitMTrans.Utils?.getPref?.("agentTestShutdownProbeKillAttempts", 0)) || 0);
        recordShutdownProbe("agentTestShutdownProbeKillAttempts", attempts + 1);
        recordShutdownProbe("agentTestShutdownProbePID", Number(process.pid) || 0);
        try {
          process.kill();
          recordShutdownProbe("agentTestShutdownProbeKillReturned", true);
        }
        catch (_) { recordShutdownProbe("agentTestShutdownProbeKillReturned", false); }
      }
      this.started = false;
      this.initialized = false;
      this.availableTools.clear();
      this.toolSchemas = [];
      this.sessionID = "";
    }

    endpointForPort(port, baseEndpoint = "") {
      const base = String(baseEndpoint || "");
      if (base && /:\d+(?:\/|$)/.test(base)) return base.replace(/:\d+(?=\/|$)/, `:${port}`);
      return base || `http://127.0.0.1:${port}/mcp`;
    }

    async start(options = {}) {
      if (options.signal?.aborted) throw new Error("ScanSci 服务启动已取消");
      if (this.started && await this.health({ ...options, restart: false })) return { started: true, reused: true, endpoint: this.endpoint };
      if (this.started || this.process) await this.killProcess();
      const maxAttempts = Math.min(5, Math.max(1, Number(options.maxPortAttempts || this.options.maxPortAttempts || 5) || 5));
      const triedPorts = new Set();
      const requestedEndpoint = options.endpoint || this.options.endpoint || "";
      const requestedPort = Number(options.port || this.options.port || 0) || 0;
      let lastError = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const port = attempt === 0 && requestedPort
          ? requestedPort
          : this.choosePort(triedPorts, attempt === 0 && !requestedPort);
        triedPorts.add(port);
        this.port = port;
        this.endpoint = this.endpointForPort(port, requestedEndpoint);
        this.lastError = "";
        try {
          if (typeof this.options.spawn === "function") {
            const process = await this.options.spawn({ runtime: this.runtime, port: this.port, endpoint: this.endpoint, signal: options.signal });
            this.process = process || null;
            this.processMeta = process ? { process, killIssued: false, exited: false } : null;
          }
          else {
            const state = this.runtime?.state || {};
            const executable = String(state.executable || "");
            if (!executable) throw new Error("ScanSci 托管运行时没有可执行文件");
            const args = Array.isArray(state.serverArgs) && state.serverArgs.length
              ? state.serverArgs
              : ["-m", "scansci_pdf.main", "run", "--mode", "streamable_http", "--host", "127.0.0.1", "--port", String(this.port)];
            await this.spawnProcess(executable, args);
          }
          this.started = true;
          this.initialized = false;
          this.sessionID = "";
          this.availableTools.clear();
          this.toolSchemas = [];
          if (options.waitForHealth !== false) {
            let healthy = false;
            for (let healthAttempt = 0; healthAttempt < 20; healthAttempt++) {
              if (await this.health({ ...options, restart: false })) { healthy = true; break; }
              if (!this.started) throw new Error(this.lastError || "ScanSci MCP 进程未能启动");
              await new Promise(resolve => setTimeout(resolve, Math.min(250, 50 + healthAttempt * 20)));
            }
            if (!healthy) throw new Error(this.lastError || "ScanSci MCP 服务健康检查超时");
          }
          if (!this.initialized) await this.initialize(options);
          return { started: true, reused: false, endpoint: this.endpoint, port: this.port };
        }
        catch (error) {
          if (options.signal?.aborted) throw error;
          lastError = error;
          this.runtime?.invalidateHealth?.("scansci-server-start-failed");
          await this.killProcess();
        }
      }
      throw codedError("SCANSCI_SERVER_START_FAILED", `ScanSci MCP 服务启动失败：${lastError?.message || lastError || "未知错误"}`, { cause: lastError, attempts: maxAttempts });
    }

    async request(payload, options = {}) {
      const timeoutMs = this.timeoutFor(payload, options);
      const requestOptions = { ...options, timeoutMs };
      if (typeof this.options.request === "function") return this.options.request(this.endpoint, payload, requestOptions);
      const response = await LitMTrans.HTTP.request("POST", this.endpoint, {
        timeout: timeoutMs,
        signal: options.signal,
        headers: {
          Accept: "application/json, text/event-stream",
          ...(this.sessionID ? { "Mcp-Session-Id": this.sessionID } : {})
        },
        json: payload
      });
      const sessionID = response.headers?.get?.("mcp-session-id") || response.headers?.get?.("MCP-Session-Id");
      if (sessionID) this.sessionID = String(sessionID);
      return jsonFromResponse(await response.text());
    }

    async listTools(options = {}) {
      const response = await this.request({ jsonrpc: "2.0", id: ++this.requestID, method: "tools/list", params: {} }, { ...options, timeoutMs: Number(options.controlTimeoutMs || this.options.controlTimeoutMs || CONTROL_TIMEOUT_MS) });
      if (response?.error) throw codedError("SCANSCI_TOOL_LIST_FAILED", String(response.error.message || "ScanSci MCP 工具列表获取失败"), { response });
      const tools = Array.isArray(response?.result?.tools) ? response.result.tools : Array.isArray(response?.tools) ? response.tools : [];
      this.toolSchemas = tools;
      this.availableTools = new Set(tools.map(tool => String(tool?.name || "")).filter(Boolean));
      return tools;
    }

    async initialize(options = {}) {
      if (this.initialized) return true;
      const response = await this.request({
        jsonrpc: "2.0",
        id: ++this.requestID,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "litmtrans-acquisition", version: String(this.runtime?.targetManifest?.runtimeVersion || this.runtime?.manifest?.targets?.[this.runtime?.platform?.target]?.runtimeVersion || this.runtime?.manifest?.acquisitionRuntimeVersion || "1.17.0") }
        }
      }, { ...options, timeoutMs: Number(options.controlTimeoutMs || this.options.controlTimeoutMs || CONTROL_TIMEOUT_MS) });
      if (response?.error) throw new Error(String(response.error.message || "ScanSci MCP 初始化失败"));
      await this.request({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, { ...options, timeoutMs: Number(options.controlTimeoutMs || this.options.controlTimeoutMs || CONTROL_TIMEOUT_MS) }).catch(() => {});
      await this.listTools({ ...options, timeoutMs: Number(options.controlTimeoutMs || this.options.controlTimeoutMs || CONTROL_TIMEOUT_MS) });
      this.initialized = true;
      return true;
    }

    async health(options = {}) {
      if (typeof this.options.health === "function") return Boolean(await this.options.health({ client: this, ...options }));
      if (!this.started && !this.endpoint) return false;
      try {
        await this.initialize(options);
        const response = await this.request({ jsonrpc: "2.0", id: ++this.requestID, method: "ping", params: {} }, { ...options, timeoutMs: Number(options.controlTimeoutMs || this.options.controlTimeoutMs || CONTROL_TIMEOUT_MS) });
        return !response?.error;
      }
      catch (error) {
        this.lastError = String(error?.message || error);
        return false;
      }
    }

    async call(name, args = {}, options = {}) {
      const toolName = String(name || "");
      if (options.signal?.aborted) throw codedError("JOB_CANCELLED", "ScanSci 工具调用已取消", { recoverable: true });
      if (!this.started || !(await this.health({ ...options, restart: false }))) {
        await this.start(options);
      }
      if (!this.initialized) await this.initialize(options);
      if (!this.availableTools.has(toolName)) throw codedError("SCANSCI_TOOL_UNAVAILABLE", `ScanSci MCP 工具不可用：${name}`, { tool: name, availableTools: [...this.availableTools] });
      const timeoutMs = toolName === "scansci_pdf_download"
        ? Number(options.timeoutMs || options.downloadTimeoutMs || this.options.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS)
        : toolName === "scansci_pdf_login"
          ? Number(options.timeoutMs || options.loginTimeoutMs || this.options.loginTimeoutMs || LOGIN_TIMEOUT_MS)
          : Number(options.timeoutMs || options.controlTimeoutMs || this.options.controlTimeoutMs || CONTROL_TIMEOUT_MS);
      let abortHandler = null;
      if (options.signal?.addEventListener && ["scansci_pdf_download", "scansci_pdf_login"].includes(toolName)) {
        abortHandler = () => { void this.killProcess(); };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
      try {
        const response = await this.request({ jsonrpc: "2.0", id: ++this.requestID, method: "tools/call", params: { name, arguments: args } }, { ...options, timeoutMs });
        if (response?.error) throw codedError("SCANSCI_TOOL_CALL_FAILED", String(response.error.message || "ScanSci MCP 工具调用失败"), { response });
        const result = response?.result || response;
        if (result?.isError) throw codedError("SCANSCI_TOOL_CALL_FAILED", String(result.content?.[0]?.text || "ScanSci MCP 工具返回错误"), { response });
        return toolName === "scansci_pdf_download" ? normalizeScanSciDownloadResult(response) : normalizeScanSciToolResult(response);
      }
      catch (error) {
        if (options.signal?.aborted) this.runtime?.invalidateHealth?.("scansci-call-cancelled");
        else if (error?.code === "SCANSCI_TOOL_CALL_FAILED") this.runtime?.invalidateHealth?.("scansci-tool-failed");
        throw error;
      }
      finally {
        if (abortHandler) options.signal.removeEventListener("abort", abortHandler);
      }
    }

    async shutdown() {
      await this.killProcess();
      this.endpoint = "";
      this.port = 0;
      return { stopped: true };
    }

    async restart(options = {}) {
      await this.shutdown();
      return this.start(options);
    }

    diagnostics() {
      return { started: this.started, initialized: this.initialized, endpoint: this.endpoint, port: this.port, sessionID: Boolean(this.sessionID), availableTools: [...this.availableTools], lastError: this.lastError };
    }

    hasTools(names = []) {
      const required = Array.isArray(names) ? names : [names];
      return required.length > 0 && required.every(name => this.availableTools.has(String(name || "")));
    }
  }

  Agent.normalizeScanSciToolResult = normalizeScanSciToolResult;
  Agent.normalizeScanSciDownloadResult = normalizeScanSciDownloadResult;
  Agent.ScanSciMCPClient = ScanSciMCPClient;
  Agent.ScanSciDownloadInternals = { normalizeScanSciToolResult, normalizeScanSciDownloadResult, jsonFromResponse, withScanSciProxyEnvironment, CONTROL_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, LOGIN_TIMEOUT_MS };
})(this);
