(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const SERVER_NAME = "zotero-litmtrans";

  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return {}; }
  }

  function serverEntry(url, type = "") {
    const entry = { url: String(url || "") };
    if (type) entry.type = type;
    return entry;
  }

  const REGISTRY = Object.freeze({
    codex: { label: "Codex", kind: "cli", verificationStatus: "verified", command: endpoint => `codex mcp add ${SERVER_NAME} --url ${JSON.stringify(endpoint)}`, config: endpoint => ({ url: String(endpoint || "") }) },
    "claude-code": { label: "Claude Code", kind: "cli", verificationStatus: "verified", command: endpoint => `claude mcp add --transport http ${SERVER_NAME} ${String(endpoint || "")}`, config: endpoint => serverEntry(endpoint, "http") },
    "claude-desktop": { label: "Claude Desktop", kind: "json", verificationStatus: "template", config: endpoint => serverEntry(endpoint, "http") },
    cline: { label: "Cline", kind: "json", verificationStatus: "template", config: endpoint => serverEntry(endpoint, "streamableHttp") },
    continue: { label: "Continue", kind: "json", verificationStatus: "template", config: endpoint => serverEntry(endpoint, "streamable-http") },
    cursor: { label: "Cursor", kind: "json", verificationStatus: "verified", config: endpoint => serverEntry(endpoint) },
    "cherry-studio": { label: "Cherry Studio", kind: "json", verificationStatus: "template", config: endpoint => serverEntry(endpoint, "streamableHttp") },
    "gemini-cli": { label: "Gemini CLI", kind: "json", verificationStatus: "verified", config: endpoint => ({ httpUrl: String(endpoint || "") }) },
    chatbox: { label: "Chatbox", kind: "json", verificationStatus: "template", config: endpoint => serverEntry(endpoint, "streamable-http") },
    workbuddy: { label: "WorkBuddy", kind: "json", verificationStatus: "template", config: endpoint => serverEntry(endpoint, "http") },
    "trae-ai": { label: "Trae", kind: "json", verificationStatus: "template", config: endpoint => serverEntry(endpoint, "streamableHttp") },
    "qwen-code": { label: "Qwen Code", kind: "json", verificationStatus: "template", config: endpoint => serverEntry(endpoint, "streamable-http") },
    "custom-http": { label: "通用 HTTP 客户端", kind: "json", verificationStatus: "manual", config: endpoint => serverEntry(endpoint, "streamable-http") }
  });

  const ALIASES = {
    claude: "claude-code", claude_desktop: "claude-desktop", "claude-desktop": "claude-desktop",
    "cline-vscode": "cline", "continue-dev": "continue", cherry_studio: "cherry-studio",
    gemini: "gemini-cli", workbench: "custom-http", trae: "trae-ai", qwen: "qwen-code", generic: "custom-http"
  };

  function resolveClient(client) {
    const key = String(client || "custom-http").trim().toLowerCase();
    return REGISTRY[key] ? key : (ALIASES[key] || "custom-http");
  }

  function configFor(client, url) {
    const key = resolveClient(client);
    const spec = REGISTRY[key];
    const server = spec.config(String(url || ""));
    if (key === "codex") return { command: spec.command(String(url || "")), mcp_servers: { [SERVER_NAME]: server } };
    return { mcpServers: { [SERVER_NAME]: server } };
  }

  function mergeConfig(existing, client, url) {
    const base = clone(existing || {});
    const key = resolveClient(client);
    const incoming = configFor(key, url);
    const field = key === "codex" ? "mcp_servers" : "mcpServers";
    const servers = { ...(base[field] || {}) };
    if (servers.litmtrans?.url === String(url || "") || servers.litmtrans?.httpUrl === String(url || "")) delete servers.litmtrans;
    base[field] = { ...servers, [SERVER_NAME]: incoming[field][SERVER_NAME] };
    return base;
  }

  function descriptor(client, url) {
    const key = resolveClient(client);
    const spec = REGISTRY[key];
    const config = configFor(key, url);
    if (spec.kind === "cli") {
      return {
        format: "command",
        displayText: spec.command(String(url || "")),
        config,
        verificationStatus: spec.verificationStatus,
        instructions: key === "codex" ? "在终端执行命令，然后让 Codex 检查 litmtrans_get_capabilities。" : "在终端执行命令，然后让 Claude Code 检查 litmtrans_get_capabilities。"
      };
    }
    return {
      format: "json",
      displayText: JSON.stringify(config, null, 2),
      config,
      verificationStatus: spec.verificationStatus,
      instructions: `把 ${SERVER_NAME} 这一项合并到客户端的 MCP 配置中；若已有同一地址的 litmtrans 项，请将其改名，并保留其他服务。`
    };
  }

  Agent.ClientConfig = {
    registry: REGISTRY,
    aliases: ALIASES,
    resolveClient,
    configFor,
    descriptor,
    mergeConfig,
    serverEntry,
    clients: Object.keys(REGISTRY).map(id => ({ id, label: REGISTRY[id].label, kind: REGISTRY[id].kind, verificationStatus: REGISTRY[id].verificationStatus }))
  };
})(this);
