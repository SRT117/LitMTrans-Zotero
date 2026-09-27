(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  const MODERN_PROTOCOL_VERSION = "2026-07-28";
  const LEGACY_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-03-26", "2024-11-05"]);
  const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
  const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
  const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
  const LOG_LEVEL_META_KEY = "io.modelcontextprotocol/logLevel";
  const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

  function jsonText(value) {
    try { return JSON.stringify(value, null, 2); }
    catch (_) { return String(value ?? ""); }
  }

  function stripBinary(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(stripBinary);
    const output = { ...value };
    if (output.data && output.mime) {
      output.dataAvailable = true;
      delete output.data;
    }
    return output;
  }

  function resourceTemplates(includeDescription = true) {
    const rows = [
      ["litmtrans://paper/{documentID}/source", "paper-source", "解析后的 Markdown 原文", "text/markdown"],
      ["litmtrans://paper/{documentID}/translation", "paper-translation", "流式 Markdown 译文", "text/markdown"],
      ["litmtrans://paper/{documentID}/figure/{figureID}", "paper-figure", "单张论文图片", "image/png"],
      ["litmtrans://paper/{documentID}/table/{tableID}", "paper-table", "论文表格 Markdown", "text/markdown"],
      ["litmtrans://paper/{documentID}/formula/{formulaID}", "paper-formula", "论文公式 JSON", "application/json"],
      ["litmtrans://paper/{documentID}/diagram/{mode}", "paper-diagram", "论文思维导图或流程图", "application/json"],
      ["litmtrans://paper/{documentID}/chat/{sessionID}", "paper-chat", "论文对话会话", "application/json"],
      ["litmtrans://research/{artifactID}", "research-artifact", "长期研究资产", "application/json"]
    ];
    return rows.map(([uriTemplate, name, description, mimeType]) => ({ uriTemplate, name, mimeType, ...(includeDescription ? { description } : {}) }));
  }

  function requestMeta(message, params) {
    const candidate = params?._meta && typeof params._meta === "object"
      ? params._meta
      : (message?._meta && typeof message._meta === "object" ? message._meta : {});
    return candidate && typeof candidate === "object" ? candidate : {};
  }

  function mappedNameField(method) {
    return {
      "tools/call": "name",
      "prompts/get": "name",
      "resources/read": "uri"
    }[String(method || "")];
  }

  function decodeMcpName(value) {
    const text = String(value ?? "").trim();
    const prefix = "=?base64?";
    const suffix = "?=";
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) return text;
    const encoded = text.slice(prefix.length, -suffix.length);
    if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
    try {
      const binary = global.atob(encoded);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0) & 0xff);
      return new global.TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch (_) { return undefined; }
  }

  function approvalResponse(params) {
    const responses = params?.inputResponses || params?._meta?.inputResponses;
    if (!responses || typeof responses !== "object") return undefined;
    const row = responses.externalService || Object.values(responses)[0];
    if (!row || typeof row !== "object") return undefined;
    if (String(row.action || "").toLowerCase() === "reject") return false;
    const content = row.content && typeof row.content === "object"
      ? row.content
      : (row.result?.content && typeof row.result.content === "object"
        ? row.result.content
        : (row.result && typeof row.result === "object" ? row.result : row));
    if (content && content.approved !== undefined) return content.approved === true || content.approved === "true";
    return undefined;
  }

  function cacheHints(value) {
    return { ...value, ttlMs: 0, cacheScope: "private" };
  }

  class MCPProtocol {
    constructor(facade) {
      this.facade = facade;
      this.sessions = new Map();
      this.requestJobs = new Map();
      this.onClientActivity = null;
    }

    error(id, code, message, data = null) {
      return { jsonrpc: "2.0", id: id ?? null, error: { code, message: String(message || "MCP error"), ...(data == null ? {} : { data }) } };
    }

    result(id, value, era = "legacy") {
      const output = { ...(value && typeof value === "object" ? value : {}) };
      if (era === "modern") {
        if (!output.resultType) output.resultType = "complete";
        output._meta = {
          ...(output._meta || {}),
          [SERVER_INFO_META_KEY]: { name: "zotero-litmtrans", version: String(this.facade.controller?.version || "1") }
        };
      }
      return { jsonrpc: "2.0", id, result: output };
    }

    isModern(message, params, context = {}) {
      if (context.era === "modern" || context.protocolVersion === MODERN_PROTOCOL_VERSION) return true;
      if (String(context.headers?.["mcp-protocol-version"] || "") === MODERN_PROTOCOL_VERSION) return true;
      const meta = requestMeta(message, params);
      if (String(meta[PROTOCOL_VERSION_META_KEY] || "") === MODERN_PROTOCOL_VERSION) return true;
      return message?.method === "server/discover";
    }

    clientMeta(message, params, context = {}) {
      const meta = requestMeta(message, params);
      return {
        protocolVersion: String(meta[PROTOCOL_VERSION_META_KEY] || params?.protocolVersion || context.protocolVersion || ""),
        clientInfo: C.redact(meta[CLIENT_INFO_META_KEY] || params?.clientInfo || {}),
        clientCapabilities: C.redact(meta[CLIENT_CAPABILITIES_META_KEY] || {}),
        logLevel: String(meta[LOG_LEVEL_META_KEY] || "")
      };
    }

    approvalArguments(params, modern = false) {
      const input = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const args = { ...input };
      if (modern) {
        delete args.approved;
        delete args.approvalID;
        delete args.planHash;
        delete args._approvalID;
        delete args.parentApprovalID;
        return args;
      }
      const responses = params?.inputResponses || params?._meta?.inputResponses || {};
      for (const response of Object.values(responses || {})) {
        const content = response?.content || response?.result || response || {};
        if (content && typeof content === "object" && content.approved !== undefined) args.approved = content.approved === true || content.approved === "true";
        if (content && typeof content === "object" && content.approvalID) args.approvalID = content.approvalID;
        if (content && typeof content === "object" && content.planHash) args.planHash = content.planHash;
      }
      return args;
    }

    inputRequired(id, error, method = "tools/call", toolName = "") {
      const details = error?.details || {};
      const requestState = this.facade.approvals?.createRequestState?.({
        approvalID: details.approvalID,
        planHash: details.planHash,
        toolName,
        expiresAt: details.expiresAt || "",
        plan: details.plan || null
      }) || (LitMTrans.Utils?.randomID?.("request") || `request-${Date.now()}`);
      return this.result(id, {
        resultType: "input_required",
        inputRequests: {
          externalService: {
            method: "elicitation/create",
            params: {
              message: error.message,
              mode: "form",
              requestedSchema: {
                type: "object",
                properties: {
                  approved: { type: "boolean", description: "是否批准本次外部服务调用" }
                },
                required: ["approved"]
              }
            }
          }
        },
        requestState: String(requestState)
      }, "modern");
    }

    async retryApproval(params, toolName) {
      const requestState = String(params?.requestState || params?._meta?.requestState || "").trim();
      if (!requestState) return null;
      const approved = approvalResponse(params);
      if (approved === undefined) throw new C.AgentError("MCP_INPUT_REQUIRED", "外部服务批准响应必须只包含 approved:boolean", { recoverable: true });
      const approvals = this.facade.approvals;
      if (!approvals?.resolveRequestState) throw new C.AgentError("MCP_REQUEST_STATE_UNSUPPORTED", "当前 Agent 后端无法验证 requestState", { recoverable: false });
      return approvals.resolveRequestState(requestState, { toolName, approved });
    }

    async handle(message, context = {}) {
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return this.error(message?.id, -32600, "Invalid Request");
      const id = message.id;
      const method = message.method;
      const params = message.params && typeof message.params === "object" ? message.params : {};
      const modern = this.isModern(message, params, context);
      const session = context.sessionID ? this.sessions.get(String(context.sessionID)) : null;
      const clientMeta = this.clientMeta(message, params, context);
      if (!clientMeta.clientInfo?.name && session?.clientInfo) clientMeta.clientInfo = C.redact(session.clientInfo);
      if (this.onClientActivity) {
        try {
          this.onClientActivity({
            name: String(clientMeta.clientInfo?.name || "unknown"),
            version: String(clientMeta.clientInfo?.version || ""),
            protocolVersion: String(clientMeta.protocolVersion || (modern ? MODERN_PROTOCOL_VERSION : context.protocolVersion || "")),
            capabilities: clientMeta.clientCapabilities || {},
            sessionID: String(context.sessionID || ""),
            method,
            lastSeen: new Date().toISOString()
          });
        }
        catch (_) {}
      }
      if (modern && method === "initialize") return this.error(id, -32601, "2026-07-28 不使用 initialize；请先调用 server/discover");
      if (context.requireSession && !modern && method !== "initialize") {
        const sessionID = String(context.sessionID || "");
        if (!sessionID || !this.sessions.has(sessionID)) return this.error(id, -32001, "MCP session is missing or expired");
      }
      if (method.startsWith("notifications/")) {
        if (method === "notifications/initialized") return null;
        if (method === "notifications/cancelled" && params.requestId != null) {
          const jobID = this.requestJobs.get(String(params.requestId));
          if (jobID) {
            try { this.facade.tasks.cancel(jobID); } catch (_) {}
          }
        }
        return null;
      }
      try {
        switch (method) {
          case "server/discover": {
            const capabilities = await this.facade.capabilities();
            return this.result(id, cacheHints({
              supportedVersions: [MODERN_PROTOCOL_VERSION],
              capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
              instructions: (capabilities.instructions || []).join("\n")
            }), "modern");
          }
          case "initialize": {
            const requested = String(params.protocolVersion || "");
            const protocolVersion = LEGACY_PROTOCOL_VERSIONS.has(requested) ? requested : "2025-11-25";
            const sessionID = context.sessionID || LitMTrans.Utils?.randomID?.("mcp") || `mcp-${Date.now()}`;
            this.sessions.set(sessionID, { initializedAt: C.now(), protocolVersion, clientInfo: C.redact(params.clientInfo || clientMeta.clientInfo || {}) });
            const capabilities = await this.facade.capabilities();
            return this.result(id, {
              protocolVersion,
              capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
              serverInfo: { name: "zotero-litmtrans", version: String(this.facade.controller?.version || "1") },
              instructions: (capabilities.instructions || []).join("\n")
            }, "legacy");
          }
          case "ping":
            return modern ? this.error(id, -32601, "Method not found: ping") : this.result(id, {}, "legacy");
          case "logging/setLevel":
            return modern ? this.error(id, -32601, "Method not found: logging/setLevel") : this.result(id, {}, "legacy");
          case "tools/list": {
            const categories = params.categories || params._meta?.toolCategories;
            const tools = (this.facade.visibleTools?.({ categories }) || Agent.MCPTools).map(item => ({ name: item.name, description: item.description, inputSchema: item.inputSchema }));
            return this.result(id, modern ? cacheHints({ tools }) : { tools }, modern ? "modern" : "legacy");
          }
          case "tools/call": {
            const name = String(params.name || "");
            if (!Agent.MCPToolMap.has(name)) return this.error(id, -32602, `Unknown tool ${name}`);
            const approval = modern ? await this.retryApproval(params, name) : null;
            const args = this.approvalArguments(params, modern);
            if (approval) Object.assign(args, { approvalID: approval.approvalID, _approvalID: approval.approvalID, approved: approval.approved === true });
            const value = await this.facade.invoke(name, args);
            const safeValue = C.redact(stripBinary(value));
            const content = [];
            if (value && typeof value === "object" && value.data && value.mime) {
              content.push({ type: "image", data: String(value.data), mimeType: String(value.mime) });
            }
            content.push({ type: "text", text: jsonText(safeValue) });
            return this.result(id, { content, structuredContent: safeValue, isError: false }, modern ? "modern" : "legacy");
          }
          case "resources/list": return this.result(id, modern ? cacheHints({ resources: [], resourceTemplates: resourceTemplates(true) }) : { resources: [], resourceTemplates: resourceTemplates(true) }, modern ? "modern" : "legacy");
          case "resources/templates/list": return this.result(id, modern ? cacheHints({ resourceTemplates: resourceTemplates(false) }) : { resourceTemplates: resourceTemplates(false) }, modern ? "modern" : "legacy");
          case "resources/read": {
            const rows = Array.isArray(params.uris) ? params.uris : [params.uri];
            const contents = [];
            for (const uri of rows.filter(Boolean)) {
              const resource = await this.facade.readResource(uri);
              contents.push({ uri: resource.uri, mimeType: resource.mimeType, ...(resource.blob ? { blob: resource.blob } : { text: resource.text || "" }) });
            }
            return this.result(id, modern ? cacheHints({ contents }) : { contents }, modern ? "modern" : "legacy");
          }
          case "prompts/list": return this.result(id, modern ? cacheHints({ prompts: [] }) : { prompts: [] }, modern ? "modern" : "legacy");
          default: return this.error(id, -32601, `Method not found: ${method}`);
        }
      }
      catch (error) {
        const normalized = C.asAgentError(error);
        if (method === "tools/call") {
          if (modern && normalized.code === "EXTERNAL_SERVICE_APPROVAL_REQUIRED") return this.inputRequired(id, normalized, method, String(params.name || ""));
          return this.result(id, { content: [{ type: "text", text: jsonText(normalized.toJSON()) }], isError: true, structuredContent: normalized.toJSON() }, modern ? "modern" : "legacy");
        }
        return this.error(id, -32000, normalized.message, normalized.toJSON());
      }
    }

    async handleJSON(text, context = {}) {
      let value;
      try { value = JSON.parse(String(text || "")); }
      catch (_) { return this.error(null, -32700, "Parse error"); }
      if (Array.isArray(value)) {
        const responses = [];
        for (const message of value) {
          const response = await this.handle(message, context);
          if (response) responses.push(response);
        }
        return responses.length ? responses : null;
      }
      return this.handle(value, context);
    }
  }

  Agent.MCPProtocol = MCPProtocol;
  Agent.MCP_PROTOCOL_VERSION = MODERN_PROTOCOL_VERSION;
  Agent.MCP_LEGACY_PROTOCOL_VERSIONS = [...LEGACY_PROTOCOL_VERSIONS];
  Agent.MCP_META_KEYS = { PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY, LOG_LEVEL_META_KEY, SERVER_INFO_META_KEY };
  Agent.decodeMcpName = decodeMcpName;
  Agent.mcpNameSourceField = mappedNameField;
})(this);
