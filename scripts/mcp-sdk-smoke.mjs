import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sdkRoot = path.resolve(process.env.MCP_SDK_ROOT || path.join(projectRoot, "..", "inst proj", "mcp-typescript-sdk"));
const endpoint = String(process.env.LITMTRANS_MCP_URL || "").trim();
const modern = "2026-07-28";
const protocolMeta = {
  "io.modelcontextprotocol/protocolVersion": modern,
  "io.modelcontextprotocol/clientInfo": { name: "litmtrans-sdk-smoke", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } }
};

function encodeMcpName(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9._~-]+$/.test(text)) return text;
  return `=?base64?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

async function loadSDK() {
  const packageJSON = JSON.parse(await readFile(path.join(sdkRoot, "packages", "client", "package.json"), "utf8"));
  assert.equal(packageJSON.version, "2.0.0", "官方 MCP TypeScript SDK 必须是 v2");
  const entry = path.join(sdkRoot, "packages", "client", "dist", "index.mjs");
  return import(pathToFileURL(entry).href);
}

async function rawRequest(url, method, params, name = "", headerOptions = {}) {
  const body = { jsonrpc: "2.0", id: `raw-${Date.now()}-${Math.random()}`, method, params: { ...(params || {}), _meta: protocolMeta } };
  const requestHeaders = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": modern,
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": encodeMcpName(name) } : {})
  };
  if (headerOptions.protocolVersion === null) delete requestHeaders["MCP-Protocol-Version"];
  else if (typeof headerOptions.protocolVersion === "string") requestHeaders["MCP-Protocol-Version"] = headerOptions.protocolVersion;
  if (headerOptions.method === null) delete requestHeaders["Mcp-Method"];
  else if (typeof headerOptions.method === "string") requestHeaders["Mcp-Method"] = headerOptions.method;
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch (_) { value = { raw: text }; }
  return { response, value };
}

async function rawSocketRequest(url, requestText) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.hostname, port: Number(target.port || 80) });
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const buffer = Buffer.concat(chunks);
      const separator = buffer.indexOf(Buffer.from("\r\n\r\n"));
      const headerText = separator >= 0 ? buffer.subarray(0, separator).toString("latin1") : buffer.toString("latin1");
      const body = separator >= 0 ? buffer.subarray(separator + 4).toString("utf8") : "";
      const status = Number(headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] || 0);
      resolve({ status, headerText, body });
    };
    socket.on("connect", () => {
      socket.write(requestText, "utf8");
      socket.end();
    });
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", error => {
      if (!settled) reject(error);
    });
  });
}

async function runStubMRTR({ Client, StreamableHTTPClientTransport }) {
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const finish = result => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": modern
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    const meta = { "io.modelcontextprotocol/serverInfo": { name: "stub", version: "1" } };
    if (body.method === "server/discover") {
      finish({ resultType: "complete", supportedVersions: [modern], capabilities: { tools: {}, resources: {}, prompts: {} }, ttlMs: 0, cacheScope: "private", _meta: meta });
      return;
    }
    if (body.method === "tools/list") {
      finish({ resultType: "complete", tools: [{ name: "stub_approval", description: "stub", inputSchema: { type: "object", properties: {} } }], ttlMs: 0, cacheScope: "private", _meta: meta });
      return;
    }
    if (body.method === "tools/call") {
      calls += 1;
      if (body.params?.inputResponses?.externalService) {
        assert.equal(body.params.requestState, "opaque-stub-state");
        assert.equal(body.params.inputResponses.externalService.content.approved, true);
        finish({ resultType: "complete", content: [{ type: "text", text: "stub-success" }], structuredContent: { success: true }, isError: false, _meta: meta });
      }
      else {
        finish({ resultType: "input_required", inputRequests: { externalService: {
          method: "elicitation/create",
          params: { message: "approve", mode: "form", requestedSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] } }
        } }, requestState: "opaque-stub-state", _meta: meta });
      }
      return;
    }
    finish({ resultType: "complete", _meta: meta });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = new Client(
    { name: "litmtrans-sdk-mtrt-smoke", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: modern } }, inputRequired: { autoFulfill: true, maxRounds: 2 } }
  );
  client.setRequestHandler("elicitation/create", async request => {
    assert.equal(request.params.requestedSchema.properties.approved.type, "boolean");
    return { action: "accept", content: { approved: true } };
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    await client.listTools();
    const result = await client.callTool({ name: "stub_approval", arguments: {} });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.success, true);
    assert.equal(calls, 2, "MRTR 必须是首轮 input_required、二轮同一工具 retry");
    return { passed: true, calls };
  }
  finally {
    await client.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
}

async function runLive({ Client, StreamableHTTPClientTransport }) {
  if (!endpoint) throw new Error("请设置 LITMTRANS_MCP_URL 指向正在运行的隔离 Zotero Agent MCP endpoint");
  const documentID = String(process.env.MCP_MRTR_DOCUMENT_ID || "1-NTGWCZUH").trim();
  const approvalFile = String(process.env.LITMTRANS_APPROVAL_FILE || "").trim();
  const stubStateFile = String(process.env.LITMTRANS_STUB_STATE_FILE || "").trim();
  if (!approvalFile || !stubStateFile) throw new Error("真实 MRTR smoke 必须设置 LITMTRANS_APPROVAL_FILE 和 LITMTRANS_STUB_STATE_FILE");
  let elicitationCalls = 0;
  const client = new Client(
    { name: "litmtrans-official-sdk-smoke", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: modern } }, inputRequired: { autoFulfill: true, maxRounds: 2 } }
  );
  client.setRequestHandler("elicitation/create", async request => {
    elicitationCalls += 1;
    assert.equal(request.params.requestedSchema.properties.approved.type, "boolean");
    return { action: "accept", content: { approved: true } };
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  try {
    const discover = client.getDiscoverResult?.();
    assert.deepEqual(discover?.supportedVersions, [modern]);
    assert.equal(discover?.resultType, "complete");
    const tools = await client.listTools();
    assert(tools.tools.some(tool => tool.name === "litmtrans_get_capabilities"));
    const call = await client.callTool({ name: "litmtrans_get_capabilities", arguments: {} });
    assert.equal(call.isError, false);
    const resourceURI = String(process.env.MCP_RESOURCE_URI || "").trim();
    if (!resourceURI) throw new Error("请设置 MCP_RESOURCE_URI 为隔离测试库中可读的 litmtrans:// 资源 URI");
    const resource = await client.readResource({ uri: resourceURI });
    assert(resource.contents?.length > 0);

    const rawDiscover = await rawRequest(endpoint, "server/discover", {});
    assert.equal(rawDiscover.response.status, 200);
    assert.deepEqual(rawDiscover.value.result.supportedVersions, [modern]);
    assert.equal(rawDiscover.value.result.resultType, "complete");
    assert.equal(rawDiscover.value.result.serverInfo, undefined);
    assert(rawDiscover.value.result._meta["io.modelcontextprotocol/serverInfo"]);
    const rawList = await rawRequest(endpoint, "tools/list", {});
    assert.equal(rawList.value.result.resultType, "complete");
    const rawCall = await rawRequest(endpoint, "tools/call", { name: "litmtrans_get_capabilities", arguments: {} }, "litmtrans_get_capabilities");
    assert.equal(rawCall.value.result.resultType, "complete");
    const rawRead = await rawRequest(endpoint, "resources/read", { uri: resourceURI }, resourceURI);
    assert.equal(rawRead.value.result.resultType, "complete");
    const modelVersion = `mcp-sdk-mrtr-${Date.now()}`;
    const mrtr = await client.callTool({
      name: "litmtrans_start_parse",
      arguments: { documentID, force: true, modelVersion, enableTable: false, enableFormula: false }
    });
    assert.equal(mrtr.isError, false);
    const initialJob = mrtr.structuredContent || {};
    const jobID = String(initialJob.id || initialJob.jobID || "");
    assert(jobID, "MRTR 重试后必须返回已创建的 Job");
    let finalJob = initialJob;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (["completed", "failed", "cancelled", "interrupted"].includes(String(finalJob.status || ""))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
      const jobResult = await client.callTool({ name: "litmtrans_get_job", arguments: { jobID } });
      assert.equal(jobResult.isError, false);
      finalJob = jobResult.structuredContent || {};
    }
    assert.equal(finalJob.status, "completed", `MRTR 创建的 Job 未完成：${JSON.stringify(finalJob)}`);
    assert.equal(elicitationCalls, 1, "真实 MRTR 必须只触发一次 elicitation/create");
    const approvals = JSON.parse(await readFile(approvalFile, "utf8"));
    const approvedRow = (Array.isArray(approvals) ? approvals : []).find(row => (
      row?.status === "approved"
      && row?.plan?.operation === "parse"
      && row?.plan?.model === modelVersion
      && row?.plan?.documentIDs?.includes(documentID)
    ));
    assert(approvedRow, "requestState 消费后必须存在对应的 approved 审批行");
    const stubState = JSON.parse(await readFile(stubStateFile, "utf8"));
    assert.equal(stubState.lastRun, modelVersion);
    assert(Number(stubState.parseCalls) >= 1);
    assert.equal(Number(stubState.networkCalls), 0, "隔离 MinerU stub 不应产生外部网络调用");
    const mismatch = await rawRequest(endpoint, "tools/call", { name: "litmtrans_get_capabilities", arguments: {} }, "wrong-name");
    assert.equal(mismatch.response.status, 400);
    assert.equal(mismatch.value.error.code, -32020);
    assert.equal(mismatch.value.error.message, "HeaderMismatch");
    const missingVersion = await rawRequest(endpoint, "server/discover", {}, "", { protocolVersion: null });
    assert.equal(missingVersion.response.status, 400);
    assert.equal(missingVersion.value.error.code, -32020);
    const mismatchMethod = await rawRequest(endpoint, "tools/list", {}, "", { method: "tools/call" });
    assert.equal(mismatchMethod.response.status, 400);
    assert.equal(mismatchMethod.value.error.code, -32020);
    assert.equal(mismatchMethod.value.error.message, "HeaderMismatch");
    const socketTarget = new URL(endpoint);
    const socketPath = `${socketTarget.pathname}${socketTarget.search}`;
    const chunked = await rawSocketRequest(endpoint, [
      `POST ${socketPath} HTTP/1.1`,
      `Host: ${socketTarget.host}`,
      "Connection: close",
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "",
      "2",
      "{}",
      "0",
      "",
      ""
    ].join("\r\n"));
    assert.equal(chunked.status, 411);
    assert(chunked.body.includes("Chunked request bodies are not supported"));
    const unframed = await rawSocketRequest(endpoint, [
      `POST ${socketPath} HTTP/1.1`,
      `Host: ${socketTarget.host}`,
      "Connection: close",
      "Content-Type: application/json",
      "",
      "{}"
    ].join("\r\n"));
    assert.equal(unframed.status, 411);
    assert(unframed.body.includes("Content-Length is required for POST request bodies"));
    assert.equal(rawDiscover.response.headers.get("mcp-session-id"), null);
    return {
      passed: true,
      toolCount: tools.tools.length,
      resourceURI,
      headerChecks: true,
      framingChecks: true,
      mrtr: { passed: true, jobID, approvalStatus: approvedRow.status, elicitationCalls, stubNetworkCalls: Number(stubState.networkCalls) }
    };
  }
  finally {
    await client.close().catch(() => {});
  }
}

const sdk = await loadSDK();
const stub = await runStubMRTR(sdk);
const live = process.env.MCP_SDK_SMOKE_STUB_ONLY === "1" ? { skipped: true } : await runLive(sdk);
console.log(JSON.stringify({ sdk: "@modelcontextprotocol/client@2.0.0", stubMRTR: stub, live }, null, 2));
