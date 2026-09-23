(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function headerMap(raw) {
    const output = {};
    for (const line of String(raw || "").split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index < 0) continue;
      output[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    return output;
  }

  function response(status, body = "", headers = {}) {
    const text = String(body || "");
    const length = (() => {
      try { return new TextEncoder().encode(text).byteLength; }
      catch (_) { return unescape(encodeURIComponent(text)).length; }
    })();
    const statusText = { 200: "OK", 202: "Accepted", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 411: "Length Required", 413: "Payload Too Large", 500: "Internal Server Error" }[status] || "OK";
    const lines = [`HTTP/1.1 ${status} ${statusText}`, "Connection: close", "Cache-Control: no-store", `Content-Length: ${length}`];
    for (const [key, value] of Object.entries(headers || {})) lines.push(`${key}: ${value}`);
    return `${lines.join("\r\n")}\r\n\r\n${text}`;
  }

  function loopbackHost(value) {
    const text = String(value || "").trim().toLowerCase().replace(/^\[/, "").replace(/\](:\d+)?$/, "").replace(/:\d+$/, "");
    return text === "127.0.0.1" || text === "localhost" || text === "::1";
  }

  function allowedOrigin(value) {
    const origin = String(value || "").trim();
    if (!origin) return "";
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" || !loopbackHost(parsed.host)) return null;
      return origin;
    }
    catch (_) { return null; }
  }

  function corsHeaders(origin) {
    const accepted = allowedOrigin(origin);
    return {
      ...(accepted ? { "Access-Control-Allow-Origin": accepted } : {}),
      "Access-Control-Allow-Headers": "content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Expose-Headers": "Mcp-Protocol-Version, Mcp-Session-Id",
      Vary: "Origin"
    };
  }

  function messagesOf(value) {
    return Array.isArray(value) ? value.filter(Boolean) : (value && typeof value === "object" ? [value] : []);
  }

  function modernBody(value) {
    return messagesOf(value).some(message => {
      const params = message?.params && typeof message.params === "object" ? message.params : {};
      const meta = params._meta && typeof params._meta === "object" ? params._meta : {};
      return String(meta["io.modelcontextprotocol/protocolVersion"] || "") === "2026-07-28";
    });
  }

  function decodeMcpName(value) {
    return Agent.decodeMcpName ? Agent.decodeMcpName(value) : String(value || "");
  }

  function headerMismatch(id, mismatch, message) {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: -32020,
        message: "HeaderMismatch",
        data: { mismatch: String(mismatch || ""), detail: String(message || "") }
      }
    };
  }

  async function readHTTPRequest(input, maxBytes = 16 * 1024 * 1024) {
    const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    binary.setInputStream(input);
    const reader = {
      available: () => input.available(),
      readBytes: count => binary.readByteArray(count)
    };
    return Agent.MCPHttpRequestReader.readHttpRequest(reader, {
      maxRequestSize: maxBytes,
      maxWaitAttempts: 500,
      waitMs: 10
    });
  }

  class MCPHTTPServer {
    constructor(protocol, controller) {
      this.protocol = protocol;
      this.controller = controller;
      this.socket = null;
      this.port = 0;
      this.host = "127.0.0.1";
      this.path = "/litmtrans/mcp";
      this.startedAt = "";
    }

    get url() {
      return `http://${this.host}:${this.port}${this.path}`;
    }

    async start(options = {}) {
      if (this.socket) return this.status();
      this.host = String(options.host || LitMTrans.Utils?.getPref?.("agentHost", "127.0.0.1") || "127.0.0.1");
      if (this.host !== "127.0.0.1" && this.host !== "localhost") this.host = "127.0.0.1";
      const requestedPort = Math.max(0, Number(options.port ?? LitMTrans.Utils?.getPref?.("agentPort", 0)) || 0);
      let server = Cc?.["@mozilla.org/network/server-socket;1"]?.createInstance?.(Ci?.nsIServerSocket);
      if (!server) throw new C.AgentError("AGENT_SERVER_UNAVAILABLE", "当前 Zotero 运行环境没有可用的本地 HTTP 监听器", { recoverable: true });
      try {
        server.init(requestedPort, true, -1);
      }
      catch (error) {
        if (!requestedPort) throw error;
        try { server.close(); } catch (_) {}
        // Zotero-mcp 或其他本地服务可能已经占用首选端口；继续使用
        // 系统分配的 loopback 端口，并把真实端口写回设置供配置工具读取。
        server = Cc?.["@mozilla.org/network/server-socket;1"]?.createInstance?.(Ci?.nsIServerSocket);
        if (!server) throw error;
        server.init(0, true, -1);
      }
      this.socket = server;
      this.port = Number(server.port || requestedPort);
      this.startedAt = C.now();
      const listener = {
        onSocketAccepted: (_socket, transport) => { void this.handleTransport(transport); },
        onStopListening: () => {}
      };
      this.listener = listener;
      server.asyncListen(listener);
      if (this.port) LitMTrans.Utils?.setPref?.("agentPort", this.port);
      return this.status();
    }

    status() {
      return { running: Boolean(this.socket), host: this.host, port: this.port, url: this.socket ? this.url : "", path: this.path, startedAt: this.startedAt };
    }

    stop() {
      if (this.socket) {
        try { this.socket.close(); } catch (_) {}
      }
      this.socket = null;
      this.port = 0;
      this.startedAt = "";
    }

    async handleTransport(transport) {
      let input;
      let output;
      try {
        input = transport.openInputStream(0, 0, 0);
        output = transport.openOutputStream(0, 0, 0);
        const request = await readHTTPRequest(input);
        if (!request.complete) {
          await this.write(transport, response(request.status || 400, JSON.stringify({ error: request.error || "Malformed HTTP request" }), { "Content-Type": "application/json; charset=utf-8" }), output);
          return;
        }
        await this.handleRawRequest(transport, request, output);
      }
      catch (error) {
        try { await this.write(transport, response(500, JSON.stringify({ error: String(error?.message || error) }), { "Content-Type": "application/json; charset=utf-8" }), output); }
        catch (_) {}
      }
    }

    async write(transport, payload, existingOutput = null) {
      const output = existingOutput || transport.openOutputStream(0, 0, 0);
      try {
        const text = String(payload || "");
        const encoded = (() => {
          try { return Array.from(new TextEncoder().encode(text)); }
          catch (_) {
            const binary = unescape(encodeURIComponent(text));
            return Array.from(binary, char => char.charCodeAt(0) & 0xff);
          }
        })();
        for (let index = 0; index < encoded.length;) {
          const chunk = String.fromCharCode(...encoded.slice(index, index + 8192));
          let offset = 0;
          while (offset < chunk.length) {
            const written = Number(output.write(chunk.slice(offset), chunk.length - offset)) || 0;
            if (written <= 0) throw new Error("MCP HTTP response stream closed before all bytes were written");
            offset += written;
            index += written;
          }
        }
        try { output.flush?.(); } catch (_) {}
      }
      finally {
        await new Promise(resolve => setTimeout(resolve, 50));
        try { output.close(); } catch (_) {}
      }
      try { transport.close?.(null); } catch (_) {}
    }

    async handleRawRequest(transport, raw, output = null) {
      const parsed = raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "headerText")
        ? raw
        : (() => {
          const separator = String(raw).indexOf("\r\n\r\n");
          return separator < 0 ? null : { headerText: String(raw).slice(0, separator), body: String(raw).slice(separator + 4) };
        })();
      if (!parsed) {
        await this.write(transport, response(400, JSON.stringify({ error: "Malformed HTTP request" }), { "Content-Type": "application/json; charset=utf-8" }), output);
        return;
      }
      const headerText = parsed.headerText;
      const body = parsed.body;
      const [requestLine, ...headerLines] = headerText.split(/\r\n/);
      const [method, target] = String(requestLine || "").split(/\s+/, 3);
      const headers = headerMap(headerLines.join("\r\n"));
      const url = String(target || "").split("?", 1)[0];
      const origin = allowedOrigin(headers.origin);
      const common = corsHeaders(headers.origin);
      const writeJSON = (status, value, extra = {}) => this.write(transport, response(status, typeof value === "string" ? value : JSON.stringify(value), { ...common, "Content-Type": "application/json; charset=utf-8", ...extra }), output);
      if (!loopbackHost(headers.host)) {
        await writeJSON(403, { error: "Only loopback Host is allowed" });
        return;
      }
      if (origin === null) {
        await writeJSON(403, { error: "Only loopback Origin is allowed" });
        return;
      }
      if (method === "OPTIONS") {
        await this.write(transport, response(204, "", common), output);
        return;
      }
      if (method === "GET" && url === "/litmtrans/health") {
        await writeJSON(200, { name: "litmtrans", status: "ok", server: this.status() });
        return;
      }
      if (url !== this.path) {
        await writeJSON(404, { error: "Not Found" });
        return;
      }
      if (method === "DELETE") {
        const sessionID = String(headers["mcp-session-id"] || "");
        if (sessionID) this.protocol.sessions.delete(sessionID);
        await this.write(transport, response(204, "", common), output);
        return;
      }
      if (method !== "POST") {
        await writeJSON(405, { error: "MCP endpoint requires POST or DELETE" }, { Allow: "POST, DELETE, OPTIONS" });
        return;
      }
      const expected = Math.max(0, Number(parsed.contentLength || headers["content-length"] || 0));
      if (expected > 16 * 1024 * 1024) {
        await writeJSON(413, { error: "Request body too large" });
        return;
      }
      const requestedVersion = String(headers["mcp-protocol-version"] || "").trim();
      let bodyValue = null;
      try { bodyValue = JSON.parse(body); } catch (_) {}
      const modern = requestedVersion === "2026-07-28" || modernBody(bodyValue);
      const sessionID = headers["mcp-session-id"] || (modern ? "" : LitMTrans.Utils?.randomID?.("mcp") || `mcp-${Date.now()}`);
      if (modern) {
        const bodyMessages = messagesOf(bodyValue);
        const first = bodyMessages[0] || {};
        if (requestedVersion !== "2026-07-28") {
          await this.write(transport, response(400, JSON.stringify(headerMismatch(first.id, "protocol-version", "MCP-Protocol-Version must be 2026-07-28 for a modern request")), {
            ...common,
            "Content-Type": "application/json; charset=utf-8",
            "Mcp-Protocol-Version": "2026-07-28"
          }), output);
          return;
        }
        for (const message of bodyMessages) {
          const method = String(message?.method || "");
          if (!method) continue;
          if (String(headers["mcp-method"] || "") !== method) {
            await this.write(transport, response(400, JSON.stringify(headerMismatch(message.id, "method", `Mcp-Method must equal ${method}`)), {
              ...common,
              "Content-Type": "application/json; charset=utf-8",
              "Mcp-Protocol-Version": "2026-07-28"
            }), output);
            return;
          }
          const sourceField = Agent.mcpNameSourceField?.(method);
          const params = message?.params && typeof message.params === "object" ? message.params : {};
          const bodyName = sourceField ? params[sourceField] : undefined;
          const nameHeader = headers["mcp-name"];
          if (sourceField && typeof bodyName === "string" && bodyName) {
            if (!nameHeader) {
              await this.write(transport, response(400, JSON.stringify(headerMismatch(message.id, "name-header-missing", `Mcp-Name must equal params.${sourceField}`)), {
                ...common,
                "Content-Type": "application/json; charset=utf-8",
                "Mcp-Protocol-Version": "2026-07-28"
              }), output);
              return;
            }
            const decodedName = decodeMcpName(nameHeader);
            if (decodedName === undefined || decodedName !== bodyName) {
              await this.write(transport, response(400, JSON.stringify(headerMismatch(message.id, "name-header-mismatch", `Mcp-Name does not equal params.${sourceField}`)), {
                ...common,
                "Content-Type": "application/json; charset=utf-8",
                "Mcp-Protocol-Version": "2026-07-28"
              }), output);
              return;
            }
          }
        }
      }
      const result = await this.protocol.handleJSON(body, {
        sessionID,
        headers,
        era: modern ? "modern" : "legacy",
        protocolVersion: requestedVersion || "2025-11-25",
        requireSession: !modern && Boolean(headers["mcp-session-id"])
      });
      if (result == null) {
        await this.write(transport, response(202, "", common), output);
        return;
      }
      const text = JSON.stringify(result);
      let responseVersion = modern ? "2026-07-28" : requestedVersion || "2025-11-25";
      try {
        const first = Array.isArray(result) ? result[0] : result;
        responseVersion = String(first?.result?.protocolVersion || responseVersion);
      }
      catch (_) {}
      await this.write(transport, response(200, text, {
        ...common,
        "Content-Type": "application/json; charset=utf-8",
        "Mcp-Protocol-Version": responseVersion,
        ...(modern ? {} : (sessionID ? { "Mcp-Session-Id": sessionID } : {}))
      }), output);
    }
  }

  class AgentBackend {
    constructor(controller) {
      this.controller = controller;
      this.facade = new Agent.AgentFacade(controller);
      this.protocol = new Agent.MCPProtocol(this.facade);
      this.server = new MCPHTTPServer(this.protocol, controller);
      this.recentClients = new Map();
      this.protocol.onClientActivity = activity => this.recordClientActivity(activity);
      this.initialized = false;
    }

    recordClientActivity(activity = {}) {
      const name = String(activity.name || "unknown").trim() || "unknown";
      const version = String(activity.version || "").trim();
      const key = `${name}\u0000${version}`;
      const previous = this.recentClients.get(key) || { name, version, connectionCount: 0 };
      this.recentClients.set(key, {
        ...previous,
        name,
        version,
        protocolVersion: String(activity.protocolVersion || previous.protocolVersion || ""),
        lastSeen: String(activity.lastSeen || new Date().toISOString()),
        connectionCount: Number(previous.connectionCount || 0) + (activity.method === "initialize" || activity.method === "server/discover" ? 1 : 0)
      });
    }

    connectionSnapshot(developer = false) {
      if (!this.server.socket) return developer ? { connected: false, clientName: "", clientVersion: "", count: 0, clients: [] } : { connected: false, clientName: "", clientVersion: "", count: 0 };
      const now = Date.now();
      const recent = [...this.recentClients.values()]
        .filter(row => Number.isFinite(Date.parse(row.lastSeen)) && now - Date.parse(row.lastSeen) < 10 * 60 * 1000)
        .sort((left, right) => Date.parse(right.lastSeen) - Date.parse(left.lastSeen));
      const first = recent[0] || null;
      const snapshot = { connected: Boolean(first), clientName: first?.name || "", clientVersion: first?.version || "", count: recent.length };
      if (developer) snapshot.clients = recent;
      return snapshot;
    }

    async init() {
      await this.facade.init();
      this.initialized = true;
      if (this.facade.policy.settings().enabled) {
        try { await this.server.start(); }
        catch (error) { this.controller.log?.(`Agent endpoint 启动失败: ${error?.message || error}`); }
      }
    }

    async applySettings() {
      if (!this.initialized) return;
      if (this.facade.policy.settings().enabled) {
        if (!this.server.socket) {
          try { await this.server.start(); }
          catch (error) { this.controller.log?.(`Agent endpoint 启动失败: ${error?.message || error}`); }
        }
      }
      else this.server.stop();
    }

    settingsSnapshot() {
      const developer = this.facade.policy.settings().mode === "developer";
      return { ...this.facade.policy.capabilities(), server: this.server.status(), connection: this.connectionSnapshot(developer) };
    }

    async shutdown() {
      this.server.stop();
      await this.facade.shutdown();
      this.initialized = false;
    }
  }

  Agent.MCPHTTPServer = MCPHTTPServer;
  Agent.AgentBackend = AgentBackend;
})(this);
