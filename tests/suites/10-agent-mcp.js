"use strict";

module.exports = function createSuite(env) {
  const { assert, context, MemoryStorage, prefValues } = env;
  const Agent = context.LitMTrans.Agent;

  function testContractsAndPolicy() {
    const secret = Agent.Contracts.redact({ apiKey: "secret", nested: { mineruToken: "token", value: 1 } });
    assert.equal(secret.apiKey, "[REDACTED]");
    assert.equal(secret.nested.mineruToken, "[REDACTED]");
    context.LitMTrans.Utils.setPref("agentAccessMode", "read");
    context.LitMTrans.Utils.setPref("agentAllowChatHistory", true);
    const policy = new Agent.CapabilityPolicy({});
    assert.equal(policy.can("library-read"), true);
    assert.equal(policy.can("library-write"), false);
    assert.throws(() => policy.assert("library-write"), /只读/);
    context.LitMTrans.Utils.setPref("agentAccessMode", "full");
    assert.equal(policy.can("library-write"), true);
    return true;
  }

  async function testProtocolHandshakeAndToolContract() {
    const facade = {
      controller: { version: "2.0.0" },
      capabilities: async () => ({ instructions: ["use jobs"], permissions: {}, settings: {} }),
      invoke: async (name, args) => ({ name, args, ok: true }),
      readResource: async uri => ({ uri, mimeType: "text/plain", text: "resource" }),
      tasks: { cancel() {} }
    };
    const protocol = new Agent.MCPProtocol(facade);
    const initialize = await protocol.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, { sessionID: "test-session" });
    assert.equal(initialize.result.serverInfo.name, "zotero-litmtrans");
    assert.equal(initialize.result.protocolVersion, "2024-11-05");
    const list = await protocol.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert(list.result.tools.length >= 40);
    assert(list.result.tools.every(tool => tool.name.startsWith("litmtrans_")));
    const call = await protocol.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "litmtrans_get_capabilities", arguments: {} } });
    assert.equal(call.result.isError, false);
    assert(call.result.content.some(block => block.type === "text" && block.text.includes("litmtrans_get_capabilities")));
    const resource = await protocol.handle({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "litmtrans://paper/1-A/source" } });
    assert.equal(resource.result.contents[0].uri, "litmtrans://paper/1-A/source");
  }

  async function testExtendedToolsetsAndResponseRedaction() {
    const names = new Set(Agent.MCPTools.map(tool => tool.name));
    for (const name of ["litmtrans_render_page", "litmtrans_update_annotation", "litmtrans_generate_citation", "litmtrans_add_by_bibtex", "litmtrans_read_litmtrans_file"]) {
      assert(names.has(name), `missing tool ${name}`);
    }
    const facade = {
      controller: { version: "2.0.0" },
      capabilities: async () => ({ instructions: [], permissions: {}, settings: {} }),
      invoke: async () => ({ apiKey: "secret", nested: { mineruToken: "token" } }),
      tasks: { cancel() {} }
    };
    const protocol = new Agent.MCPProtocol(facade);
    const response = await protocol.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "litmtrans_get_capabilities", arguments: {} } });
    assert(response.result.content[0].text.includes("[REDACTED]"));
    assert(!response.result.content[0].text.includes("secret"));
  }

  function testImportAndCitationHelpers() {
    const parsed = Agent.ImportHelpers.parseBibTeX("@article{smith2025, title={A Paper}, author={Smith, Alice and Doe, Bob}, year={2025}, doi={10.1000/test}}");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].fields.doi, "10.1000/test");
    assert.equal(Agent.ImportHelpers.normalizeDOI("https://doi.org/10.1000/test."), "10.1000/test");
    const facade = Object.create(Agent.AgentFacade.prototype);
    assert.deepEqual(facade.citationRefs({ itemKey: "KEY1" }), ["KEY1"]);
    assert.deepEqual(facade.citationRefs({ itemID: 123 }), [123]);
    assert.deepEqual(facade.citationRefs({ documentID: "1-ABCD" }), ["1-ABCD"]);
    assert.deepEqual(facade.citationRefs({ items: ["A", "B"] }), ["A", "B"]);
  }

  async function testTaskPersistenceAndCancellation() {
    const storage = new MemoryStorage();
    storage.root = "/mem/litmtrans";
    const manager = new Agent.AgentTaskManager(storage);
    await manager.init();
    const job = manager.start("test", { value: 1 }, async ({ emit }) => {
      emit({ type: "progress", phase: "test", progress: 50, message: "half" });
      return { value: 2, apiKey: "must-not-leak" };
    });
    for (let i = 0; i < 30 && manager.raw(job.id)?.status !== "completed"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(manager.raw(job.id).status, "completed");
    assert.equal(manager.get(job.id).result.apiKey, "[REDACTED]");
    const slow = manager.start("slow", {}, async ({ signal }) => {
      while (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error("cancelled");
    });
    manager.cancel(slow.id);
    for (let i = 0; i < 30 && !["cancelled", "failed"].includes(manager.raw(slow.id)?.status); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(manager.raw(slow.id).status, "cancelled");
  }

  function testClientCoexistence() {
    const existing = { mcpServers: { "zotero-mcp": { command: "existing" }, other: { url: "http://other" } }, preferences: { keep: true } };
    const merged = Agent.ClientConfig.mergeConfig(existing, "claude-code", "http://127.0.0.1:1234/litmtrans/mcp");
    assert.deepEqual(merged.mcpServers["zotero-mcp"], existing.mcpServers["zotero-mcp"]);
    assert.deepEqual(merged.mcpServers.other, existing.mcpServers.other);
    assert.equal(merged.mcpServers["zotero-litmtrans"].url, "http://127.0.0.1:1234/litmtrans/mcp");
    assert.deepEqual(merged.preferences, existing.preferences);
    const migrated = Agent.ClientConfig.mergeConfig({ mcpServers: { litmtrans: { url: "http://127.0.0.1:1234/litmtrans/mcp" }, other: { url: "http://other" } } }, "cursor", "http://127.0.0.1:1234/litmtrans/mcp");
    assert.equal(migrated.mcpServers.litmtrans, undefined);
    assert.equal(migrated.mcpServers["zotero-litmtrans"].url, "http://127.0.0.1:1234/litmtrans/mcp");
    assert.equal(migrated.mcpServers.other.url, "http://other");
    const command = Agent.ClientConfig.descriptor("codex", "http://127.0.0.1:1234/litmtrans/mcp");
    assert.equal(command.format, "command");
    assert.equal(command.verificationStatus, "verified");
    assert.equal(command.displayText, "codex mcp add zotero-litmtrans --url \"http://127.0.0.1:1234/litmtrans/mcp\"");
    assert(command.config.command.includes("codex mcp add zotero-litmtrans"));
    for (const [client, type, verificationStatus] of [["claude-desktop", "http", "template"], ["cline", "streamableHttp", "template"], ["cursor", "", "verified"], ["workbuddy", "http", "template"], ["trae", "streamableHttp", "template"]]) {
      const descriptor = Agent.ClientConfig.descriptor(client, "http://127.0.0.1:1234/litmtrans/mcp");
      assert.equal(descriptor.format, "json");
      assert.equal(descriptor.verificationStatus, verificationStatus);
      assert.equal(descriptor.config.mcpServers["zotero-litmtrans"].url, "http://127.0.0.1:1234/litmtrans/mcp");
      assert.equal(descriptor.config.mcpServers["zotero-litmtrans"].type || "", type);
    }
    assert.equal(Agent.ClientConfig.descriptor("claude-code", "http://127.0.0.1:1234/litmtrans/mcp").format, "command");
    assert(Agent.ClientConfig.descriptor("claude-code", "http://127.0.0.1:1234/litmtrans/mcp").displayText.includes("--transport http zotero-litmtrans"));
    const gemini = Agent.ClientConfig.descriptor("gemini-cli", "http://127.0.0.1:1234/litmtrans/mcp");
    assert.equal(gemini.config.mcpServers["zotero-litmtrans"].httpUrl, "http://127.0.0.1:1234/litmtrans/mcp");
    assert.equal(Agent.ClientConfig.descriptor("generic", "http://127.0.0.1:1234/litmtrans/mcp").verificationStatus, "manual");
  }

  async function testMcpPortFallback() {
    const originalCc = context.Cc;
    const originalCi = context.Ci;
    const originalPort = context.LitMTrans.Utils.getPref("agentPort", null);
    const attempts = [];
    let closed = 0;
    context.Ci = { nsIServerSocket: function nsIServerSocket() {} };
    context.Cc = {
      "@mozilla.org/network/server-socket;1": {
        createInstance() {
          return {
            init(port) {
              attempts.push(port);
              if (port === 45123) throw new Error("occupied");
              this.port = 45124;
            },
            asyncListen(listener) { this.listener = listener; },
            close() { closed += 1; }
          };
        }
      }
    };
    context.LitMTrans.Utils.setPref("agentPort", 45123);
    try {
      const server = new Agent.MCPHTTPServer({}, {});
      const status = await server.start({ port: 45123 });
      assert.deepEqual(attempts, [45123, 0]);
      assert.equal(status.port, 45124);
      assert.equal(context.LitMTrans.Utils.getPref("agentPort", 0), 45124);
      server.stop();
      assert.equal(closed, 2);
    }
    finally {
      context.Cc = originalCc;
      context.Ci = originalCi;
      if (originalPort === null) context.LitMTrans.Utils.clearPref("agentPort");
      else context.LitMTrans.Utils.setPref("agentPort", originalPort);
    }
  }

  async function testModernLegacyProtocolAndApproval() {
    const storage = new MemoryStorage();
    storage.root = "/mem/litmtrans-protocol";
    const approvals = new Agent.ExternalApprovalService(storage);
    await approvals.init();
    let approvedCall = false;
    const facade = {
      controller: { version: "2.0.0" },
      capabilities: async () => ({ instructions: ["approval"], permissions: {}, settings: {} }),
      visibleTools: () => Agent.MCPTools.filter(tool => tool.name === "litmtrans_get_capabilities"),
      approvals,
      invoke: async (name, args) => {
        if (args.approved === true) {
          approvedCall = true;
          return { name, args, completed: true };
        }
        let pending;
        try {
          const checked = await approvals.ensure({ services: ["MinerU"], provider: "MinerU", model: "vlm", documentCount: 1, operation: "parse", allowedOperations: ["parse"], documentIDs: ["1-A"] });
          return { name, approvedByStore: checked.approved };
        }
        catch (error) { pending = error; }
        throw pending;
      },
      tasks: { cancel() {} }
    };
    const protocol = new Agent.MCPProtocol(facade);
    const discover = await protocol.handle({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test" },
      "io.modelcontextprotocol/clientCapabilities": {}
    } } }, { era: "modern" });
    assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
    assert.equal(discover.result.protocolVersions, undefined);
    assert.equal(discover.result.protocolVersion, undefined);
    assert.equal(discover.result.serverInfo, undefined);
    assert.deepEqual(discover.result._meta["io.modelcontextprotocol/serverInfo"], { name: "zotero-litmtrans", version: "2.0.0" });
    assert.equal(discover.result.resultType, "complete");
    const modernInitialize = await protocol.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { era: "modern" });
    assert.equal(modernInitialize.error.code, -32601);
    const modernPing = await protocol.handle({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }, { era: "modern" });
    assert.equal(modernPing.error.code, -32601);
    const modernLogging = await protocol.handle({ jsonrpc: "2.0", id: 4, method: "logging/setLevel", params: {} }, { era: "modern" });
    assert.equal(modernLogging.error.code, -32601);
    const legacyInitialize = await protocol.handle({ jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "2025-11-25" } }, { sessionID: "legacy-test" });
    assert.equal(legacyInitialize.result.protocolVersion, "2025-11-25");
    const modernApproval = await protocol.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "litmtrans_get_capabilities", arguments: {} } }, { era: "modern" });
    assert.equal(modernApproval.result.resultType, "input_required");
    const schema = modernApproval.result.inputRequests.externalService.params.requestedSchema;
    assert.deepEqual(Object.keys(schema.properties), ["approved"]);
    assert.deepEqual(schema.required, ["approved"]);
    assert.equal(modernApproval.result.inputRequests.externalService.params.approvalID, undefined);
    assert.equal(modernApproval.result.inputRequests.externalService.params.planHash, undefined);
    assert(modernApproval.result.requestState);
    const retry = await protocol.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "litmtrans_get_capabilities",
      arguments: {},
      requestState: modernApproval.result.requestState,
      inputResponses: { externalService: { action: "accept", content: { approved: true } } }
    } }, { era: "modern" });
    assert.equal(retry.result.resultType, "complete");
    assert.equal(retry.result.isError, false);
    assert.equal(approvedCall, true);
    const legacyProtocol = new Agent.MCPProtocol({
      controller: { version: "2.0.0" },
      invoke: async () => { throw new Agent.Contracts.AgentError("EXTERNAL_SERVICE_APPROVAL_REQUIRED", "需要确认", { details: { approvalID: "legacy", planHash: "legacy" } }); },
      tasks: { cancel() {} }
    });
    const legacyApproval = await legacyProtocol.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "litmtrans_get_capabilities", arguments: {} } });
    assert.equal(legacyApproval.result.isError, true);
    assert.equal(legacyApproval.result.structuredContent.code, "EXTERNAL_SERVICE_APPROVAL_REQUIRED");
  }

  async function testApprovalPersistenceAndBackgroundProfile() {
    const storage = new MemoryStorage();
    storage.root = "/mem/litmtrans";
    const approvals = new Agent.ExternalApprovalService(storage);
    await approvals.init();
    let pending;
    try { await approvals.ensure({ services: ["MinerU"], provider: "MinerU", model: "vlm", documentCount: 20, operation: "batch", allowedOperations: ["batch", "parse"] }); }
    catch (error) { pending = error; }
    assert.equal(pending.code, "EXTERNAL_SERVICE_APPROVAL_REQUIRED");
    const approved = await approvals.approve(pending.details.approvalID, { approved: true, planHash: pending.details.planHash });
    assert.equal(approved.approved, true);
    const inherited = await approvals.ensure({ services: ["MinerU"], provider: "MinerU", model: "vlm", documentCount: 1, operation: "parse" }, { approvalID: approved.approvalID, approved: true });
    assert.equal(inherited.inherited, true);

    context.LitMTrans.Utils.setPref("agentBackgroundProvider", "auto");
    const chatEnginePref = "extensions.litmtrans.chatEngine";
    const previousChatEngine = prefValues.get(chatEnginePref);
    prefValues.set(chatEnginePref, "deepseek_web");
    const controller = {
      tabs: new Map([["tab", { deepSeekBrowser: {}, deepSeekDriver: {} }]]),
      llm: { getStoredSettings: purpose => ({ purpose, provider: "deepseek_web", providerProfiles: { openai_compatible: { baseURL: "https://api.example.test/v1", model: "gpt-test" } } }) },
      secrets: { getLLMKey: provider => provider === "openai_compatible" ? "configured" : "" }
    };
    try {
      const profile = Agent.resolveBackgroundAIProfile(controller, "translation");
      assert.equal(profile.provider, "openai_compatible");
      assert.equal(profile.mode, "api");
      assert.equal(profile.webBackgroundAllowed, false);
      assert.equal(profile.deepSeekWebRuntimeLoaded, true);
      assert.equal(Agent.publicBackgroundAIProfile(profile).apiKey, undefined);
    }
    finally {
      if (previousChatEngine === undefined) prefValues.delete(chatEnginePref);
      else prefValues.set(chatEnginePref, previousChatEngine);
    }
  }

  async function testBackgroundChatUsesAPIWhileWorkbenchUsesWeb() {
    const chatEnginePref = "extensions.litmtrans.chatEngine";
    const previousChatEngine = prefValues.get(chatEnginePref);
    prefValues.set(chatEnginePref, "deepseek_web");
    context.LitMTrans.Utils.setPref("agentBackgroundProvider", "auto");
    let sentOptions = null;
    const translationOptions = [];
    const facade = {
      ensureExternalApproval: async () => {},
      contextRef: () => "1-A",
      artifact: {
        resolve: async () => ({ context: { documentID: "1-A" } }),
        getManifest: async () => ({ documentID: "1-A" })
      },
      controller: {
        llm: { getStoredSettings: () => ({ provider: "openai_compatible", baseURL: "https://api.example.test/v1", model: "gpt-test" }) },
        secrets: { getLLMKey: () => "api-secret" },
        chat: { send: async (_documentID, _sessionID, _message, options) => { sentOptions = options; } },
        pipeline: {
          translateStream: async (_context, options) => { translationOptions.push(options); },
          translateLayout: async (_context, options) => { translationOptions.push(options); }
        }
      },
      corpus: { markStale() {} },
      literature: { updateDocumentStatus: async () => {} }
    };
    try {
      const runner = Agent.AgentFacade.prototype.processingRunner.call(facade, "chat", {
        ref: "1-A", message: "question", skipApproval: true
      });
      await runner({ signal: null, emit() {} });
      assert.equal(sentOptions.engine, "api");
      assert.equal(sentOptions.aiMode, "api");
      assert.equal(sentOptions.provider, "openai_compatible");
      assert.equal(sentOptions.forceAPI, true);
      assert.equal(sentOptions.agentExternal, true);
      for (const kind of ["stream_translation", "layout_translation"]) {
        const translate = Agent.AgentFacade.prototype.processingRunner.call(facade, kind, {
          ref: "1-A", skipApproval: true
        });
        await translate({ signal: null, emit() {} });
      }
      assert.equal(translationOptions.length, 2);
      assert(translationOptions.every(options => options.engine === "api" && options.aiMode === "api"));
      assert.equal(prefValues.get(chatEnginePref), "deepseek_web");
      assert.equal(context.LitMTrans.ControllerInternals.webEngineSelected({ engine: "api", aiMode: "api" }), true);
      assert.equal(context.LitMTrans.ControllerInternals.webEngineSelected(sentOptions), false);
    }
    finally {
      if (previousChatEngine === undefined) prefValues.delete(chatEnginePref);
      else prefValues.set(chatEnginePref, previousChatEngine);
    }
  }

  async function testBoundedPoolAndParentCancellation() {
    let active = 0;
    let maximum = 0;
    const rows = await Agent.AgentFacade.prototype.runPool.call({}, [1, 2, 3, 4, 5], 2, async value => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 4));
      active -= 1;
      return value * 2;
    });
    assert.deepEqual(rows, [2, 4, 6, 8, 10]);
    assert(maximum <= 2, "parse/translation pool must stay bounded");

    const storage = new MemoryStorage();
    storage.root = "/mem/litmtrans";
    const manager = new Agent.AgentTaskManager(storage);
    await manager.init();
    const parent = manager.start("parent", {}, async ({ signal }) => {
      while (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 3));
      throw new Error("cancelled");
    });
    const child = manager.start("child", {}, async ({ signal }) => {
      while (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 3));
      throw new Error("cancelled");
    }, { parentJobID: parent.id });
    manager.cancel(parent.id);
    for (let i = 0; i < 40 && manager.raw(child.id)?.status !== "cancelled"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(manager.raw(child.id).status, "cancelled");
  }

  async function testApprovalScopeAndBatchCounts() {
    const storage = new MemoryStorage();
    storage.root = "/mem/litmtrans-approval-scope";
    const approvals = new Agent.ExternalApprovalService(storage);
    await approvals.init();
    const parentPlan = {
      services: ["MinerU", "openai_compatible"],
      providers: ["MinerU", "openai_compatible"],
      models: ["vlm", "gpt-test"],
      serviceCounts: { MinerU: 2, openai_compatible: 2 },
      parseCount: 2,
      translateCount: 2,
      provider: "mixed",
      model: "mixed",
      operation: "batch",
      allowedOperations: ["batch", "parse", "stream_translation"],
      documentIDs: ["1-A", "1-B"],
      documentCount: 2
    };
    let required;
    try { await approvals.ensure(parentPlan); }
    catch (error) { required = error; }
    assert.equal(required.code, "EXTERNAL_SERVICE_APPROVAL_REQUIRED");
    assert.deepEqual(required.details.plan.documentIDs, ["1-A", "1-B"]);
    assert.equal(required.details.plan.documentCount, 2);
    assert.deepEqual(required.details.plan.serviceCounts, { MinerU: 2, openai_compatible: 2 });
    const approved = await approvals.approve(required.details.approvalID, { approved: true, planHash: required.details.planHash });
    const child = await approvals.ensure({
      services: ["openai_compatible"], provider: "openai_compatible", model: "gpt-test",
      operation: "stream_translation", allowedOperations: ["stream_translation"],
      serviceCounts: { openai_compatible: 1 }, translateCount: 1, documentIDs: ["1-A"]
    }, { approvalID: approved.approvalID, approved: true });
    assert.equal(child.inherited, true);
    let crossPaper;
    try {
      await approvals.ensure({
        services: ["openai_compatible"], provider: "openai_compatible", model: "gpt-test",
        operation: "stream_translation", allowedOperations: ["stream_translation"],
        serviceCounts: { openai_compatible: 1 }, translateCount: 1, documentIDs: ["1-C"]
      }, { approvalID: approved.approvalID, approved: true });
    }
    catch (error) { crossPaper = error; }
    assert.equal(crossPaper.code, "EXTERNAL_SERVICE_APPROVAL_REQUIRED");
    const normalized = Agent.normalizeExternalPlan({ documentIDs: ["1-A", "1-B"], documentCount: 99, services: ["MinerU"] });
    assert.equal(normalized.documentCount, 2);
  }

  async function testDiagramCacheBidirectionalContract() {
    const storage = new MemoryStorage();
    storage.root = "/mem/litmtrans-diagram";
    await storage.writeText("/mem/1-A/full.cleaned.md", "source text");
    const controller = { storage };
    const artifact = new Agent.ArtifactService(controller, {});
    artifact.resolve = async () => ({ context: { documentID: "1-A" }, snapshot: { parsed: { markdown: "source text" } } });
    const diagram = { nodes: [{ id: "root", label: "Root", evidence: [] }], root: { id: "root", label: "Root", parentId: null, children: [] } };
    const saved = await artifact.saveDiagram("1-A", "mindmap", diagram, { title: "Shared" });
    assert.equal(saved.file, "paper_mindmap.json");
    assert.equal(saved.taskType, "paper_mindmap");
    assert.equal(saved.version, 2);
    const workbenchRead = Agent.DiagramCache.normalize(await storage.readJSON("/mem/1-A/diagrams/paper_mindmap.json", null), "paper_mindmap", "mindmap");
    assert.equal(workbenchRead.file, saved.file);
    assert.equal(workbenchRead.sourceFingerprint, saved.sourceFingerprint);
    const agentRead = await artifact.readDiagram("1-A", "mindmap", {});
    assert.deepEqual(agentRead.diagram, diagram);
    const flow = { nodes: [{ id: "start", label: "Start" }, { id: "end", label: "End" }], edges: [{ from: "start", to: "end" }] };
    const flowPayload = Agent.DiagramCache.build({ taskType: "paper_logic_flow", mode: "flowchart", title: "Flow", sourceFingerprint: saved.sourceFingerprint, diagram: flow });
    await storage.writeJSON("/mem/1-A/diagrams/paper_logic_flow.json", flowPayload);
    const flowRead = await artifact.readDiagram("1-A", "flowchart", {});
    assert.equal(flowRead.file, "paper_logic_flow.json");
  }

  async function testExportPolicyAndCollectionPagination() {
    const storage = new MemoryStorage();
    storage.root = "/mem/litmtrans-export";
    let chatReads = 0;
    const resolved = { context: { documentID: "1-A", title: "Paper" }, item: { key: "ITEM" }, attachment: { key: "ATT" }, snapshot: { parsed: {}, translation: {}, layout: { model: null } } };
    const artifact = {
      snapshot: async () => resolved,
      manifestFromSnapshot: async () => ({ documentID: "1-A", parsed: true }),
      blockRows: () => [],
      listFigures: async () => ({ figures: [] }),
      listTables: async () => ({ tables: [] }),
      listFormulas: async () => ({ formulas: [] })
    };
    const controller = { storage, chat: { listSessions: async () => { chatReads += 1; return [{ id: "should-not-read" }]; } } };
    const library = new Agent.LibraryService(controller);
    const exporter = new Agent.ExportService(controller, artifact, library);
    await exporter.init();
    const bundle = await exporter.bundle("1-A", { destination: "/mem/litmtrans-export/out", allowChatHistory: false });
    const marker = await storage.readJSON(`${bundle.outputPath}/chat/index.json`, null);
    assert.equal(marker.omitted, true);
    assert.equal(chatReads, 0);

    library.getCollectionItems = async (_ref, options = {}) => {
      const offset = Number(options.offset || 0);
      const limit = Number(options.limit || 100);
      const total = 450;
      const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({ key: `ITEM-${offset + index}`, attachmentKey: `ATT-${offset + index}`, title: `Paper ${offset + index}` }));
      return { collection: { name: "Large", path: "Large" }, total, offset, limit, nextOffset: offset + items.length < total ? offset + items.length : null, items };
    };
    const listing = await library.collectAllCollectionItems("large", { pageSize: 100, includeStatus: false });
    assert.equal(listing.items.length, 450);
    exporter.bundle = async (ref, options) => ({ outputPath: options.destination, documentID: String(ref) });
    const workspace = await exporter.collectionWorkspace({ collection: "large", destination: "/mem/litmtrans-export/workspace", pageSize: 100 });
    assert.equal(workspace.index.papers.length, 450);
  }

  async function testChatEditRouting() {
    const calls = [];
    const base = {
      policy: { assert() {} },
      artifact: { resolve: async () => ({ context: { documentID: "1-A" } }) },
      controller: {
        chat: {
          loadSession: async () => ({ id: "session", messages: [{ id: "assistant-1", role: "assistant", content: "old" }] }),
          editMessage: async (...args) => { calls.push(args); return { ok: true }; }
        }
      },
      ensureExternalApproval: async () => { throw new Error("assistant edit must not approve"); }
    };
    await Agent.AgentFacade.prototype.editChatMessage.call(base, "1-A", "session", "assistant-1", "local edit", {});
    assert.equal(calls.length, 1);

    const userBase = {
      ...base,
      controller: {
        llm: { getStoredSettings: () => ({ provider: "openai_compatible", baseURL: "https://api.example.test/v1", model: "gpt-test" }) },
        secrets: { getLLMKey: () => "api-secret" },
        chat: { loadSession: async () => ({ id: "web-document-chat", messages: [{ id: "user-1", role: "user", content: "old" }] }), editMessage: async (...args) => { calls.push(args); return { ok: true }; } }
      },
      ensureExternalApproval: async () => ({ approvalID: "approved", approved: true })
    };
    await Agent.AgentFacade.prototype.editChatMessage.call(userBase, "1-A", "web-document-chat", "user-1", "api edit", {});
    const options = calls.at(-1)[4];
    assert.equal(options.engine, "api");
    assert.equal(options.aiMode, "api");
    assert.equal(options.provider, "openai_compatible");
    assert.equal(options.baseURL, "https://api.example.test/v1");
    assert.equal(options.model, "gpt-test");
    assert.equal(options.apiKey, "api-secret");
    assert.equal(options.forceAPI, true);
    assert.equal(options.agentExternal, true);
  }

  async function testBatchResolverAfterRestart() {
    const storage = new MemoryStorage();
    storage.root = "/mem/litmtrans-batch";
    const facade = new Agent.AgentFacade({ storage, version: "2.0.0", getSettings: () => ({}) });
    await facade.init();
    assert.equal(facade.tasks.resolvers.has("batch"), true);
    facade.startBatchRunner = () => async () => ({ restarted: true });
    const old = facade.tasks.start("batch", { collection: "restart" }, async () => { throw new Error("interrupted"); });
    for (let i = 0; i < 40 && facade.tasks.raw(old.id)?.status !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    facade.tasks.raw(old.id).status = "interrupted";
    const retried = facade.tasks.retry(old.id);
    for (let i = 0; i < 40 && facade.tasks.raw(retried.id)?.status !== "completed"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(facade.tasks.raw(retried.id).status, "completed");
    await facade.shutdown();
  }

  async function testHttpReaderContract() {
    const readerFor = (bytes, chunkSize = bytes.length) => {
      let offset = 0;
      return {
        available: () => Math.min(chunkSize, bytes.length - offset),
        readBytes: count => {
          const end = Math.min(bytes.length, offset + Math.min(chunkSize, count));
          const part = bytes.slice(offset, end);
          offset = end;
          return part;
        }
      };
    };
    const requestFor = body => {
      const text = String(body);
      const bodyBytes = new TextEncoder().encode(text);
      const head = new TextEncoder().encode(`POST /litmtrans/mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${bodyBytes.length}\r\n\r\n`);
      return Uint8Array.from([...head, ...bodyBytes]);
    };
    const ascii = await Agent.MCPHttpRequestReader.readHttpRequest(readerFor(requestFor("hello"), 2), { waitMs: 0 });
    assert.equal(ascii.complete, true);
    assert.equal(ascii.body, "hello");
    const chinese = JSON.stringify({ text: "中文与 emoji 😀" });
    const split = await Agent.MCPHttpRequestReader.readHttpRequest(readerFor(requestFor(chinese), 1), { waitMs: 0 });
    assert.equal(split.body, chinese);
    const truncated = await Agent.MCPHttpRequestReader.readHttpRequest(readerFor(new TextEncoder().encode("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 10\r\n\r\nabc"), 4), { waitMs: 0, maxWaitAttempts: 1 });
    assert.equal(truncated.complete, false);
    assert.equal(truncated.incompleteReason, "body-truncated");
    const oversized = await Agent.MCPHttpRequestReader.readHttpRequest(readerFor(new Uint8Array(80).fill(65), 80), { maxRequestSize: 16, waitMs: 0 });
    assert.equal(oversized.status, 413);
    const missingLength = await Agent.MCPHttpRequestReader.readHttpRequest(readerFor(new TextEncoder().encode("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n{}")), { waitMs: 0 });
    assert.equal(missingLength.status, 411);
    const chunked = await Agent.MCPHttpRequestReader.readHttpRequest(readerFor(new TextEncoder().encode("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n0\r\n\r\n")), { waitMs: 0 });
    assert.equal(chunked.status, 411);
  }

  async function testWriteCoordinatorAndFormatters() {
    const coordinator = new Agent.ZoteroWriteCoordinator({ maxForegroundWaitMs: 1000 });
    const order = [];
    const first = coordinator.enqueue("first", async () => { order.push("first-start"); await new Promise(resolve => setTimeout(resolve, 3)); order.push("first-end"); });
    const second = coordinator.enqueue("second", async () => { order.push("second"); });
    await Promise.all([first, second]);
    await coordinator.flush(1000);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
    await assert.rejects(() => coordinator.enqueue("failure", async () => { throw new Error("expected"); }));
    await coordinator.enqueue("after-failure", async () => { order.push("after-failure"); });
    assert.equal(coordinator.getPendingCount(), 0);

    const previousNotifierZotero = context.Zotero;
    const notifierEvents = [];
    context.Zotero = {
      Notifier: {
        Queue: class { constructor() { this.delay = 0; } },
        commit: async queue => {
          const delay = Number(queue?.delay || 0);
          await new Promise(resolve => setTimeout(resolve, delay));
          notifierEvents.push("commit");
        }
      }
    };
    try {
      const dbCoordinator = new Agent.ZoteroWriteCoordinator({ maxForegroundWaitMs: 25 });
      const slowDB = { saveTx: async options => { options.notifierQueue.delay = 0; await new Promise(resolve => setTimeout(resolve, 70)); } };
      const started = Date.now();
      await dbCoordinator.saveEntity(slowDB, { label: "slow-db" });
      assert(Date.now() - started >= 60, "saveEntity must wait for saveTx, not the notifier timeout");

      const slowNotifier = {
        saveTx: async options => { options.notifierQueue.delay = 90; await new Promise(resolve => setTimeout(resolve, 5)); }
      };
      const notifierStarted = Date.now();
      await dbCoordinator.saveEntity(slowNotifier, { label: "slow-notifier" });
      assert(Date.now() - notifierStarted >= 20);
      assert.equal(dbCoordinator.getPendingCount(), 0);
      await dbCoordinator.flush(500);
      assert.equal(dbCoordinator.getPendingNotifierCount(), 0);
      assert(notifierEvents.length >= 2);

      const serialized = [];
      await Promise.all([
        dbCoordinator.runSerializedWrite("one", async () => { serialized.push("one-start"); await new Promise(resolve => setTimeout(resolve, 8)); serialized.push("one-end"); }),
        dbCoordinator.runSerializedWrite("two", async () => { serialized.push("two-start"); await new Promise(resolve => setTimeout(resolve, 2)); serialized.push("two-end"); })
      ]);
      assert.deepEqual(serialized, ["one-start", "one-end", "two-start", "two-end"]);
    }
    finally { context.Zotero = previousNotifierZotero; }

    const previousZotero = context.Zotero;
    const note = { id: 3, key: "NOTE", getNote: () => "note body" };
    const attachment = { id: 2, key: "ATT", itemType: "attachment", attachmentFilename: "paper.pdf", attachmentContentType: "application/pdf", attachmentLinkMode: 0, getField: name => name === "title" ? "PDF" : "", isAttachment: () => true };
    const item = {
      id: 1, key: "ITEM", libraryID: 1, itemType: "journalArticle", itemTypeID: 1,
      getField: name => ({ title: "A paper", date: "2025", abstractNote: "Abstract", extra: "extra" }[name] || ""),
      getCreators: () => [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }],
      getTags: () => [{ tag: "research" }], getAttachments: () => [2], getNotes: () => [3]
    };
    context.Zotero = {
      Items: { get: id => ({ 1: item, 2: attachment, 3: note }[id]) },
      ItemTypes: { getID: () => 1 },
      ItemFields: { getItemTypeFields: () => [1, 2], getName: id => ({ 1: "title", 2: "extra" }[id]) }
    };
    try {
      const formatted = Agent.ItemFormatter.formatItem(item);
      assert.equal(formatted.title, "A paper");
      assert.equal(formatted.creators[0].name, "Ada Lovelace");
      assert.equal(formatted.notes[0].content, "note body");
      assert.equal(formatted.attachments[0].filename, "paper.pdf");
      assert.equal(formatted.attachments[0].path, undefined);
      const collection = { id: 9, key: "COLL", libraryID: 1, name: "Child", parentID: 8, getRelations: () => ({}) };
      const parent = { id: 8, key: "PARENT", libraryID: 1, name: "Parent", parentID: 0 };
      const byID = new Map([[8, parent], [9, collection]]);
      assert.equal(Agent.CollectionFormatter.formatCollectionBrief(collection, byID).path, "Parent > Child");
      const annotation = { id: 4, key: "ANN", parentKey: "ATT", annotationType: "highlight", annotationText: "highlighted", annotationComment: "comment", annotationColor: "#ff0", annotationPageLabel: "3", annotationPosition: JSON.stringify({ pageIndex: 2 }), annotationSortIndex: 7, dateAdded: "2025-01-01", dateModified: "2025-01-02", getTags: () => [{ tag: "keep" }] };
      const normalized = Agent.AnnotationFormatter.normalize(annotation, { attachmentKey: "ATT", documentID: "1-ATT" });
      assert.equal(normalized.type, "highlight");
      assert.equal(normalized.page, 3);
      assert.equal(normalized.locator.documentID, "1-ATT");
      assert.equal(Agent.AnnotationFormatter.paginate([normalized], { offset: 0, limit: 1 }).total, 1);
    }
    finally { context.Zotero = previousZotero; }
  }

  async function testLiteratureDiscoveryAcquisitionReview() {
    const storage = new MemoryStorage();
    storage.root = "/mem/profile/litmtrans";
    const makeItem = index => ({
      id: index + 1, key: `PAPER${index}`, libraryID: 1, itemType: "journalArticle",
      isRegularItem: () => true,
      getField: name => ({ title: `ROV tether hydrodynamics ${index}`, abstractNote: `Hydrodynamic model and cable dynamics ${index}`, date: String(2020 + (index % 5)), publicationTitle: "Marine Robotics", DOI: `10.1000/test-${index}` }[name] || ""),
      getCreators: () => [{ firstName: "Ada", lastName: `Author${index}`, creatorType: "author" }],
      getTags: () => [{ tag: index % 2 ? "rov" : "hydrodynamics" }],
      getCollections: () => [10], getAttachments: () => []
    });
    const items = Array.from({ length: 1200 }, (_, index) => makeItem(index));
    let fullTextReads = 0;
    const library = { allItems: async () => items };
    const controller = { storage, log() {} };
    const index = new Agent.PaperCardIndex(controller, library, {
      cardFactory: async item => Agent.PaperCard.fromItem(item, { storage })
    });
    await index.rebuild();
    const found = await index.search({ query: "ROV tether hydrodynamics", limit: 20 });
    assert.equal(found.backend, "json-fallback");
    assert.equal(found.items.length, 20);
    assert.equal(index.fullTextReads, 0);
    assert.equal(fullTextReads, 0);

    const external = {
      name: "openalex",
      search: async () => ({ results: [
        { candidateID: "external-1", metadata: { title: "ROV tether hydrodynamics review", authors: [{ name: "Grace Researcher" }], year: 2025, venue: "Ocean Engineering" }, summary: { abstract: "A review" }, identifiers: { doi: "10.2000/review" }, discovery: { citationCount: 10, openAccess: true } },
        { candidateID: "external-2", metadata: { title: "Unrelated paper", authors: [], year: 2024 }, summary: { abstract: "other" }, identifiers: { doi: "10.2000/other" }, discovery: {} }
      ] }),
      status: () => ({ status: "ok" })
    };
    const discovery = new Agent.LiteratureDiscoveryService(controller, { library, index, providers: { openalex: external } });
    const result = await discovery.search({ query: "ROV tether hydrodynamics", limit: 10, localLimit: 50 });
    assert(result.items.length > 0);
    assert.equal(result.evidenceLevel, "metadata");
    assert.equal(result.stages.fullTextRead, 0);
    assert.equal(result.providers.openalex, "ok");

    let bootstrapCalls = 0;
    const runtime = new Agent.ManagedRuntimeManager(storage, { bootstrap: async () => { bootstrapCalls++; return { available: true, version: "1.0.0", source: "fixture" }; }, healthCheck: async () => true });
    const runtimeResult = await runtime.ensure();
    assert.equal(runtimeResult.available, true);
    assert.equal(bootstrapCalls, 1);
    assert.equal((await runtime.ensure()).reused, true);

    const review = new Agent.ReviewWorkspaceService({ storage }, { discovery });
    const workspace = await review.create({ question: "ROV tether hydrodynamics" });
    await review.update({ id: workspace.id, evidence: [{ paperID: "external-1", evidenceLevel: "abstract", quote: "abstract evidence" }], gaps: [{ type: "observed coverage gap", statement: "纳入候选中尚未发现" }] });
    const status = await review.status({ id: workspace.id });
    assert.equal(status.evidenceCount, 1);
    assert.equal(status.coverage.byLevel.abstract, 1);
    await assert.rejects(() => review.update({ id: workspace.id, evidence: [{ evidenceLevel: "full-text-block", quote: "missing locator" }] }), error => error.code === "EVIDENCE_LOCATOR_REQUIRED");
  }

  async function testPaperCardSQLiteBackend() {
    const previousZotero = context.Zotero;
    class FakeDBConnection {
      constructor() { this.cards = new Map(); this.fts = new Map(); this.meta = new Map(); }
      async queryAsync(sql, params = []) {
        if (/^SELECT identity, payload FROM paper_cards/i.test(sql)) return [...this.cards].map(([identity, payload]) => ({ identity, payload }));
        if (/^SELECT identity FROM paper_cards_fts/i.test(sql)) return [...this.fts].map(([identity]) => ({ identity }));
        if (/^DELETE FROM paper_cards_fts/i.test(sql)) { this.fts.clear(); return []; }
        if (/^DELETE FROM paper_cards/i.test(sql)) { this.cards.clear(); return []; }
        if (/^DELETE FROM paper_card_meta/i.test(sql)) { this.meta.delete(String(params[0])); return []; }
        if (/^INSERT INTO paper_cards\(/i.test(sql)) { this.cards.set(String(params[0]), String(params[1])); return []; }
        if (/^INSERT INTO paper_cards_fts/i.test(sql)) { this.fts.set(String(params[0]), true); return []; }
        if (/^INSERT INTO paper_card_meta/i.test(sql)) { this.meta.set(String(params[0]), String(params[1])); return []; }
        return [];
      }
      async valueQueryAsync(_sql, params = []) { return this.meta.get(String(params[0])) || null; }
      async executeTransaction(callback) { return callback(); }
      async closeDatabase() {}
    }
    context.Zotero = { ...(previousZotero || {}), DBConnection: FakeDBConnection };
    try {
      const storage = new MemoryStorage();
      storage.root = "/mem/profile/sqlite";
      const item = { key: "SQLITE1", id: 1, libraryID: 1, itemType: "journalArticle", isRegularItem: () => true, dateModified: "2026-09-22" };
      const index = new Agent.PaperCardIndex({ storage }, { allItems: async () => [item] }, {
        cardFactory: async () => ({ schemaVersion: 1, local: { documentID: "1-SQLITE1" }, metadata: { title: "SQLite paper", authors: [] }, identifiers: {}, summary: { abstract: "fts evidence" }, zotero: { tags: [], collections: [] }, discovery: { citationCount: 0 } })
      });
      const rebuilt = await index.rebuild();
      assert.equal(rebuilt.backend, "sqlite-fts5");
      assert.equal(index.stats().sqliteAvailable, true);
      const found = await index.search({ query: "SQLite", limit: 5 });
      assert.equal(found.backend, "sqlite-fts5");
      assert.equal(found.items.length, 1);
      await index.shutdown();
    }
    finally { context.Zotero = previousZotero; }
  }

  async function testSearchFieldsAndBootstrap() {
    const previousZotero = context.Zotero;
    const makeItem = (key, values, extras = {}) => ({ key, id: Number(key.replace(/\D/g, "")) || 1, libraryID: 1, itemType: "journalArticle", isRegularItem: () => true, ...extras, getField: name => values[name] || "", getCreators: () => values.creators || [], getTags: () => (values.tags || []).map(tag => ({ tag })), getAttachments: () => values.attachments || [], getNotes: () => values.notes || [] });
    const first = makeItem("ITEM1", { title: "Vision systems", abstractNote: "A method", date: "2024", language: "en", extra: "fulltext needle", creators: [{ firstName: "Ada", lastName: "Lovelace" }], tags: ["vision"], attachments: [], notes: [] });
    const second = makeItem("ITEM2", { title: "Other paper", abstractNote: "No match", date: "2023", language: "zh", creators: [], tags: [], attachments: [], notes: [] });
    context.Zotero = { Items: { get: () => null }, Collections: { get: () => null } };
    const library = new Agent.LibraryService({ storage: { documentID: attachment => `1-${attachment.key}` } });
    library.nativeSearch = async () => null;
    library.allItems = async () => [first, second];
    library.itemRecord = async item => ({ key: item.key, title: item.getField("title") });
    const result = await library.searchItems({ q: "vision", fieldQueries: { language: { operator: "equals", value: "en" } }, sort: "relevance", includeRelevance: true, includeStatus: false });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].key, "ITEM1");
    assert(result.items[0].relevance > 0);
    assert.equal(library.matches(first, { fulltext: "needle", notes: false }), true);
    assert.equal(library.matches(first, { tags: ["vision"], tagMode: "all", tagMatch: "exact" }), true);

    const attachment = { id: 3, parentID: first.id, itemType: "attachment", isAttachment: () => true };
    const note = { id: 4, parentID: first.id, itemType: "note", isNote: () => true };
    context.Zotero = {
      Items: { get: id => ({ 1: first, 3: attachment, 4: note }[id]) },
      Collections: { get: () => null },
      Search: function () {
        this.conditions = [];
        this.addCondition = (name, operator, value) => this.conditions.push({ name, operator, value });
        this.search = async () => this.conditions.some(row => row.name === "fulltextContent") ? [3] : [4];
      }
    };
    library.allItems = async () => [first, second];
    const fulltextResult = await library.searchItems({ libraryID: 1, fulltext: "needle", fulltextMode: "attachment", includeStatus: false });
    assert.equal(fulltextResult.total, 1);
    assert.equal(fulltextResult.items[0].key, "ITEM1");
    const instruction = Agent.buildAgentBootstrapInstruction("http://127.0.0.1:45124/litmtrans/mcp", "zotero-litmtrans", { toolCount: 108 }, "Codex");
    assert(instruction.includes("保留其他已有服务"));
    assert(instruction.includes("服务名称固定为 zotero-litmtrans"));
    assert(instruction.includes("litmtrans_get_capabilities"));
    assert(instruction.includes("45124"));
    assert(!instruction.trim().startsWith("{"));
    context.Zotero = previousZotero;
  }

  async function testPaperCardLightweightStatus() {
    const storage = new MemoryStorage();
    storage.root = "/mem/profile/litmtrans-lightweight";
    const documentID = "1-LIGHT";
    await storage.writeJSON(storage.path(documentID, "document.json"), { documentID, parsedAt: "2026-09-22T00:00:00Z", hasLayout: true, imageCount: 3, pageCount: 4 });
    await storage.writeText(storage.path(documentID, "full.cleaned.md"), "should not be read by the status code");
    const attachment = { id: 7, key: "LIGHT", attachmentFilename: "paper.pdf" };
    const controller = {
      storage,
      getSettings: () => ({ targetLanguage: "简体中文" }),
      attachmentContext: async () => ({ documentID, parent: { id: 1, key: "ITEM" }, attachment }),
      pipeline: { snapshot: async () => { throw new Error("snapshot must not be called"); } },
      mineru: { loadParsed: async () => { throw new Error("loadParsed must not be called"); } },
      translation: { paths: id => ({ final: storage.path(id, "translation", "translation.zh.md"), meta: storage.path(id, "translation", "translation.zh.json") }) },
      layout: { paths: id => ({ translations: storage.path(id, "layout-translation", "translations.zh.json"), meta: storage.path(id, "layout-translation", "meta.zh.json") }) }
    };
    await storage.writeText(storage.path(documentID, "translation", "translation.zh.md"), "译文");
    await storage.writeJSON(storage.path(documentID, "translation", "translation.zh.json"), { complete: true, completedAt: "2026-09-22T01:00:00Z" });
    const status = await Agent.AgentFacade.prototype.lightweightDocumentStatus.call({ controller }, attachment);
    assert.equal(status.parsed, true);
    assert.equal(status.streamTranslation, true);
    assert.equal(status.layoutSource, true);
    assert.equal(status.figureCount, 3);
    assert.equal(status.tableCount, 0);
    assert.equal(status.formulaCount, 0);
  }

  async function testCacheClearStatusSemantics() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/cache-clear";
    const documentID = "1-CLEAR";
    const attachment = { id: 7, key: "CLEAR", attachmentFilename: "paper.pdf" };
    storage.documentDir = id => storage.path(id);
    const attachmentPath = storage.path("attachments", "paper.pdf");
    await storage.writeBytes(attachmentPath, new Uint8Array([37, 80, 68, 70]));
    const controller = {
      storage,
      getSettings: () => ({ targetLanguage: "简体中文" }),
      attachmentContext: async () => ({ documentID, parent: { id: 1, key: "ITEM" }, attachment }),
      attachmentPath: async () => attachmentPath,
      translation: { paths: id => ({ final: storage.path(id, "translation", "translation.zh.md"), meta: storage.path(id, "translation", "translation.zh.json") }) },
      layout: { paths: id => ({ translations: storage.path(id, "layout-translation", "translations.zh.json"), meta: storage.path(id, "layout-translation", "meta.zh.json") }) }
    };
    const facade = Object.create(Agent.AgentFacade.prototype);
    facade.controller = controller;
    facade.policy = { assert() {} };
    facade.artifact = { resolve: async () => ({ context: { documentID, parent: { id: 1, key: "ITEM" }, attachment } }) };
    let latestStatus = null;
    facade.literature = { updateDocumentStatus: async (_id, status) => { latestStatus = status; } };
    await storage.writeText(storage.path(documentID, "translation", "translation.zh.md"), "stream");
    await storage.writeJSON(storage.path(documentID, "translation", "translation.zh.json"), { complete: true });
    await storage.writeJSON(storage.path(documentID, "layout-translation", "translations.zh.json"), { complete: true });
    const translation = await Agent.AgentFacade.prototype.clearDocumentCache.call(facade, documentID, "translation");
    assert.equal(translation.cleared, true);
    assert.equal(await storage.exists(storage.path(documentID, "translation")), false);
    assert.equal(await storage.exists(storage.path(documentID, "layout-translation")), false);
    assert.equal(latestStatus.streamTranslation, false);
    assert.equal(latestStatus.layoutTranslation, false);
    assert.equal(latestStatus.streamTranslationStale, false);
    assert.equal(latestStatus.layoutTranslationStale, false);
    await storage.writeJSON(storage.path(documentID, "document.json"), { parsedAt: "2026-09-22T00:00:00Z", pageCount: 4 });
    await storage.writeText(storage.path(documentID, "full.cleaned.md"), "parsed");
    await storage.writeText(storage.path(documentID, "translation", "translation.zh.md"), "stream");
    const all = await Agent.AgentFacade.prototype.clearDocumentCache.call(facade, documentID, "all");
    assert.equal(all.cleared, true);
    assert.equal(latestStatus.hasAttachment, true);
    assert.equal(latestStatus.parsed, false);
    assert.equal(latestStatus.streamTranslation, false);
    assert.equal(latestStatus.layoutTranslation, false);
    assert.equal(latestStatus.pageCount, null);
  }

  async function testPaperCardIncrementalStatusAndPreservation() {
    const storage = new MemoryStorage();
    storage.root = "/mem/profile/litmtrans-incremental";
    const item = { id: 1, key: "INCR", libraryID: 1, itemType: "journalArticle", isRegularItem: () => true, getField: name => ({ title: "Incremental paper", DOI: "10.1000/incremental" }[name] || ""), getCreators: () => [], getAttachments: () => [] };
    const library = { allItems: async () => [item] };
    const index = new Agent.PaperCardIndex({ storage }, library, { cardFactory: async () => ({ schemaVersion: 1, local: { documentID: "1-INCR", itemKey: "INCR" }, metadata: { title: "Incremental paper", authors: [] }, identifiers: { doi: "10.1000/incremental" }, summary: { abstract: "" }, zotero: { tags: [], collections: [] }, discovery: { citationCount: 0 }, litmtrans: { hasAttachment: true, parsed: false, streamTranslation: false, layoutTranslation: false } }) });
    await index.rebuild();
    await index.updateDocumentStatus("1-INCR", { parsed: true });
    await index.updateDocumentStatus("1-INCR", { streamTranslation: true });
    const found = await index.search({ query: "Incremental", limit: 5 });
    assert.equal(found.items[0].litmtrans.parsed, true);
    assert.equal(found.items[0].litmtrans.streamTranslation, true);
    await index.upsert({ ...found.items[0], litmtrans: { hasAttachment: true, parsed: false, streamTranslation: false, layoutTranslation: false } });
    assert.equal(index.rows[0].litmtrans.parsed, true);
    assert.equal(index.rows[0].litmtrans.streamTranslation, true);
    await index.updateDocumentStatus("1-INCR", { hasAttachment: false });
    assert.equal(index.rows[0].litmtrans.hasAttachment, false);
    assert.equal(index.rows[0].litmtrans.parsed, false);
    assert.equal(index.rows[0].litmtrans.streamTranslation, false);
    assert.equal(index.rows[0].litmtrans.pageCount, null);
    const removed = await index.removeDocument("1-INCR");
    assert.equal(removed.removed, true);
    assert.equal(index.rows.length, 0);
  }

  async function testCreatorNormalizationAndOpenAlexImport() {
    const previousZotero = context.Zotero;
    let saved = null;
    class FakeItem {
      constructor() { this.creators = []; this.fields = {}; this.key = "CREATOR"; this.id = 1; this.libraryID = 1; }
      setField(name, value) { this.fields[name] = value; }
      setCreators(value) { this.creators = value; }
    }
    context.Zotero = { ...(previousZotero || {}), Item: FakeItem };
    try {
      const library = { searchItems: async () => ({ items: [] }), saveEntity: async item => { saved = item; }, addItemsToCollection: async () => {}, itemRecord: async item => ({ key: item.key, creators: item.creators }) };
      const importer = new Agent.ImportService(library);
      await importer.create({ title: "Creator fixture", author: [{ name: "Ada Lovelace" }, { given: "Grace", family: "Hopper", creatorType: "editor" }, { firstName: "Alan", lastName: "Turing" }] }, { libraryID: 1 });
      assert(saved);
      assert.equal(saved.creators.length, 3);
      assert.equal(saved.creators[0].name, "Ada Lovelace");
      assert.equal(saved.creators[1].firstName, "Grace");
      assert.equal(saved.creators[1].lastName, "Hopper");
      assert.equal(saved.creators[1].creatorType, "editor");
      assert(!JSON.stringify(saved.creators).includes("[object Object]"));
      const normalized = Agent.ImportHelpers.normalizeCreators([{ given: "Open", family: "Alex", creatorType: "author" }]);
      assert.deepEqual(normalized, [{ creatorType: "author", firstName: "Open", lastName: "Alex" }]);
    }
    finally { context.Zotero = previousZotero; }
  }

  async function testSQLiteScanModeLifecycle() {
    const previousZotero = context.Zotero;
    class ScanDB {
      static states = new Map();
      constructor(path) { this.state = ScanDB.states.get(path) || { cards: new Map(), fts: false, meta: new Map(), matchCalls: 0 }; ScanDB.states.set(path, this.state); }
      async queryAsync(sql, params = []) {
        if (/sqlite_master/i.test(sql)) return this.state.fts ? [{ type: "table", sql: "CREATE TABLE paper_cards_fts (identity TEXT)" }] : [];
        if (/CREATE VIRTUAL TABLE.*fts5/i.test(sql)) throw new Error("fts5 unavailable");
        if (/CREATE VIRTUAL TABLE.*fts4/i.test(sql)) throw new Error("fts4 unavailable");
        if (/CREATE TABLE IF NOT EXISTS paper_cards_fts/i.test(sql)) { this.state.fts = true; return []; }
        if (/^SELECT identity, payload FROM paper_cards/i.test(sql)) return [...this.state.cards].map(([identity, payload]) => ({ identity, payload }));
        if (/MATCH/i.test(sql)) { this.state.matchCalls += 1; return []; }
        if (/^SELECT identity FROM paper_cards_fts/i.test(sql)) return [...this.state.cards].map(([identity]) => ({ identity }));
        if (/^DELETE FROM paper_cards_fts/i.test(sql)) { this.state.cards.forEach((_value, key) => {}); return []; }
        if (/^DELETE FROM paper_cards/i.test(sql)) { this.state.cards.clear(); return []; }
        if (/^DELETE FROM paper_card_meta/i.test(sql)) { this.state.meta.delete(String(params[0])); return []; }
        if (/^INSERT INTO paper_cards\(/i.test(sql)) { this.state.cards.set(String(params[0]), String(params[1])); return []; }
        if (/^INSERT INTO paper_cards_fts/i.test(sql)) return [];
        if (/^INSERT INTO paper_card_meta/i.test(sql)) { this.state.meta.set(String(params[0]), String(params[1])); return []; }
        return [];
      }
      async valueQueryAsync(_sql, params = []) { return this.state.meta.get(String(params[0])) || null; }
      async executeTransaction(callback) { return callback(); }
      async closeDatabase() {}
    }
    context.Zotero = { ...(previousZotero || {}), DBConnection: ScanDB };
    try {
      const storage = new MemoryStorage(); storage.root = "/mem/profile/sqlite-scan";
      const library = { allItems: async () => [{ key: "SCAN", id: 1, libraryID: 1, itemType: "journalArticle", isRegularItem: () => true, dateModified: "2026-09-22" }] };
      const factory = async () => ({ local: { documentID: "1-SCAN" }, metadata: { title: "Scan backend", authors: [] }, identifiers: {}, summary: { abstract: "scan fallback" }, zotero: { tags: [], collections: [] }, discovery: { citationCount: 0 } });
      const index = new Agent.PaperCardIndex({ storage }, library, { cardFactory: factory });
      assert.equal((await index.rebuild()).backend, "sqlite-scan");
      assert.equal(index.stats().sqliteMode, "scan");
      const found = await index.search({ query: "Scan backend", limit: 5 });
      assert.equal(found.items.length, 1);
      assert.equal(ScanDB.states.get(storage.sqlitePath || "/mem/profile/sqlite-scan/literature-index.sqlite")?.matchCalls || 0, 0);
      await index.shutdown();
      const reopened = new Agent.PaperCardIndex({ storage }, library, { cardFactory: factory });
      await reopened.init();
      assert.equal(reopened.stats().sqliteMode, "scan");
      assert.equal((await reopened.search({ query: "Scan backend", limit: 5 })).items.length, 1);
      await reopened.shutdown();
    }
    finally { context.Zotero = previousZotero; }
  }

  async function testOfficialProviderShapes() {
    const semanticCalls = [];
    const semantic = new Agent.SemanticScholarProvider({ requestJSON: async url => {
      semanticCalls.push(url);
      const paper = id => ({ paperId: id, title: id, authors: [], externalIds: {}, year: 2024 });
      if (url.includes("/citations")) return { data: [{ citingPaper: paper("citing") }] };
      if (url.includes("/references")) return { data: [{ citedPaper: paper("cited") }] };
      return { recommendedPapers: [paper("recommended")] };
    } });
    const seed = { candidateID: "seed", identifiers: { doi: "10.1000/seed" }, metadata: { title: "Seed" } };
    assert.equal((await semantic.expand(seed, "citations")).results[0].candidateID, "citing");
    assert.equal((await semantic.expand(seed, "references")).results[0].candidateID, "cited");
    assert.equal((await semantic.expand(seed, "recommend")).results[0].candidateID, "recommended");
    assert(semanticCalls.some(url => url.startsWith("https://api.semanticscholar.org/graph/v1/")));
    const recommendationURL = semanticCalls.find(url => url.includes("recommendations"));
    assert(recommendationURL.includes("https://api.semanticscholar.org/recommendations/v1/"));
    assert(!recommendationURL.includes("graph/v1/recommendations/v1"));
    assert(decodeURIComponent(semanticCalls[0]).includes("DOI:10.1000/seed"));

    const openAlexCalls = [];
    const openalex = new Agent.OpenAlexProvider({ requestJSON: async url => {
      openAlexCalls.push(url);
      const decoded = decodeURIComponent(url);
      const work = id => ({ id: `https://openalex.org/${id}`, title: id, publication_year: 2024, authorships: [], open_access: { is_oa: true }, referenced_works: [], related_works: [] });
      if (decoded.includes("filter=doi:")) return { results: [work("W1")] };
      if (decoded.includes("filter=cites:W1")) return { results: [work("W2")] };
      if (decoded.endsWith("/works/W1")) return { referenced_works: ["https://openalex.org/W3"], related_works: ["https://openalex.org/W4"] };
      if (decoded.includes("openalex_id:W3")) return { results: [work("W3")] };
      if (decoded.includes("openalex_id:W4")) return { results: [work("W4")] };
      return { results: [] };
    } });
    const oaSeed = { identifiers: { doi: "10.1000/openalex" }, metadata: { title: "Seed" } };
    assert.equal((await openalex.expand(oaSeed, "citations")).results[0].candidateID, "https://openalex.org/W2");
    assert.equal((await openalex.expand(oaSeed, "references")).results[0].candidateID, "https://openalex.org/W3");
    assert.equal((await openalex.expand(oaSeed, "recommend")).results[0].candidateID, "https://openalex.org/W4");
    assert(openAlexCalls.some(url => decodeURIComponent(url).includes("filter=cites:W1")));
    assert(!openAlexCalls.some(url => url.includes("related_to")));

    const crossref = new Agent.CrossrefProvider({});
    const crossrefCard = crossref.normalize({ DOI: "10.1000/crossref", title: ["Crossref"], author: [{ given: "A", family: "B" }], abstract: "<jats:p>Abstract &amp; detail</jats:p>", link: [{ "content-type": "application/pdf", URL: "https://example.test/paper.pdf" }] });
    assert.equal(crossrefCard.summary.abstract, "Abstract & detail");
    assert.equal(crossrefCard.discovery.openAccess, false);
    assert.equal(crossrefCard.discovery.bestOALocation.pdfURL, "https://example.test/paper.pdf");
    const europe = new Agent.EuropePMCProvider({});
    const europeCard = europe.normalize({ id: "1", pmcid: "PMC1", fullTextUrlList: { fullTextUrl: [{ url: "https://europepmc.org/articles/PMC1", documentStyle: "html" }] } });
    assert.equal(europeCard.discovery.bestOALocation.pdfURL, undefined);
    assert.equal(europeCard.discovery.bestOALocation.landingPageURL, "https://europepmc.org/articles/PMC1");
    const arxiv = new Agent.ArxivProvider({});
    const arxivCard = arxiv.parse("<entry><id>http://arxiv.org/abs/2401.12345v2</id><title>A</title><summary>S</summary><published>2024-01-01</published><author><name>Ada</name></author><link title=\"pdf\" href=\"https://arxiv.org/pdf/2401.12345v2.pdf\"/><arxiv:doi>10.1000/arxiv</arxiv:doi></entry>")[0];
    assert.equal(arxivCard.identifiers.arxiv, "2401.12345");
    assert.equal(arxivCard.identifiers.doi, "10.1000/arxiv");
    assert.equal(arxivCard.discovery.bestOALocation.pdfURL, "https://arxiv.org/pdf/2401.12345.pdf");
  }

  async function testLiteratureFiltersSeedsAndGraphIsolation() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/literature-contract";
    const make = (id, title, year, openAccess, author, venue) => ({ candidateID: id, metadata: { title, year, authors: [{ name: author }], venue }, identifiers: { doi: `10.1000/${id}` }, summary: { abstract: "robot topic" }, discovery: { topics: ["robot"], keywords: [], concepts: [], openAccess, citationCount: 1 } });
    const provider = { name: "fixture", search: async options => ({ results: options.query === "A" ? [make("A", "A robot", 2022, true, "Ada", "Journal")] : options.query === "B" ? [make("B", "B robot", 2023, true, "Ada", "Journal")] : [make("right", "Right robot", 2022, true, "Ada", "Journal"), make("old", "Old robot", 2018, true, "Ada", "Journal"), make("closed", "Closed robot", 2022, false, "Ada", "Journal")] }), expand: async (seed, mode) => ({ results: [make(`expanded-${mode}`, "Expanded robot", 2022, true, "Ada", "Journal")] }), status: () => ({ status: "ok" }) };
    const index = { backend: "json-fallback", rows: [], init: async () => {}, search: async () => ({ items: [] }), findByIdentifier: () => null, shutdown: async () => {} };
    const discovery = new Agent.LiteratureDiscoveryService({ storage }, { index, providers: { fixture: provider } });
    const filtered = await discovery.search({ query: "robot", yearFrom: 2020, yearTo: 2024, openAccessOnly: true, author: "Ada", venue: "Journal", topic: "robot", limit: 10 });
    assert.deepEqual(filtered.items.map(row => row.candidateID), ["right"]);
    await assert.rejects(() => discovery.search({ mode: "citations", external: true }), error => error.code === "LITERATURE_SEED_REQUIRED");
    const expanded = await discovery.search({ mode: "citations", seedCandidateIDs: ["10.1000/seed"], external: true, limit: 10 });
    assert.equal(expanded.items[0].candidateID, "expanded-citations");
    const graphA = await discovery.search({ query: "A", includeGraph: true, external: true });
    const graphB = await discovery.search({ query: "B", includeGraph: true, external: true });
    assert(graphA.graph.nodes.some(node => node.value === "10.1000/a"));
    assert(!graphB.graph.nodes.some(node => node.value === "10.1000/a"));
  }

  async function testManagedRuntimeRollbackAndScanSciClient() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/runtime";
    let version = "1.17.0";
    const runtime = new Agent.ManagedRuntimeManager(storage, { bootstrap: async () => ({ available: true, version, executable: "C:/runtime/python.exe", source: "fixture" }), healthCheck: async () => true });
    assert.notEqual(Agent.AcquisitionRuntimeManifest.LAST_KNOWN_GOOD_MANIFEST.scansci.minVersion, "0.0.0");
    const first = await runtime.ensure();
    assert.equal(first.available, true);
    version = "broken";
    runtime.bootstrap = async () => { throw new Error("mirror unavailable"); };
    const failed = await runtime.update();
    assert.equal(failed.rolledBack, true);
    assert.equal(runtime.state.status, "installed");
    assert.equal(runtime.state.version, "1.17.0");

    let spawned = 0; let killed = 0;
    const client = new Agent.ScanSciMCPClient(runtime, {
      spawn: async () => { spawned += 1; return { kill: () => { killed += 1; } }; },
      health: async ({ client: current }) => current.started,
      request: async (_endpoint, payload) => {
        if (payload.method === "initialize") return { result: { protocolVersion: "2025-11-25" } };
        if (payload.method === "tools/list") return { result: { tools: [{ name: "scansci_pdf_download", inputSchema: { type: "object" } }] } };
        if (payload.method === "tools/call") return { result: { content: [{ type: "text", text: JSON.stringify({ success: true, file: "/mem/staging/paper.pdf", doi: "10.1000/test" }) }] } };
        return { result: {} };
      }
    });
    await client.start();
    const call = await client.call("scansci_pdf_download", { identifier: "10.1000/test", output_dir: "/mem/staging" });
    assert.equal(call.path, "/mem/staging/paper.pdf");
    assert.equal(call.success, true);
    await assert.rejects(() => client.call("fetch_paper"), error => error.code === "SCANSCI_TOOL_UNAVAILABLE");
    await client.restart();
    await client.shutdown();
    assert.equal(spawned, 2);
    assert.equal(killed, 2);

    let retrySpawned = 0; let retryKilled = 0; let retryHealthCalls = 0; const retryPorts = [];
    const retryClient = new Agent.ScanSciMCPClient(runtime, {
      port: 45111,
      maxPortAttempts: 3,
      spawn: async ({ port }) => { retrySpawned += 1; retryPorts.push(port); return { kill: () => { retryKilled += 1; } }; },
      health: async () => { retryHealthCalls += 1; return retryHealthCalls > 20; },
      request: async (_endpoint, payload) => {
        if (payload.method === "initialize") return { result: { protocolVersion: "2025-11-25" } };
        if (payload.method === "tools/list") return { result: { tools: [{ name: "scansci_pdf_download" }] } };
        return { result: {} };
      }
    });
    await retryClient.start();
    assert.equal(retrySpawned, 2);
    assert.notEqual(retryPorts[0], retryPorts[1]);
    await retryClient.shutdown();
    assert.equal(retryKilled, 2);
  }

  async function testScanSciProviderContract() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/scansci-provider";
    let ensured = 0;
    let validated = 0;
    let shutdowns = 0;
    const calls = [];
    let mode = "success";
    const runtime = { storage, ensure: async () => { ensured += 1; return { available: true, state: {} }; } };
    const client = {
      call: async (name, args) => {
        calls.push({ name, args });
        return mode === "failed"
          ? { success: false, error: "not found", error_type: "source-unavailable", agent_hint: "try another source" }
          : { success: true, file: "/mem/profile/scansci-provider/staging/paper.pdf", doi: "10.1000/provider" };
      },
      shutdown: async () => { shutdowns += 1; }
    };
    const provider = new Agent.ScanSciProvider(runtime, { client, validator: { validateFile: async () => { validated += 1; return { valid: true }; } } });
    const unresolved = await provider.acquire({ candidateID: "title-only", metadata: { title: "Title only" } }, { outputDir: "/mem/output" });
    assert.equal(unresolved.code, "ACQUISITION_IDENTIFIER_UNRESOLVED");
    assert.equal(ensured, 0);
    assert.equal(calls.length, 0);
    const acquired = await provider.acquire({ candidateID: "doi-paper", identifiers: { doi: "https://doi.org/10.1000/provider" } }, { outputDir: "/mem/output" });
    assert.equal(acquired.status, "available");
    assert.deepEqual(calls[0], { name: "scansci_pdf_download", args: { identifier: "10.1000/provider", output_dir: "/mem/output", use_vpnsci: true } });
    assert.equal(validated, 1);
    mode = "failed";
    const failed = await provider.acquire({ identifiers: { doi: "10.1000/provider" } }, { outputDir: "/mem/output" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.code, "SCANSCI_DOWNLOAD_FAILED");
    assert.equal(validated, 1);
    await provider.shutdown();
    assert.equal(shutdowns, 1);
  }

  async function testScanSciFailureIsNotMaskedByTranslatorFallback() {
    const scansciFailure = { status: "failed", provider: "managed-scansci", code: "SCANSCI_DOWNLOAD_FAILED", error: "ScanSci MCP server did not start" };
    const service = new Agent.PaperAcquisitionService({}, {
      importer: {},
      providers: [{ name: "managed-scansci", acquire: async () => scansciFailure }]
    });
    const result = await service.providerAcquire({ identifiers: { arxiv: "2401.00001" } });
    assert.equal(result, scansciFailure);
  }

  async function testDirectOaStagingAndSizeLimit() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/direct-oa";
    let optionsSeen = null;
    const provider = new Agent.DirectKnownLocationProvider(storage, {
      maxBytes: 1024,
      downloadBytes: async (_url, options) => { optionsSeen = options; return new Uint8Array(2048); },
      validator: { validateBytes: async () => ({ valid: true }), validateFile: async () => ({ valid: true }) }
    });
    const invalid = await provider.acquire({ identifiers: { doi: "10.1000/large" }, discovery: { bestOALocation: { pdfURL: "https://example.test/large.pdf" } } });
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.validation.reason, "file-too-large");
    assert.equal(optionsSeen.maxBytes, 1024);
    const streamed = new Agent.DirectKnownLocationProvider(storage, {
      maxBytes: 1024,
      downloadToFile: async (_url, path) => storage.writeBytes(path, new Uint8Array([37, 80, 68, 70, 45, 49])),
      validator: { validateFile: async () => ({ valid: true }) }
    });
    const result = await streamed.acquire({ identifiers: { doi: "10.1000/stream" }, discovery: { bestOALocation: { pdfURL: "https://example.test/stream.pdf" } } });
    assert.equal(result.status, "available");
    assert(result.path.includes("staging/acquisition"));
  }

  async function testAcquisitionBatchApprovalAndChildren() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/acquisition-job";
    const approvals = new Agent.ExternalApprovalService(storage); await approvals.init();
    const tasks = new Agent.AgentTaskManager(storage); await tasks.init();
    const facade = Object.create(Agent.AgentFacade.prototype);
    facade.policy = { assert() {} };
    facade.controller = { getSettings: () => ({ mineruModel: "vlm" }) };
    facade.approvals = approvals;
    facade.tasks = tasks;
    facade.literature = { resolveCandidate: async value => ({ candidateID: value }) };
    facade.acquisition = { runtime: { ensure: async () => ({ available: true, version: "1.17.0" }) }, acquirePapers: async () => ({ total: 1, results: [{ status: "available", attachment: { attachmentKey: "ATT" }, item: { key: "ITEM" } }] }) };
    facade.processingRunner = () => async () => ({ parsed: true });
    let required;
    try { await facade.startAcquisitionBatch({ candidates: [{ candidateID: "paper" }], parse: true }); }
    catch (error) { required = error; }
    assert.equal(required.code, "EXTERNAL_SERVICE_APPROVAL_REQUIRED");
    const approval = await approvals.approve(required.details.approvalID, { approved: true, planHash: required.details.planHash });
    const job = await facade.startAcquisitionBatch({ candidates: [{ candidateID: "paper" }], parse: true, approvalID: approval.approvalID, approved: true });
    for (let index = 0; index < 100 && !["completed", "failed", "cancelled"].includes(tasks.raw(job.id)?.status); index++) await new Promise(resolve => setTimeout(resolve, 5));
    const finished = tasks.raw(job.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.result.parsed, 1);
    assert.equal(finished.children.length, 1);
    assert.equal([...approvals.rows.values()].length, 1);
    const retried = tasks.retry(job.id);
    for (let index = 0; index < 100 && !["completed", "failed", "cancelled"].includes(tasks.raw(retried.id)?.status); index++) await new Promise(resolve => setTimeout(resolve, 5));
    const retriedRaw = tasks.raw(retried.id);
    assert.equal(retriedRaw.status, "completed");
    assert.notEqual(retriedRaw.id, finished.id);
    assert.equal(retriedRaw.children.length, 1);
    assert.equal(tasks.raw(retriedRaw.children[0]).parentJobID, retriedRaw.id);
    assert.notEqual(tasks.raw(retriedRaw.children[0]).parentJobID, finished.id);
  }

  function testAcquisitionTargetAndSemverContracts() {
    const internals = Agent.ManagedRuntimeInternals;
    assert(internals.compareVersions("1.16.9", "1.17.0") < 0);
    assert.equal(internals.compareVersions("1.17.0+build.1", "1.17.0+build.2"), 0);
    assert(internals.compareVersions("1.17.0-beta.2", "1.17.0-beta.11") < 0);
    assert(internals.compareVersions("1.17.0-rc.1", "1.17.0") < 0);
    const windows = Agent.PlatformDescriptor.detect({ os: "WINNT", arch: "x86_64", abi: "x86_64-msvc", appInfo: {}, zotero: {} });
    assert.equal(windows.target, "windows-x64");
    assert.equal(windows.source, "Services.appinfo/Zotero runtime");
    const linuxMusl = Agent.PlatformDescriptor.detect({ os: "linux", arch: "aarch64", abi: "aarch64-musl", appInfo: {}, zotero: {} });
    assert.equal(linuxMusl.target, "linux-arm64-musl");
    assert.equal(linuxMusl.supported, false);
    const linuxUnknownABI = Agent.PlatformDescriptor.detect({ os: "linux", arch: "aarch64", abi: "aarch64-gcc3", appInfo: {}, zotero: {} });
    assert.equal(linuxUnknownABI.abi, "unknown");
    assert.equal(linuxUnknownABI.target, "linux-arm64-unknown-abi");
    assert.equal(linuxUnknownABI.supported, false);
    assert.equal(linuxUnknownABI.reason, "linux-abi-undetermined-managed-runtime-disabled");
    assert.equal(Agent.AcquisitionRuntimeManifest.targetManifest({}, "macos-arm64").status, "adapter-ready-not-field-validated");
    const runtimeManifest = Agent.AcquisitionRuntimeManifest.manifest();
    const windowsAdapter = Agent.createRuntimeAdapter(windows, runtimeManifest);
    assert.equal(windowsAdapter.target, "windows-x64");
    assert.equal(windowsAdapter.supported, true);
    const linuxArm = Agent.PlatformDescriptor.detect({ os: "linux", arch: "aarch64", abi: "aarch64-gnu", appInfo: {}, zotero: {} });
    assert.equal(linuxArm.target, "linux-arm64-gnu");
    const linuxArmTarget = runtimeManifest.targets["linux-arm64-gnu"];
    const linuxArmAdapter = Agent.createRuntimeAdapter(linuxArm, runtimeManifest);
    assert(linuxArmAdapter instanceof Agent.UvManagedPythonRuntimeAdapter);
    assert.equal(linuxArmAdapter.supported, true);
    assert.equal(linuxArmTarget.runtimeInstallStrategy, "uv-managed-python");
    assert.equal(linuxArmTarget.pythonBuild.targetTriple, "aarch64-unknown-linux-gnu");
    assert.equal(linuxArmTarget.uv.version, "0.12.18");
    assert.equal(linuxArmTarget.status, "adapter-ready-not-field-validated");
    assert.match(linuxArmTarget.uv.sources[0].url, /^https:\/\/releases\.astral\.sh\/github\/uv\/releases\/download\//);
    assert.match(linuxArmTarget.uv.sources[1].url, /^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\//);
    assert.equal(Agent.createRuntimeAdapter(linuxMusl, runtimeManifest).supported, false);
    for (const target of ["windows-arm64", "macos-arm64", "macos-x64", "linux-x64-gnu", "linux-arm64-gnu"]) {
      const targetConfig = runtimeManifest.targets[target];
      const adapter = Agent.createRuntimeAdapter(Agent.PlatformDescriptor.forTarget(target), runtimeManifest);
      assert(adapter instanceof Agent.UvManagedPythonRuntimeAdapter, `${target} must use the uv-managed adapter`);
      assert.equal(adapter.supported, true, `${target} adapter should be available`);
      assert.equal(targetConfig.status, "adapter-ready-not-field-validated");
      assert.equal(targetConfig.pythonBuild.version, targetConfig.pythonVersion);
      assert.match(targetConfig.pythonBuild.sha256, /^[a-f0-9]{64}$/i);
      assert.match(targetConfig.uv.sources[0].sha256, /^[a-f0-9]{64}$/i);
    }
    const windows32 = Agent.PlatformDescriptor.detect({ os: "WINNT", arch: "i686", abi: "x86-msvc", appInfo: {}, zotero: {} });
    assert.equal(windows32.supported, false);
    assert.equal(windows32.reason, "32-bit-runtime-is-not-a-managed-runtime-target");
    const pythonConfig = internals.pythonConfigForTarget(runtimeManifest, runtimeManifest.targets["windows-x64"]);
    assert.equal(pythonConfig.archiveURL, runtimeManifest.targets["windows-x64"].sources[0].url);
    assert.equal(pythonConfig.pip.wheelURL, runtimeManifest.python.pip.wheelURL);
    assert.equal(pythonConfig.pip.version, "25.3");
    assert.equal(runtimeManifest.scansci.packageIndexSources[0], "https://pypi.org/simple");
    assert.equal(runtimeManifest.scansci.packageIndexSources.length, 3);
    assert.equal(internals.PACKAGE_INSTALL_PROCESS_TIMEOUT_MS, 12 * 60 * 1000);
  }

  async function testUvManagedPythonAdapterPinsAndCleansBootstrap() {
    const platform = { os: "linux", arch: "arm64", abi: "gnu", target: "linux-arm64-gnu" };
    const config = Agent.AcquisitionRuntimeManifest.manifest().targets[platform.target];
    const adapter = Agent.createRuntimeAdapter(platform, Agent.AcquisitionRuntimeManifest.manifest());
    const files = new Set();
    const directories = new Set();
    const json = new Map();
    const storage = {
      async ensureDir(path) { directories.add(path); },
      async exists(path) { return path === "/usr/bin/tar" || files.has(path) || directories.has(path) || [...files, ...directories].some(value => value.startsWith(`${path}/`)); },
      async list(path) {
        const prefix = `${path}/`;
        return [...new Set([...files, ...directories].filter(value => value.startsWith(prefix)).map(value => prefix + value.slice(prefix.length).split("/")[0]))];
      },
      async writeJSON(path, value) { files.add(path); json.set(path, value); },
      async readJSON(path) { return json.get(path) || null; },
      async remove(path, recursive = false) {
        files.delete(path);
        json.delete(path);
        directories.delete(path);
        if (recursive) for (const value of [...files, ...directories]) if (value.startsWith(`${path}/`)) { files.delete(value); json.delete(value); directories.delete(value); }
      }
    };
    const staging = "/mem/profile/runtime/.acquisition-staging-test";
    let downloadsManifestPath = "";
    let pythonExecutable = "";
    const downloadAssetFromSources = async (_sources, path) => { files.add(path); };
    const extractZip = async (_storage, _archive, destination) => { files.add(`${destination}/uv.exe`); };
    const runProcess = async (executable, args) => {
      if (executable === "/usr/bin/tar") {
        files.add(`${args[3]}/uv-aarch64-unknown-linux-gnu/uv`);
        return { exitCode: 0 };
      }
      if (executable.endsWith("/uv-aarch64-unknown-linux-gnu/uv")) {
        const pathIndex = args.indexOf("--python-downloads-json-url");
        assert(pathIndex >= 0);
        downloadsManifestPath = args[pathIndex + 1];
        const record = Object.values(json.get(downloadsManifestPath) || {})[0];
        assert.equal(record.url, config.pythonBuild.url);
        assert.equal(record.sha256, config.pythonBuild.sha256);
        assert.equal(record.build, config.pythonBuild.release);
        assert.equal(record.os, "linux");
        assert.equal(record.arch.family, "aarch64");
        assert.equal(record.libc, "gnu");
        const root = args[args.indexOf("--install-dir") + 1];
        const installDir = `${root}/cpython-3.13.15-linux-aarch64-gnu`;
        directories.add(installDir);
        directories.add(`${installDir}/bin`);
        pythonExecutable = `${installDir}/bin/python3.13`;
        files.add(pythonExecutable);
        return { exitCode: 0 };
      }
      assert.equal(executable, pythonExecutable);
      const probePath = args[1].match(/pathlib\.Path\(("(?:\\.|[^"])*")\)/)?.[1];
      assert(probePath);
      const probe = JSON.parse(probePath);
      const installDir = `${staging}/python/cpython-3.13.15-linux-aarch64-gnu`;
      const payload = { pythonVersion: "3.13.15", prefix: installDir, packageRoot: `${installDir}/lib/python3.13/site-packages` };
      files.add(probe);
      json.set(probe, payload);
      return { exitCode: 0 };
    };
    const result = await adapter.installPython({
      storage,
      staging,
      downloadAssetFromSources,
      extractZip,
      runProcess,
      readJSON: async (_storage, path) => json.get(path) || null,
      signal: null
    });
    assert.equal(result.pythonVersion, "3.13.15");
    assert.equal(result.executable, pythonExecutable);
    assert.equal(await storage.exists(result.packageRoot), true);
    assert.equal(await storage.exists(`${staging}/python-downloads.json`), false);
    assert.equal(await storage.exists(`${staging}/uv-0.12.18.tar.gz`), false);
    assert.equal(await storage.exists(`${staging}/uv-bootstrap`), false);
    assert.equal(await storage.exists(`${staging}/python-path-probe.json`), false);
  }

  async function testAcquisitionRunnerSharesRuntimePreflight() {
    let ensureCalls = 0;
    let providerEnsureCalls = 0;
    let forwardedPreflight = null;
    const runtimeResult = { available: false, diagnostics: "fixture-runtime-unavailable" };
    const runtime = {
      ensure: async () => { ensureCalls += 1; return runtimeResult; },
      storage: { root: "/mem/runtime-preflight" },
      manifest: Agent.AcquisitionRuntimeManifest.manifest()
    };
    const facade = Object.create(Agent.AgentFacade.prototype);
    facade.acquisition = {
      runtime,
      acquirePapers: async (_candidates, options) => {
        forwardedPreflight = options[Agent.RuntimePreflightToken];
        return { results: [] };
      }
    };
    const runner = facade.acquisitionRunner({ candidates: [{ local: { hasFullText: false } }], parse: false });
    const result = await runner({ signal: null, emit() {} });
    assert.equal(ensureCalls, 1);
    assert.equal(forwardedPreflight, runtimeResult);
    assert.equal(result.runtime, runtimeResult);

    const provider = new Agent.ScanSciProvider({ ...runtime, ensure: async () => { providerEnsureCalls += 1; throw new Error("duplicate bootstrap"); } }, { client: { call: async () => ({}) } });
    const acquired = await provider.acquire({ identifiers: { arxiv: "2401.00001" } }, { [Agent.RuntimePreflightToken]: forwardedPreflight });
    assert.equal(providerEnsureCalls, 0);
    assert.equal(acquired.status, "unavailable");
    assert.equal(acquired.diagnostics, "fixture-runtime-unavailable");
  }

  async function testManagedRuntimeProcessTimeoutKillsProcess() {
    const originalCc = context.Cc;
    const originalCi = context.Ci;
    let killed = 0;
    const process = {
      init() {},
      runAsync() {},
      kill() { killed += 1; }
    };
    context.Ci = { nsIProcess: function nsIProcess() {}, nsIFile: function nsIFile() {} };
    context.Cc = {
      "@mozilla.org/process/util;1": { createInstance() { return process; } },
      "@mozilla.org/file/local;1": { createInstance() { return { initWithPath() {} }; } }
    };
    try {
      await assert.rejects(Agent.ManagedRuntimeInternals.runProcess("C:/runtime/python.exe", [], { timeoutMs: 5 }), /执行超时/);
      assert.equal(killed, 1);
    }
    finally {
      context.Cc = originalCc;
      context.Ci = originalCi;
    }
  }

  async function testAcquisitionReusesExistingAttachmentBeforeDownload() {
    const item = { id: 11, key: "ITEMKEY", libraryID: 1 };
    const attachment = { id: 22, key: "ATTKEY" };
    const originalValidateFile = Agent.PDFValidator.validateFile;
    let downloads = 0;
    Agent.PDFValidator.validateFile = async () => ({ valid: true, size: 100, pageCount: 1, signature: "PDF" });
    try {
      const service = Object.create(Agent.PaperAcquisitionService.prototype);
      service.library = {
        resolveItem: async ref => String(ref) === item.key ? item : null,
        resolveAttachment: async parent => parent === item ? attachment : null,
        itemRecord: async parent => ({ key: parent.key, title: "Existing paper" })
      };
      service.importer = {};
      service.controller = { attachmentPath: async value => value === attachment ? "/existing.pdf" : "" };
      service.init = async () => {};
      service.upsertPaperCard = async () => {};
      service.providerAcquire = async () => { downloads += 1; throw new Error("existing attachment should short-circuit acquisition"); };
      const result = await service.acquirePaper({ local: { itemKey: item.key, libraryID: 1 } }, {});
      assert.equal(result.status, "available");
      assert.equal(result.reused, true);
      assert.equal(result.attachment.key, attachment.key);
      assert.equal(result.provenance.source, "existing-zotero");
      assert.equal(downloads, 0);
    }
    finally { Agent.PDFValidator.validateFile = originalValidateFile; }
  }

  async function testStandaloneAttachmentCleanedUpIfSaveEntityFails() {
    const originalValidateFile = Agent.PDFValidator.validateFile;
    const originalGlobalZotero = global.Zotero;
    const originalGlobalLitMTrans = global.LitMTrans;
    const originalContextZotero = context.Zotero;

    Agent.PDFValidator.validateFile = async () => ({ valid: true, size: 100, pageCount: 1, signature: "PDF" });

    let erased = false;
    const fakeStandaloneAttachment = {
      id: 999,
      key: "STANDALONE_ATT",
      parentID: false,
      attachmentFilename: "test.pdf",
      eraseTx: async () => { erased = true; }
    };

    const mockZotero = {
      Attachments: {
        importFromFile: async () => fakeStandaloneAttachment
      },
      RecognizeDocument: {
        canRecognize: () => false,
        recognizeItems: async () => {}
      }
    };
    global.Zotero = mockZotero;
    context.Zotero = mockZotero;
    const originalCreateLocalFile = context.LitMTrans?.Utils?.createLocalFile;
    if (context.LitMTrans?.Utils) {
      context.LitMTrans.Utils.createLocalFile = path => ({ path });
    }

    try {
      const parentItem = { id: 888, key: "PARENT_ITEM" };
      const service = Object.create(Agent.PaperAcquisitionService.prototype);
      service.library = {
        resolveItem: async ref => String(ref) === parentItem.key || String(ref) === String(parentItem.id) ? parentItem : null,
        saveEntity: async entity => {
          if (entity === fakeStandaloneAttachment) {
            throw new Error("Disk full: failed to save attached entity");
          }
        },
        itemRecord: async () => ({ key: parentItem.key, title: "Test Paper" })
      };
      service.importer = {
        addByDOI: async () => ({ item: parentItem })
      };
      service.cleanupStaged = async () => false;
      service.init = async () => {};
      service.upsertPaperCard = async () => {};
      service.providerAcquire = async () => ({ status: "available", path: "/mock/downloaded.pdf", size: 100 });

      let caught = null;
      try {
        await service.acquirePaper({ identifiers: { doi: "10.1000/fixture" } }, {});
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, "acquirePaper should throw when attachment save fails");
      assert.equal(caught.message, "Disk full: failed to save attached entity");
      assert.equal(erased, true, "standalone attachment should be erased when saveEntity throws");
      assert.equal(fakeStandaloneAttachment.parentID, false, "standalone attachment parentID should be reset to false before erase");
    }
    finally {
      Agent.PDFValidator.validateFile = originalValidateFile;
      global.Zotero = originalGlobalZotero;
      global.LitMTrans = originalGlobalLitMTrans;
      context.Zotero = originalContextZotero;
      if (context.LitMTrans?.Utils) {
        context.LitMTrans.Utils.createLocalFile = originalCreateLocalFile;
      }
    }
  }

  async function testFallbackTaskAbortSignalSupportsListeners() {
    const original = context.AbortController;
    context.AbortController = undefined;
    try {
      const storage = new MemoryStorage(); storage.root = "/mem/profile/fallback-abort";
      const tasks = new Agent.AgentTaskManager(storage); await tasks.init();
      let abortObserved = false;
      const job = tasks.start("abort-fixture", {}, ({ signal }) => new Promise((_resolve, reject) => {
        assert.equal(typeof signal.addEventListener, "function");
        signal.addEventListener("abort", () => { abortObserved = true; reject(new Error("cancelled by fixture")); }, { once: true });
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
      tasks.cancel(job.id);
      for (let index = 0; index < 20 && tasks.raw(job.id)?.status === "running"; index++) await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(abortObserved, true);
      assert.equal(tasks.raw(job.id).status, "cancelled");
    }
    finally { context.AbortController = original; }
  }

  async function testManagedRuntimeSingleFlightAndHealthTTL() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/runtime-single-flight";
    let installs = 0;
    let healthChecks = 0;
    const runtime = new Agent.ManagedRuntimeManager(storage, {
      platformDescriptor: Agent.PlatformDescriptor.forTarget("windows-x64"),
      healthTTLms: 1000,
      bootstrap: async () => {
        installs += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { available: true, version: "1.17.0", runtimeVersion: "1.17.0-windows-x64-py31315", executable: "C:/runtime/python.exe" };
      },
      healthCheck: async () => { healthChecks += 1; return true; }
    });
    const results = await Promise.all([runtime.ensure(), runtime.ensure(), runtime.ensure()]);
    assert(results.every(row => row.available));
    assert.equal(installs, 1);
    runtime.invalidateHealth("fixture");
    await runtime.ensure();
    assert.equal(healthChecks, 1);
    await new Promise(resolve => setTimeout(resolve, 1025));
    await runtime.ensure();
    assert.equal(healthChecks, 2);
  }

  async function testManagedRuntimePromotionRetriesTransientMoveFailure() {
    const source = "/mem/profile/runtime/.acquisition-staging-generation";
    const destination = "/mem/profile/runtime/acquisition";
    const paths = new Set([source]);
    const storage = { async exists(path) { return paths.has(path); } };
    let moveAttempts = 0;
    await Agent.ManagedRuntimeInternals.moveRuntimeDirectoryWithRetry(source, destination, storage, {
      retryDelays: [0, 0],
      move: async (from, to, options) => {
        moveAttempts++;
        assert.equal(from, source);
        assert.equal(to, destination);
        assert.deepEqual(options, { noOverwrite: true });
        if (moveAttempts < 3) throw new Error("NS_ERROR_FAILURE");
        paths.delete(source);
        paths.add(destination);
      }
    });
    assert.equal(moveAttempts, 3);
    assert.equal(await storage.exists(source), false);
    assert.equal(await storage.exists(destination), true);

    paths.add(source);
    let unexpectedMove = false;
    await assert.rejects(Agent.ManagedRuntimeInternals.moveRuntimeDirectoryWithRetry(source, destination, storage, {
      move: async () => { unexpectedMove = true; }
    }), /正式目录已存在，拒绝覆盖/);
    assert.equal(unexpectedMove, false);
  }

  async function testFullTextImportAlwaysReturnsJob() {
    const facade = Object.create(Agent.AgentFacade.prototype);
    facade.policy = { assert() {} };
    let batchOptions = null;
    facade.startAcquisitionBatch = async options => { batchOptions = options; return { id: "acq-job", kind: "acquisition" }; };
    facade.literature = { resolveCandidate: async value => ({ candidateID: value }) };
    facade.acquisition = { importPaper: async () => { throw new Error("metadata-only path should not run"); } };
    const job = await facade.invoke("literature_import", { candidateIDs: ["10.1000/job"], acquireFullText: true, parse: false });
    assert.equal(job.kind, "acquisition");
    assert.equal(batchOptions.parse, false);
    assert.equal(batchOptions.candidates.length, 1);
  }

  async function testInstitutionBridgeHighLevelContract() {
    const calls = [];
    const provider = {
      runtime: { ensure: async () => ({ available: true }) },
      client: {
        initialized: true,
        hasTools: names => names.every(name => ["scansci_pdf_channel_status", "scansci_pdf_schools", "scansci_pdf_login"].includes(name)),
        start: async () => ({ started: true }),
        call: async (name, input) => { calls.push({ name, input }); return { status: "ready", accessToken: "secret", nested: { cookie: "secret" } }; }
      }
    };
    const bridge = new Agent.ScanSciInstitutionAccessBridge(provider);
    assert.deepEqual(bridge.availableActions(), ["status", "schools", "login"]);
    const login = await bridge.invoke("login", { kind: "webvpn", doi: "10.1000/test", cookie_file: "C:/secret/cookies.json" });
    assert.equal(login.requiresUserAction, true);
    assert.equal(login.result.accessToken, "[REDACTED]");
    assert.equal(calls[0].name, "scansci_pdf_login");
    assert.deepEqual(calls[0].input, { kind: "webvpn", identifier: "10.1000/test" });
    assert.equal(calls[0].input.doi, undefined);
    assert.equal(calls[0].input.cookie_file, undefined);

    const failedLoginBridge = new Agent.ScanSciInstitutionAccessBridge({
      runtime: provider.runtime,
      client: {
        initialized: true,
        hasTools: () => true,
        start: async () => ({ started: true }),
        call: async () => ({ success: false, error: "WebVPN not configured", cookie: "secret" })
      }
    });
    const failedLogin = await failedLoginBridge.invoke("login", { kind: "webvpn" });
    assert.equal(failedLogin.status, "failed");
    assert.equal(failedLogin.code, "INSTITUTION_LOGIN_FAILED");
    assert.equal(failedLogin.reason, "WebVPN not configured");
    assert.equal(failedLogin.result.cookie, "[REDACTED]");

    const failedSchoolsBridge = new Agent.ScanSciInstitutionAccessBridge({
      runtime: provider.runtime,
      client: {
        initialized: true,
        hasTools: () => true,
        start: async () => ({ started: true }),
        call: async () => ({ error: "school lookup failed" })
      }
    });
    const failedSchools = await failedSchoolsBridge.invoke("schools");
    assert.equal(failedSchools.status, "failed");
    assert.equal(failedSchools.code, "INSTITUTION_ACCESS_FAILED");
    assert.equal(failedSchools.reason, "school lookup failed");

    const expectedManifest = Agent.AcquisitionRuntimeManifest.manifest();
    const preflightBridge = new Agent.ScanSciInstitutionAccessBridge({
      runtime: {
        platform: Agent.PlatformDescriptor.forTarget("windows-x64"),
        targetManifest: expectedManifest.targets["windows-x64"],
        manifest: expectedManifest
      },
      client: { initialized: false }
    });
    assert.deepEqual(preflightBridge.availableActions(), ["status", "schools", "login"]);
    const unsupportedBridge = new Agent.ScanSciInstitutionAccessBridge({
      runtime: {
        platform: Agent.PlatformDescriptor.forTarget("macos-arm64"),
        targetManifest: expectedManifest.targets["macos-arm64"],
        manifest: expectedManifest
      },
      client: { initialized: false }
    });
    assert.deepEqual(unsupportedBridge.availableActions(), []);
  }

  async function testInstitutionLoginThenRetryUsesVpnSci() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/institution-retry";
    const calls = [];
    let loginCompleted = false;
    const runtime = { storage, manifest: Agent.AcquisitionRuntimeManifest.manifest(), ensure: async () => ({ available: true }) };
    const client = {
      initialized: true,
      hasTools: names => names.every(name => ["scansci_pdf_login", "scansci_pdf_download"].includes(name)),
      start: async () => ({ started: true }),
      call: async (name, input) => {
        calls.push({ name, input });
        if (name === "scansci_pdf_login") { loginCompleted = true; return { status: "logged-in" }; }
        assert.equal(loginCompleted, true, "retry must follow completed institution login");
        return { success: true, file: "/mem/profile/institution-retry/staging/paper.pdf", doi: input.identifier };
      }
    };
    const provider = new Agent.ScanSciProvider(runtime, { client, validator: { validateFile: async () => ({ valid: true }) } });
    const facade = Object.create(Agent.AgentFacade.prototype);
    facade.policy = { assert() {} };
    facade.acquisition = { institutionAccess: (action, args) => provider.institutionAccess(action, args) };
    facade.literature = {
      resolveCandidate: async id => ({ candidateID: id, identifiers: { doi: id } }),
      seedCardFromIdentifier: id => ({ candidateID: id, identifiers: { doi: id } })
    };
    facade.startAcquisitionBatch = async options => provider.acquire(options.candidates[0], { outputDir: "/mem/profile/institution-retry/staging" });

    const login = await facade.invoke("fulltext_access", { action: "login", kind: "webvpn", doi: "10.1000/test" });
    assert.equal(login.status, "login-started");
    assert.equal(loginCompleted, true);
    const retry = await facade.invoke("fulltext_access", { action: "retry", candidateIDs: ["10.1000/test"], parse: false });
    assert.equal(retry.status, "available");
    assert.equal(calls[0].name, "scansci_pdf_login");
    assert.deepEqual(calls[0].input, { kind: "webvpn", identifier: "10.1000/test" });
    assert.equal(calls[1].name, "scansci_pdf_download");
    assert.equal(calls[1].input.use_vpnsci, true);
  }

  async function testFullTextRetryResolvesEveryCandidateID() {
    const facade = Object.create(Agent.AgentFacade.prototype);
    facade.policy = { assert() {} };
    const resolutions = [];
    const seeds = [];
    let batchOptions = null;
    facade.literature = {
      resolveCandidate: async id => { resolutions.push(id); return id.endsWith("resolved") ? { candidateID: id, source: "resolved" } : null; },
      seedCardFromIdentifier: id => { seeds.push(id); return { candidateID: id, source: "seeded" }; }
    };
    facade.startAcquisitionBatch = async options => { batchOptions = options; return { id: "retry-job" }; };
    const result = await facade.invoke("fulltext_access", { action: "retry", candidateIDs: ["10.1000/resolved", "10.1000/seed"] });
    assert.equal(result.id, "retry-job");
    assert.deepEqual(resolutions, ["10.1000/resolved", "10.1000/seed"]);
    assert.deepEqual(seeds, ["10.1000/seed"]);
    assert.deepEqual(batchOptions.candidates.map(candidate => candidate.source), ["resolved", "seeded"]);
  }

  async function testScanSciToolResultNormalizationAndRedaction() {
    const structured = Agent.normalizeScanSciToolResult({ result: { structuredContent: { ready: true, cookie_file: "C:/secret", access_token: "abc", token: "tok", password: "pw", authorization: "Bearer xyz", secret: "s", credential: "c" } } });
    assert.equal(structured.ready, true);
    for (const key of ["cookie_file", "access_token", "token", "password", "authorization", "secret", "credential"]) assert.equal(structured[key], "[REDACTED]");
    assert.equal(Agent.normalizeScanSciToolResult({ result: { content: [{ type: "text", text: JSON.stringify({ cookie_file: "C:/secret", access_token: "abc" }) }] } }).cookie_file, "[REDACTED]");
    assert.equal(Agent.normalizeScanSciToolResult({ result: { content: [{ type: "text", text: "status: ready" }] } }), "status: ready");
    const downloadPayload = JSON.stringify({ success: true, identifier: "2401.00001", file: "C:/staging/2401.00001.pdf", size_kb: 5674.1, source: "arXiv" });
    const structuredDownload = Agent.normalizeScanSciDownloadResult({ result: { structuredContent: { result: downloadPayload } } });
    assert.equal(structuredDownload.success, true);
    assert.equal(structuredDownload.path, "C:/staging/2401.00001.pdf");
    assert.equal(structuredDownload.source, "arXiv");
    const textDownload = Agent.normalizeScanSciDownloadResult({ result: { structuredContent: { text: downloadPayload } } });
    assert.equal(textDownload.success, true);
    assert.equal(textDownload.path, "C:/staging/2401.00001.pdf");
    const contentDownload = Agent.normalizeScanSciDownloadResult({ result: { content: [{ type: "text", text: downloadPayload }] } });
    assert.equal(contentDownload.success, true);
    assert.equal(contentDownload.path, "C:/staging/2401.00001.pdf");

    const client = new Agent.ScanSciMCPClient(null, {
      health: async () => true,
      request: async () => ({ result: { content: [{ type: "text", text: JSON.stringify({ ok: true, cookie_file: "C:/secret", access_token: "abc", password: "pw", authorization: "Bearer xyz", secret: "s", credential: "c", token: "tok" }) }] } })
    });
    client.started = true;
    client.initialized = true;
    client.availableTools.add("scansci_pdf_channel_status");
    const toolResult = await client.call("scansci_pdf_channel_status");
    const protocol = new Agent.MCPProtocol({ controller: { version: "2.0.0" }, invoke: async () => toolResult, tasks: { cancel() {} } });
    const response = await protocol.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "litmtrans_fulltext_access", arguments: { action: "status" } } });
    const serialized = JSON.stringify(response);
    for (const secret of ["C:/secret", "abc", "pw", "Bearer xyz", "\"s\"", "\"c\"", "\"tok\""]) assert.equal(serialized.includes(secret), false, "Agent response leaked " + secret);
    await client.shutdown();
  }

  async function testScanSciProxyEnvironmentMapping() {
    const values = new Map([
      ["HTTPS_PROXY", "http://127.0.0.1:7890"],
      ["HTTP_PROXY", "http://127.0.0.1:8080"]
    ]);
    const environment = { get: name => values.get(name) || "", set: (name, value) => values.set(name, value) };
    let launchProxy = "";
    const launched = Agent.ScanSciDownloadInternals.withScanSciProxyEnvironment(() => {
      launchProxy = environment.get("SCANSCI_PDF_PROXY");
      return true;
    }, environment);
    assert.equal(launched, true);
    assert.equal(launchProxy, "http://127.0.0.1:7890");
    assert.equal(environment.get("SCANSCI_PDF_PROXY"), "");

    values.set("SCANSCI_PDF_PROXY", "http://configured-proxy:9000");
    Agent.ScanSciDownloadInternals.withScanSciProxyEnvironment(() => {
      launchProxy = environment.get("SCANSCI_PDF_PROXY");
    }, environment);
    assert.equal(launchProxy, "http://configured-proxy:9000");
    assert.equal(environment.get("SCANSCI_PDF_PROXY"), "http://configured-proxy:9000");
  }

  async function testScanSciSilentServerLaunchSpec() {
    const resolve = Agent.ScanSciDownloadInternals.resolveServerLaunchSpec;
    assert.equal(typeof resolve, "function");

    // 1. Windows with pythonw.exe available: selects pythonw.exe and builds silent devnull bootstrap args
    const windowsSpec = resolve("C:/test/python/python.exe", 44123, {
      isWindows: true,
      fileExists: file => file.endsWith("pythonw.exe")
    });
    assert.equal(windowsSpec.executable, "C:/test/python/pythonw.exe");
    assert.equal(windowsSpec.args[0], "-c");
    assert.ok(windowsSpec.args[1].includes("devnull"));
    assert.ok(windowsSpec.args[1].includes("44123"));
    assert.ok(windowsSpec.args[1].includes("runpy.run_module"));

    // 2. Windows without pythonw.exe: falls back to original executable
    const fallbackSpec = resolve("C:/test/python/python.exe", 44123, {
      isWindows: true,
      fileExists: () => false
    });
    assert.equal(fallbackSpec.executable, "C:/test/python/python.exe");
    assert.deepEqual(fallbackSpec.args, ["-m", "scansci_pdf.main", "run", "--mode", "streamable_http", "--host", "127.0.0.1", "--port", "44123"]);

    // 3. Linux/macOS: keeps original python executable
    const unixSpec = resolve("/usr/bin/python3", 44123, {
      isWindows: false
    });
    assert.equal(unixSpec.executable, "/usr/bin/python3");
    assert.deepEqual(unixSpec.args, ["-m", "scansci_pdf.main", "run", "--mode", "streamable_http", "--host", "127.0.0.1", "--port", "44123"]);
  }

  async function testStorageRuntimeSummaryAndCacheCleanup() {
    const files = new Map();
    const removedPaths = [];
    const mockStorage = {
      root: "/mem/profile/litmtrans",
      tempRoot: "/mem/profile/litmtrans-tmp",
      documentsRoot: "/mem/profile/litmtrans/documents",
      runtimeRoot: "/mem/profile/litmtrans/runtime",
      formatBytes: bytes => `${bytes} B`,
      async exists(p) {
        if (p === "/mem/profile/litmtrans/runtime" || p === "/mem/profile/litmtrans/runtime/acquisition" || p === "/mem/profile/litmtrans/runtime/acquisition/python" || p === "/mem/profile/litmtrans/runtime/acquisition/python/Lib" || p === "/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages" || p === "/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages/__pycache__") return true;
        return files.has(p);
      },
      async list(dir) {
        if (dir === "/mem/profile/litmtrans/runtime") return ["/mem/profile/litmtrans/runtime/acquisition"];
        if (dir === "/mem/profile/litmtrans/runtime/acquisition") return [
          "/mem/profile/litmtrans/runtime/acquisition/python-embed.zip",
          "/mem/profile/litmtrans/runtime/acquisition/scansci-pdf.whl",
          "/mem/profile/litmtrans/runtime/acquisition/python"
        ];
        if (dir === "/mem/profile/litmtrans/runtime/acquisition/python") return [
          "/mem/profile/litmtrans/runtime/acquisition/python/python313.zip",
          "/mem/profile/litmtrans/runtime/acquisition/python/Lib"
        ];
        if (dir === "/mem/profile/litmtrans/runtime/acquisition/python/Lib") return [
          "/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages"
        ];
        if (dir === "/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages") return [
          "/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages/__pycache__"
        ];
        if (dir === "/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages/__pycache__") return [
          "/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages/__pycache__/test.cpython-313.pyc"
        ];
        return [];
      },
      async stat(p) {
        if (p.endsWith(".zip") || p.endsWith(".whl") || p.endsWith(".pyc")) {
          return { type: "regular", size: 100 };
        }
        return { type: "directory" };
      },
      async dirStats(p) {
        if (p.endsWith("__pycache__")) return { bytes: 100, files: 1, formatted: "100 B" };
        if (p.endsWith("runtime")) return { bytes: 400, files: 4, formatted: "400 B" };
        return { bytes: 0, files: 0, formatted: "0 B" };
      },
      async remove(p) {
        removedPaths.push(p);
        files.delete(p);
      }
    };

    files.set("/mem/profile/litmtrans/runtime/acquisition/python-embed.zip", "zip");
    files.set("/mem/profile/litmtrans/runtime/acquisition/scansci-pdf.whl", "whl");
    files.set("/mem/profile/litmtrans/runtime/acquisition/python/python313.zip", "keep-me");
    files.set("/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages/__pycache__/test.cpython-313.pyc", "pyc");

    const clearRes = await context.LitMTrans.Storage.prototype.clearRuntimeCache.call(mockStorage);
    assert.ok(clearRes.clearedBytes > 0);
    // python313.zip must NOT be removed
    assert.ok(!removedPaths.includes("/mem/profile/litmtrans/runtime/acquisition/python/python313.zip"));
    // python-embed.zip and scansci-pdf.whl must be removed
    assert.ok(removedPaths.includes("/mem/profile/litmtrans/runtime/acquisition/python-embed.zip"));
    assert.ok(removedPaths.includes("/mem/profile/litmtrans/runtime/acquisition/scansci-pdf.whl"));
    assert.ok(removedPaths.includes("/mem/profile/litmtrans/runtime/acquisition/python/Lib/site-packages/__pycache__"));
  }

  async function testAgentFacadeShutdownStopsAcquisitionImmediately() {
    const facade = Object.create(Agent.AgentFacade.prototype);
    const calls = [];
    let finishTasks;
    facade.tasks = { shutdown: () => { calls.push("tasks"); return new Promise(resolve => { finishTasks = resolve; }); } };
    facade.acquisition = { shutdown: async () => { calls.push("acquisition"); } };
    facade.literature = { shutdown: async () => { calls.push("literature"); } };
    const utils = context.LitMTrans.Utils;
    const previousProbe = utils.getPref("agentTestShutdownProbe", false);
    try {
      utils.setPref("agentTestShutdownProbe", true);
      utils.clearPref("agentTestShutdownProbeAcquisitionShutdownCompleted");
      const shutdown = facade.shutdown();
      assert.deepEqual(calls, ["tasks", "acquisition"]);
      assert.equal(utils.getPref("agentTestShutdownProbeAgentShutdownStarted", false), true);
      assert.equal(utils.getPref("agentTestShutdownProbeAcquisitionShutdownCompleted", false), false);
      finishTasks();
      await shutdown;
      assert.deepEqual(calls, ["tasks", "acquisition", "literature"]);
      assert.equal(utils.getPref("agentTestShutdownProbeAcquisitionShutdownCompleted", false), true);
    }
    finally {
      if (previousProbe) utils.setPref("agentTestShutdownProbe", previousProbe);
      else utils.clearPref("agentTestShutdownProbe");
      utils.clearPref("agentTestShutdownProbeAgentShutdownStarted");
      utils.clearPref("agentTestShutdownProbeAcquisitionShutdownCompleted");
    }
  }

  async function testAgentBackendShutdownDelegatesToFacade() {
    const backend = Object.create(Agent.AgentBackend.prototype);
    const calls = [];
    backend.server = { stop: () => calls.push("server") };
    backend.facade = { shutdown: async () => calls.push("facade") };
    await backend.shutdown();
    assert.deepEqual(calls, ["server", "facade"]);
  }

  async function testTargetRuntimeVersionAndClientInfo() {
    const manifest = Agent.AcquisitionRuntimeManifest.manifest();
    for (const target of ["macos-arm64", "linux-arm64-gnu"]) {
      const config = manifest.targets[target];
      const storage = new MemoryStorage(); storage.root = "/mem/profile/runtime-version-" + target;
      const statePath = storage.root + "/runtime/acquisition/state.json";
      await storage.writeJSON(statePath, { status: "installed", version: "1.17.0", target, runtimeVersion: manifest.acquisitionRuntimeVersion, healthResult: true, healthCheckedAt: Date.now() });
      const runtime = new Agent.ManagedRuntimeManager(storage, { manifest, platformDescriptor: Agent.PlatformDescriptor.forTarget(target), healthCheck: async () => true });
      await runtime.init();
      assert.equal(runtime.state.healthResult, null, target + " must invalidate a Windows-version health record");
      assert.equal(runtime.expectedRuntimeVersion(), config.runtimeVersion);
      runtime.state.runtimeVersion = config.runtimeVersion;
      assert.equal(await runtime.isHealthy(), true);

      const versions = [];
      const client = new Agent.ScanSciMCPClient({ manifest, platform: { target }, targetManifest: config }, {
        request: async (_endpoint, payload) => {
          if (payload.method === "initialize") { versions.push(payload.params.clientInfo.version); return { result: {} }; }
          if (payload.method === "tools/list") return { result: { tools: [] } };
          return { result: {} };
        }
      });
      await client.initialize();
      assert.deepEqual(versions, [config.runtimeVersion]);
      await client.shutdown();
    }
  }

  async function testUvMirrorFallbackWhenGitHubUnavailable() {
    const http = context.LitMTrans.HTTP;
    const utils = context.LitMTrans.Utils;
    const originalRequestBytes = http.requestBytes;
    const originalSha256Bytes = utils.sha256Bytes;
    const requests = [];
    const written = [];
    const storage = { writeBytes: async (path, bytes) => { written.push({ path, bytes: Array.from(bytes) }); } };
    http.requestBytes = async url => {
      requests.push(url);
      if (url.includes("github.com")) throw new Error("fixture: GitHub unavailable");
      return new Uint8Array([1, 2, 3]);
    };
    utils.sha256Bytes = async () => "abc123";
    try {
      const result = await Agent.ManagedRuntimeInternals.downloadAssetFromSources([
        "https://github.com/astral-sh/uv/releases/download/0.12.18/uv-test.zip",
        "https://releases.astral.sh/github/uv/releases/download/0.12.18/uv-test.zip"
      ], "/mem/profile/uv-test.zip", storage, "abc123");
      assert.deepEqual(requests, ["https://github.com/astral-sh/uv/releases/download/0.12.18/uv-test.zip", "https://releases.astral.sh/github/uv/releases/download/0.12.18/uv-test.zip"]);
      assert.equal(result.sha256, "abc123");
      assert.deepEqual(written[0], { path: "/mem/profile/uv-test.zip", bytes: [1, 2, 3] });
    }
    finally {
      http.requestBytes = originalRequestBytes;
      utils.sha256Bytes = originalSha256Bytes;
    }
  }

  async function testPaperCardDeletionIdentityContract() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/paper-card-delete";
    const index = new Agent.PaperCardIndex({ storage }, { allItems: async () => [] });
    index.rows = [
      { local: { itemID: 101, parentItemID: 101, attachmentID: 202, documentID: "1-ATT" }, identifiers: { doi: "10.1000/delete" }, litmtrans: { hasAttachment: true, parsed: true } },
      { local: { itemID: 102, parentItemID: 102, attachmentID: 203, documentID: "1-OTHER" }, identifiers: {}, litmtrans: { hasAttachment: true, parsed: true } }
    ];
    const removedParent = await index.removeDocument(101);
    assert.equal(removedParent.removed, true);
    assert.equal(index.rows.length, 1);
    const updatedAttachment = await index.removeDocumentStatus("1-OTHER");
    assert.equal(updatedAttachment.litmtrans.hasAttachment, false);
    assert.equal(updatedAttachment.litmtrans.parsed, false);
  }

  async function testReviewWorkspaceHonesty() {
    const storage = new MemoryStorage(); storage.root = "/mem/profile/review-honest";
    const review = new Agent.ReviewWorkspaceService({ storage });
    const workspace = await review.create({ question: "A review question" });
    assert.equal(workspace.analysis.status, "external-agent-required");
    assert.equal(workspace.analysis.generated, false);
    assert.equal(workspace.claims.length, 0);
    assert.equal(workspace.draftArtifacts.length, 0);
  }

  return {
    testContractsAndPolicy,
    testProtocolHandshakeAndToolContract,
    testExtendedToolsetsAndResponseRedaction,
    testImportAndCitationHelpers,
    testTaskPersistenceAndCancellation,
    testClientCoexistence,
    testMcpPortFallback,
    testModernLegacyProtocolAndApproval,
    testApprovalPersistenceAndBackgroundProfile,
    testBackgroundChatUsesAPIWhileWorkbenchUsesWeb,
    testBoundedPoolAndParentCancellation,
    testApprovalScopeAndBatchCounts,
    testDiagramCacheBidirectionalContract,
    testExportPolicyAndCollectionPagination,
    testChatEditRouting,
    testBatchResolverAfterRestart,
    testHttpReaderContract,
    testWriteCoordinatorAndFormatters,
    testLiteratureDiscoveryAcquisitionReview,
    testPaperCardSQLiteBackend,
    testSearchFieldsAndBootstrap,
    testPaperCardLightweightStatus,
    testCacheClearStatusSemantics,
    testPaperCardIncrementalStatusAndPreservation,
    testCreatorNormalizationAndOpenAlexImport,
    testSQLiteScanModeLifecycle,
    testOfficialProviderShapes,
    testScanSciProviderContract,
    testScanSciFailureIsNotMaskedByTranslatorFallback,
    testLiteratureFiltersSeedsAndGraphIsolation,
    testManagedRuntimeRollbackAndScanSciClient,
    testDirectOaStagingAndSizeLimit,
    testAcquisitionBatchApprovalAndChildren,
    testAcquisitionTargetAndSemverContracts,
    testUvManagedPythonAdapterPinsAndCleansBootstrap,
    testAcquisitionRunnerSharesRuntimePreflight,
      testManagedRuntimeProcessTimeoutKillsProcess,
      testAcquisitionReusesExistingAttachmentBeforeDownload,
      testStandaloneAttachmentCleanedUpIfSaveEntityFails,
    testFallbackTaskAbortSignalSupportsListeners,
    testManagedRuntimeSingleFlightAndHealthTTL,
    testManagedRuntimePromotionRetriesTransientMoveFailure,
    testFullTextImportAlwaysReturnsJob,
    testInstitutionBridgeHighLevelContract,
    testInstitutionLoginThenRetryUsesVpnSci,
    testFullTextRetryResolvesEveryCandidateID,
    testScanSciToolResultNormalizationAndRedaction,
    testScanSciProxyEnvironmentMapping,
    testScanSciSilentServerLaunchSpec,
    testStorageRuntimeSummaryAndCacheCleanup,
    testAgentFacadeShutdownStopsAcquisitionImmediately,
    testAgentBackendShutdownDelegatesToFacade,
    testTargetRuntimeVersionAndClientInfo,
    testUvMirrorFallbackWhenGitHubUnavailable,
    testPaperCardDeletionIdentityContract,
    testReviewWorkspaceHonesty
  };
};
