"use strict";

module.exports = function (env) {
  const { assert, context, MemoryStorage, LayoutTranslationService, DocumentPipeline, U, fs, path, root, vm } = env;
  const { DOMParser } = require("linkedom");
  const T = context.LitMTrans.LayoutTables;
  const html = '<table><tr><th>Parameter</th><th>Value</th><th>Unit</th></tr><tr><td rowspan="2">Wind speed</td><td>12.5</td><td>mm</td></tr><tr><td>$v_0$</td><td>m/s</td></tr></table>';
  const payload = value => ({ pdf_info: [{ page_size: [600, 800], preproc_blocks: [{ type: "table", bbox: [40, 100, 550, 250], blocks: [
    { type: "table_body", bbox: [40, 100, 550, 250], image_path: "images/table.png", lines: [{ spans: [{ html: value }] }] }
  ] }] }] });

  function gridAndProtection() {
    const table = T.parseGrid(html, DOMParser);
    assert.equal(table.rows, 3);
    assert.equal(table.columns, 3);
    assert.equal(table.cells[3].rowspan, 2);
    assert.equal(table.cells[6].column, 1);
    assert.equal(table.cells.filter(cell => cell.translate).length, 4);
    const values = { 0: "参数", 1: "数值", 2: "单位", 3: "风速" };
    const rendered = T.render(table, values);
    assert.ok(rendered.includes('rowspan="2"'));
    assert.ok(rendered.includes("12.5"));
    assert.ok(rendered.includes("litmtrans-math"));
    assert.throws(() => T.render(table, { ...values, 3: "" }));
    const cell = T.parseGrid('<table><tr><td>Rate 12 $x$<br/>CO<sub>2</sub></td></tr></table>', DOMParser).cells[0];
    assert.equal(cell.tokens.length, 3);
    assert.equal(T.validText(cell, cell.text.replace("Rate", "速率")), true);
    assert.equal(T.validText(cell, cell.text + "13"), true);
    assert.equal(T.validText(cell, cell.text.replace("\n", " ")), true);
    assert.equal(T.validText(cell, cell.text + "译".repeat(2000)), true);
    assert.equal(T.validText(cell, cell.text + "⟦99⟧"), false);
    const emptyGrid = T.parseGrid('<table><tr><td>Label</td><td></td></tr></table>', DOMParser);
    assert.equal(emptyGrid.cells[1].translate, false);
    assert.ok(T.render(emptyGrid, { 0: "标签" }).includes('<td class="layout-table-fixed-cell" rowspan="1" colspan="1"></td>'));
    assert.equal(T.validText(emptyGrid.cells[1], ""), true);
    assert.equal(T.validText(cell, cell.text.replace("⟦0⟧", "")), false);
    const hostile = T.render(table, { ...values, 3: '<img src=x onerror="alert()">' });
    assert.ok(!hostile.includes("<img"));
  }

  function paddedCachedTableFormulasRender() {
    const grid = T.parseGrid('<table><tr><td>$ \\sigma_e $</td><td>Variance $ \\sigma_\\alpha^2 $ at angle $ \\alpha $</td></tr></table>', DOMParser);
    const table = { ...grid, page: 0, bbox: [0, 0, 300, 100], translations: { 1: grid.cells[1].text.replace("Variance", "方差").replace("at angle", "方位角") } };
    const cache = { version: 1, sourceFingerprint: "source", tables: [table] };
    const before = JSON.stringify(cache);
    const source = { sourceFingerprint: "source", pages: [{ blocks: [{ type: "table_body", bbox: table.bbox }] }] };
    const attached = T.attach(source, cache);
    const rendered = attached.pages[0].blocks[0].translatedTableHTML;
    assert.equal((rendered.match(/litmtrans-math-inline/g) || []).length, 3);
    const visibleText = new DOMParser().parseFromString(rendered, "text/html").querySelector("table").textContent;
    assert.ok(!visibleText.includes('$ \\sigma'));
    assert.ok(rendered.includes("方差") && rendered.includes("方位角"));
    assert.equal(JSON.stringify(cache), before, "formula display repairs must not alter existing table caches");
    assert.notEqual(attached.tableTranslationHash, U.hashString(JSON.stringify(cache)), "old layout measurements must not survive a formula renderer change");
  }

  function rejectUncertainStructures() {
    for (const source of [
      '<table><tr><td rowspan="0">Text</td></tr></table>',
      '<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>',
      '<table><tr><td rowspan="2">A</td><td>B</td></tr></table>',
      '<table><tr><td><table><tr><td>A</td></tr></table></td></tr></table>',
      '<table><tr><td><img src="forest.png"/></td></tr></table>',
      '<table><tr><td><svg></svg></td></tr></table>',
      '<table><tr><td>A</td><td rowspan="2">B</td></tr><tr><td colspan="2">C</td></tr></table>'
    ]) assert.equal(T.parseGrid(source, DOMParser), null, source);
    const raw = payload(html);
    const snapshot = JSON.stringify(raw);
    assert.equal(T.extract({ pages: raw.pdf_info }, DOMParser).length, 1);
    assert.equal(JSON.stringify(raw), snapshot);
    raw.pdf_info[0].preproc_blocks[0].type = "chart";
    assert.equal(T.extract({ pages: raw.pdf_info }, DOMParser).length, 0);
    const figure = payload(html);
    figure.pdf_info[0].preproc_blocks[0].blocks.push({ type: "table_caption", lines: [{ spans: [{ content: "Fig 2. Forest plot" }] }] });
    assert.equal(T.extract({ pages: figure.pdf_info }, DOMParser).length, 0);
    const forest = payload('<table><tr><td>Study or Subgroup</td><td>Hazard Ratio IV, Random, 95% CI</td></tr><tr><td>Study A</td><td>0.5</td></tr></table>');
    assert.equal(T.extract({ pages: forest.pdf_info }, DOMParser).length, 0);
  }

  function sharedService(source = html) {
    const storage = new MemoryStorage();
    storage.writeTextAtomically = async (path, text) => storage.writeJSON(path, JSON.parse(text));
    const documentID = "shared-table";
    const data = payload(source), raw = JSON.stringify(data);
    storage.text.set(storage.path(documentID, "layout.json"), raw);
    const calls = [];
    const settings = { provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-chat", targetLanguage: "简体中文", enableUntranslatedCheck: false, deepseekFastLayoutTranslation: false };
    const llm = { getSettings: () => settings, resolveConfig: options => options, ensureConfiguredModel: async options => options,
      complete: async messages => {
        const blocks = JSON.parse(messages[1].content.split("Input blocks JSON:\n").at(-1)).blocks;
        calls.push(blocks);
        return { text: JSON.stringify({ translations: blocks.map(block => block.type === "table_cells"
          ? { id: block.id, cells: block.cells.map(([index, text]) => [index, ({ Parameter: "参数", Value: "数值", Unit: "单位", "Wind speed": "风速" })[text] || text.replace("Parameter", "参数")]) }
          : { id: block.id, text: "这是正常的正文译文。" }) }) };
      }
    };
    const service = new LayoutTranslationService(storage, llm);
    service.loadLayout = async () => ({ rawText: raw, payload: data, pages: data.pdf_info, modelPages: [] });
    service.extractRecords = async () => [{ id: "p1", page: 1, type: "text", text: "A source paragraph." }];
    service.buildModel = async () => ({ sourceFingerprint: U.hashString(raw), pages: [{ blocks: [{ type: "table_body", bbox: [40, 100, 550, 250] }] }] });
    return { storage, documentID, raw, calls, settings, llm, service };
  }

  async function translationAndCache() {
    context.DOMParser = DOMParser;
    try {
      const { storage, documentID, raw, calls, service, settings } = sharedService();
      await service.translate(documentID, { translateTables: false });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].length, 1);
      const result = await service.translate(documentID);
      assert.equal(calls.length, 2, "enabling tables must still use only one full-context translation request");
      assert.equal(calls[1].length, 2);
      const table = calls[1].find(block => block.type === "table_cells");
      assert.equal(table.cells.length, 4, "numbers, formulas and units must not consume request items");
      assert.ok(table.cells.every(([index]) => Number.isInteger(index)));
      assert.deepEqual(Object.keys(result.translations), ["p1"]);
      const paths = service.paths(documentID, settings.targetLanguage);
      assert.deepEqual(Object.keys(await storage.readJSON(paths.translations)), ["p1"], "table records must stay out of body checkpoints");
      const cache = await storage.readJSON(paths.tables);
      assert.equal(cache.tables.length, 1);
      assert.equal(cache.sourceFingerprint, U.hashString(raw));
      assert.equal(await storage.readText(storage.path(documentID, "layout.json")), raw);
      const cached = await service.translate(documentID);
      assert.equal(cached.cached, true);
      assert.equal(calls.length, 2, "cache hits must issue no requests");
      const model = { sourceFingerprint: U.hashString(raw), pages: [{ blocks: [{ type: "table_body", bbox: [40, 100, 550, 250] }] }] };
      const attached = T.attach(model, cache);
      assert.ok(attached.pages[0].blocks[0].translatedTableHTML.includes("风速"));
      assert.ok(attached.pages[0].blocks[0].originalTableHTML.includes("Wind speed"));
      assert.ok(!attached.pages[0].blocks[0].originalTableHTML.includes("风速"));
      assert.ok(attached.pages[0].blocks[0].originalTableHTML.includes("12.5"));
      assert.equal(model.pages[0].blocks[0].translatedTableHTML, undefined);
      assert.equal(T.attach({ ...model, sourceFingerprint: "changed" }, cache).tableTranslationHash, undefined);
      const cleared = T.attach(attached, { ...cache, tables: [] });
      assert.equal(cleared.pages[0].blocks[0].translatedTableHTML, undefined);
      assert.equal(cleared.pages[0].blocks[0].originalTableHTML, undefined);
      assert.equal(cleared.tableTranslationHash, undefined);
      await service.translate(documentID, { translateTables: false });
      assert.equal((await storage.readJSON(paths.tables)).tables.length, 1, "disabling table translation must retain reusable translations");
      assert.equal(calls.length, 3);
    } finally { delete context.DOMParser; }
  }

  function paddlePreservesStructure() {
    const source = { schema: context.LitMTrans.ParserModel.SCHEMA, pages: [{ width: 600, height: 800, blocks: [{ id: "p1-table", type: "table", role: "table",
      bbox: [40, 100, 550, 250], text: html, asset: "assets/table.png", sequence: 0 }] }] };
    const projected = context.LitMTrans.ParserModel.projectLayout(source);
    assert.equal(projected.pdf_info[0].preproc_blocks[0].blocks[0].lines[0].spans[0].html, html);
    assert.equal(T.extract({ pages: projected.pdf_info }, DOMParser).length, 1);
  }

  async function legacyPaddleTablePipeline() {
    context.DOMParser = DOMParser;
    try {
      const { storage, service, documentID, settings, calls } = sharedService();
      const parsed = { schema: context.LitMTrans.ParserModel.SCHEMA, pages: [{ width: 600, height: 800, blocks: [
        { id: "p1-table", type: "table", role: "table", bbox: [40, 100, 550, 250], text: html, asset: "images/table.png", sequence: 0 }
      ] }] };
      const legacy = context.LitMTrans.ParserModel.projectLayout(parsed);
      legacy.pdf_info[0].preproc_blocks[0].blocks[0].lines = [];
      const raw = JSON.stringify(legacy);
      const parsedPath = storage.path(documentID, "parsed-document.v1.json");
      storage.text.set(storage.path(documentID, "layout.json"), raw);
      await storage.writeJSON(parsedPath, parsed);
      const originalParsed = JSON.stringify(await storage.readJSON(parsedPath));
      service.loadLayout = LayoutTranslationService.prototype.loadLayout;
      const loaded = await service.loadLayout(documentID);
      assert.equal(loaded.rawText, raw, "runtime recovery must preserve existing source fingerprints");
      assert.equal(T.extract(loaded, DOMParser).length, 1);
      await service.translate(documentID);
      assert.equal(calls.length, 1, "legacy tables must share the normal body request");
      assert.equal(calls[0].filter(block => block.type === "table_cells").length, 1);
      const cache = await storage.readJSON(service.paths(documentID, settings.targetLanguage).tables);
      assert.equal(cache.tables.length, 1);
      const attached = T.attach({ sourceFingerprint: U.hashString(raw), pages: [{ blocks: [
        { type: "table_body", bbox: [40, 100, 550, 250] }
      ] }] }, cache);
      assert.ok(attached.pages[0].blocks[0].translatedTableHTML.includes("风速"));
      assert.equal(await storage.readText(storage.path(documentID, "layout.json")), raw);
      assert.equal(JSON.stringify(await storage.readJSON(parsedPath)), originalParsed);
      assert.equal(JSON.stringify(T.restoreLegacyStructure(loaded.payload, parsed)), JSON.stringify(loaded.payload), "existing HTML must remain unchanged");
      for (const change of [
        doc => { doc.pages[0].blocks[0].id = "different-table"; },
        doc => { doc.pages[0].blocks[0].bbox[0]++; },
        doc => { doc.pages[0].blocks[0].asset = "images/other.png"; },
        doc => { doc.pages[0].blocks[0].role = "chart"; },
        doc => { doc.pages[0].width++; },
        doc => { doc.pages[0].blocks.push({ ...doc.pages[0].blocks[0] }); }
      ]) {
        const mismatch = JSON.parse(JSON.stringify(parsed));
        change(mismatch);
        assert.equal(T.extract({ pages: T.restoreLegacyStructure(legacy, mismatch).pdf_info }, DOMParser).length, 0,
          "ambiguous or stale source data must not add table translation targets");
      }
      await storage.writeJSON(parsedPath, null);
      assert.equal(T.extract(await service.loadLayout(documentID), DOMParser).length, 0);
    } finally { delete context.DOMParser; }
  }

  async function batchingAndCancellation() {
    context.DOMParser = DOMParser;
    try {
      const source = '<table>' + Array.from({ length: 181 }, (_, index) => `<tr><td>Parameter ${index}</td></tr>`).join('') + '</table>';
      const { storage, documentID, calls, service, settings, llm } = sharedService(source);
      await service.translate(documentID);
      assert.equal(calls.length, 1, "a large table must not create dedicated 80-cell requests");
      assert.equal(calls[0].find(block => block.type === "table_cells").cells.length, 181);
      const abort = new AbortController();
      llm.complete = async () => { abort.abort(); throw new Error("cancelled"); };
      await assert.rejects(() => service.translate(documentID, { force: true }, null, abort.signal));
      assert.equal((await storage.readJSON(service.paths(documentID, settings.targetLanguage).tables)).tables.length, 1);
    } finally { delete context.DOMParser; }
  }

  async function invalidTablesNeverAddRetries() {
    context.DOMParser = DOMParser;
    try {
      for (const mode of ["missing", "partial", "duplicate", "protected"]) {
        const source = mode === "protected" ? '<table><tr><td>Speed 12 $v$</td></tr></table>' : html;
        const { storage, documentID, service, settings, llm } = sharedService(source);
        let count = 0;
        llm.complete = async messages => {
          count++;
          const blocks = JSON.parse(messages[1].content.split("Input blocks JSON:\n").at(-1)).blocks;
          const table = blocks.find(block => block.type === "table_cells");
          const cells = mode === "partial" ? [[0, "参数"]]
            : mode === "duplicate" ? table.cells.map(() => [0, "参数"])
            : mode === "protected" ? [[0, "速度"]] : table.cells;
          return { text: JSON.stringify({ translations: [{ id: "p1", text: "这是正文译文。" }, ...(mode === "missing" ? [] : [{ id: table.id, cells }])] }) };
        };
        await service.translate(documentID);
        assert.equal(count, 1, mode);
        assert.equal((await storage.readJSON(service.paths(documentID, settings.targetLanguage).tables)).tables.length, 0, mode);
        assert.deepEqual(Object.keys(await storage.readJSON(service.paths(documentID, settings.targetLanguage).translations)), ["p1"]);
      }
    } finally { delete context.DOMParser; }
  }

  async function unchangedTableResponsesAreComplete() {
    context.DOMParser = DOMParser;
    try {
      const { service, documentID, storage, settings, llm } = sharedService();
      let calls = 0;
      llm.complete = async messages => {
        calls++;
        const blocks = JSON.parse(messages[1].content.split("Input blocks JSON:\n").at(-1)).blocks;
        return { text: JSON.stringify({ translations: blocks.map(block => block.type === "table_cells"
          ? { id: block.id, cells: block.cells } : { id: block.id, text: "这是正文译文。" }) }) };
      };
      await service.translate(documentID);
      const paths = service.paths(documentID, settings.targetLanguage);
      const cache = await storage.readJSON(paths.tables);
      assert.equal(cache.tables.length, 1, "complete unchanged responses must be published as translated tables");
      const table = cache.tables[0];
      assert.ok(table.cells.filter(cell => cell.translate).every(cell => table.translations[cell.index] === cell.text));
      const model = T.attach({ sourceFingerprint: cache.sourceFingerprint, pages: [{ blocks: [{ type: "table_body", bbox: table.bbox }] }] }, cache);
      assert.ok(model.pages[0].blocks[0].translatedTableHTML, "unchanged tables must be displayed through the translated table renderer");
      const input = await service.tableTranslationInput(documentID);
      assert.equal(input.missing.length, 0, "unchanged tables must not trigger the missing-translation prompt");
      await service.translateTablesOnly(documentID);
      await service.translate(documentID);
      assert.equal(calls, 1, "reopening or supplementing must reuse the unchanged result");
      const machine = T.requestPlan(input.layout, true, true);
      const unchanged = Object.fromEntries(machine.records.map(record => [record.id, record.text]));
      const machineCache = T.cacheFromRecords(machine, unchanged, cache.sourceFingerprint, settings.targetLanguage);
      assert.equal(machineCache.tables.length, 1, "machine translation must also accept unchanged complete results");
      assert.equal(Object.keys(T.cachedRecords(machine, machineCache, cache.sourceFingerprint)).length, machine.records.length);
    } finally { delete context.DOMParser; }
  }

  async function sharedMachineAndFastGrouping() {
    context.DOMParser = DOMParser;
    try {
      const { service, settings, documentID, storage } = sharedService();
      let calls = 0;
      service.webMachine = { translateRecords: async records => {
        calls++;
        assert.ok(records.some(record => record.id === "p1"));
        assert.equal(records.filter(record => record.type === "table_cell").length, 4);
        return Object.fromEntries(records.map(record => [record.id, record.id === "p1" ? "正文译文" : ({ Parameter: "参数", Value: "数值", Unit: "单位", "Wind speed": "风速" })[record.text]]));
      } };
      await service.translate(documentID, { provider: "free_machine" });
      await service.translate(documentID, { provider: "edge_local" });
      assert.equal(calls, 2, "machine tables and body must share one translateRecords invocation");
      assert.equal((await storage.readJSON(service.paths(documentID, settings.targetLanguage).tables)).tables.length, 1);
      const input = await service.loadLayout(documentID);
      const plan = T.requestPlan(input, true);
      const groups = service.fastGroupRecords([{ id: "p1", type: "text", text: "A short paragraph." }, ...plan.records]);
      assert.equal(groups.length, 1, "fast mode must not put tables in a separate supplementary request");
      assert.equal(groups[0].length, 2);
      const bodyAndCaption = [{ id: "p1", type: "text", text: "A short paragraph." },
        { id: "caption1", type: "table_caption", text: "Table 1. Parameters." }];
      const baseline = service.fastGroupRecords(bodyAndCaption);
      const withTables = service.fastGroupRecords([...bodyAndCaption, ...plan.records]);
      assert.deepEqual(withTables.map(group => group.filter(record => record.type !== "table_cells")).filter(group => group.length), baseline,
        "adding tables must preserve existing body and caption groups");
      assert.equal(withTables.flat().at(-1).type, "table_cells", "tables must follow captions in fast mode too");
    } finally { delete context.DOMParser; }
  }

  function manualPipeline(service, storage, settings) {
    return new DocumentPipeline({ storage, parser: { loadParsed: async () => ({ hasLayout: true }) }, layout: service,
      getSettings: () => settings, translation: {}, chat: {} });
  }

  async function manualCommandsMergeAndImport() {
    context.DOMParser = DOMParser;
    try {
      const { storage, service, settings, documentID, llm } = sharedService();
      llm.complete = () => { throw new Error("manual translation must never issue model requests"); };
      service.extractRecords = async () => [{ id: "p1", page: 1, type: "text", text: "First paragraph." }, { id: "p2", page: 1, type: "text", text: "Second paragraph." }];
      service.buildBaseModel = service.buildModel;
      service.buildModel = LayoutTranslationService.prototype.buildModel;
      const pipeline = manualPipeline(service, storage, settings);
      const ref = { documentID };
      const command = await pipeline.manualTranslationCommand(ref, "layout");
      const { records } = await service.manualTranslationInput(documentID);
      const table = records.find(record => record.type === "table_cells");
      assert.ok(command.includes('"cells"') && command.includes(table.id));
      const inputJSON = command.split("输入文本块 JSON：\n").at(-1);
      const inputBlocks = JSON.parse(inputJSON).blocks;
      assert.equal(inputBlocks.filter(block => block.type === "table_cells").length, 1);
      assert.equal(inputBlocks.at(-1).id, table.id);
      assert.ok(inputJSON.includes("    " + JSON.stringify(inputBlocks.at(-1))), "only the table record must stay on one line");
      assert.ok(!Object.hasOwn(inputBlocks.at(-1), "caption"), "table captions must not be repeated as untranslated context");
      const bodyBlocks = inputBlocks.filter(block => block.type !== "table_cells");
      assert.equal(service.formatRequestBlocks(bodyBlocks), JSON.stringify({ blocks: bodyBlocks }, null, 2));
      for (const block of bodyBlocks) {
        const formatted = JSON.stringify(block, null, 2).split("\n").map(line => "    " + line).join("\n");
        assert.ok(inputJSON.includes(formatted), "body formatting must stay unchanged when tables are added");
      }
      const values = ["参数", "数值", "单位", "风速"];
      const row = { id: table.id, cells: table.cells.map(([index]) => [index, values[index]]) };
      const partial = '```text\n' + JSON.stringify(row) + '\n' + JSON.stringify({ id: "p1", text: "第一段译文。" }) + '\n{"id":"p2","text":"unfinished';
      const merged = await pipeline.mergeManualTranslationResponse(ref, "layout", {}, partial);
      assert.ok(merged.translations[table.id]);
      assert.equal(merged.totalBlocks, 3);
      await assert.rejects(() => pipeline.importManualTranslation(ref, "layout", merged.translations), /缺少 1/);
      const recovery = await pipeline.manualTranslationRecoveryCommand(ref, "layout", merged.translations);
      const missing = JSON.parse(recovery.split("缺失文本块 JSON：\n").at(-1)).blocks;
      assert.deepEqual(Array.from(missing, block => block.id), ["p2"], "completed tables must not be requested again");
      const second = await pipeline.mergeManualTranslationResponse(ref, "layout", merged.translations, JSON.stringify({ id: "p2", text: "第二段译文。" }));
      const imported = await pipeline.importManualTranslation(ref, "layout", second.translations);
      assert.equal(imported.meta.translatedTables, 1);
      assert.deepEqual(Object.keys(imported.translations), ["p1", "p2"]);
      assert.ok(imported.model.pages[0].blocks[0].translatedTableHTML.includes("风速"));
      const paths = service.paths(documentID, settings.targetLanguage);
      assert.deepEqual(Object.keys(await storage.readJSON(paths.translations)), ["p1", "p2"]);
      const tableOnly = await pipeline.mergeManualTranslationResponse(ref, "layout", {}, JSON.stringify(row));
      assert.ok(tableOnly.translations[table.id], "a single table JSONL record must be accepted without body records");
      const bodyOnlyRecovery = await pipeline.manualTranslationRecoveryCommand(ref, "layout", { p1: "第一段译文。" });
      assert.ok(bodyOnlyRecovery.includes('"cells"') && bodyOnlyRecovery.includes(table.id));
      const legacy = service.normalizeManualTranslations(records, JSON.stringify({ translations: [row, { id: "p1", text: "译文" }] }));
      assert.ok(legacy[table.id]);
      const bad = await pipeline.mergeManualTranslationResponse(ref, "layout", second.translations, JSON.stringify({ id: table.id, cells: [[0, "不完整"]] }) + '\n' + JSON.stringify({ id: "p2", text: "修订正文" }));
      assert.equal(bad.translations[table.id], second.translations[table.id], "invalid table revisions must not erase completed translations");
    } finally { delete context.DOMParser; }
  }

  async function manualBoundariesAndTableOnly() {
    context.DOMParser = DOMParser;
    try {
      const { storage, service, settings, documentID } = sharedService();
      const pipeline = manualPipeline(service, storage, settings);
      const original = await service.manualTranslationInput(documentID);
      const table = original.records.find(record => record.type === "table_cells");
      const oldLayout = await service.loadLayout(documentID);
      service.loadLayout = async () => ({ ...oldLayout, rawText: oldLayout.rawText + " " });
      const changed = await service.manualTranslationInput(documentID);
      assert.notEqual(changed.tablePlan.records[0].id, table.id, "manual table IDs must bind to the source revision");
      const oldTable = JSON.stringify(table.cells.map(([index]) => [index, "旧译文"]));
      assert.equal(service.normalizeManualTranslations(changed.records, { [table.id]: oldTable })[table.id], undefined);
      service.loadLayout = async () => oldLayout;
      settings.translateTables = false;
      const disabled = await pipeline.manualTranslationCommand({ documentID }, "layout");
      assert.ok(!disabled.includes("table_cells"));
      assert.equal(service.normalizeManualTranslations((await service.manualTranslationInput(documentID)).records, { [table.id]: oldTable })[table.id], undefined);
      settings.translateTables = true;
      service.extractRecords = async () => [];
      const only = await service.manualTranslationInput(documentID);
      const row = { id: only.tablePlan.records[0].id, cells: [[0, "参数"], [1, "数值"], [2, "单位"], [3, "风速"]] };
      const imported = await service.importManualTranslation(documentID, JSON.stringify(row));
      assert.equal(imported.meta.translatedTables, 1);
      assert.equal(imported.meta.totalBlocks, 0);
      const good = await storage.readJSON(service.paths(documentID, settings.targetLanguage).tables);
      assert.equal(good.tables.length, 1);
      const malformed = JSON.stringify({ id: row.id, cells: [[0, "缺失内容"]] });
      assert.equal(Object.keys(service.parseManualTranslationResponse(malformed, only.records).translations).length, 0);
      assert.equal((await storage.readJSON(service.paths(documentID, settings.targetLanguage).tables)).tables.length, 1);
    } finally { delete context.DOMParser; }
  }

  async function entryPointCoverage() {
    context.DOMParser = DOMParser;
    try {
      const { service, llm, calls, documentID, storage, settings } = sharedService();
      llm.isWebEngineActive = options => options.engine === "deepseek_web" || options.aiMode === "web";
      llm.ensureConfiguredModel = () => { throw new Error("web translation must not configure an API model"); };
      await service.translate(documentID, { engine: "deepseek_web", aiMode: "web" });
      assert.equal(calls.length, 1);
      assert.ok(calls[0].some(block => block.type === "table_cells"));
      assert.equal((await storage.readJSON(service.paths(documentID, settings.targetLanguage).tables)).tables.length, 1);
      const tool = context.LitMTrans.Agent.MCPToolMap.get("litmtrans_start_layout_translation");
      assert.equal(tool.inputSchema.properties.translateTables.type, "boolean");
      let forwarded;
      const pipeline = new DocumentPipeline({ storage: { appendProcessLog: async () => {} }, parser: { loadParsed: async () => ({ hasLayout: true }) },
        layout: { translate: async (_id, options) => { forwarded = options.translateTables; } }, getSettings: () => ({ provider: "free_machine", translateTables: true }), translation: {}, chat: {} });
      await pipeline.translateLayout({ documentID }, { translateTables: false });
      assert.equal(forwarded, false);
      await pipeline.translateLayout({ documentID }, {});
      assert.equal(forwarded, true);
    } finally { delete context.DOMParser; }
  }

  async function tableOnlyAvailability() {
    const model = { tableTranslationHash: "translated-table", pages: [{ blocks: [] }] };
    const source = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const code = source.slice(source.indexOf("  function hasCurrentExportContent("), source.indexOf("  function hasCurrentTranslationForExport("));
    const state = { data: { layout: { translations: {}, model } } };
    const available = vm.runInNewContext(code + "\nhasCurrentExportContent", { state });
    assert.equal(available(true, "translation"), true);
    delete model.tableTranslationHash;
    assert.equal(available(true, "translation"), false);
    assert.equal(available(true, "source"), true);
    model.tableTranslationHash = "translated-table";
    const start = source.indexOf("        const force = Boolean(\n          state.data?.layout?.meta?.complete");
    const end = source.indexOf("        );", start) + "        );".length;
    const force = () => vm.runInNewContext(source.slice(start, end) + "\nforce", { state });
    state.data.layout.meta = { complete: false };
    assert.equal(force(), false, "partial table checkpoints must resume without forcing a restart");
    state.data.layout.meta.complete = true;
    assert.equal(force(), true, "a completed table-only translation must offer retranslation");
    state.data.layout.meta.identity = "same-body-translation";
    const identityCode = source.slice(source.indexOf("  function layoutPDFExportIdentity("), source.indexOf("  async function waitForLayoutPanePDFReady("));
    const identity = () => vm.runInNewContext(identityCode + "\nlayoutPDFExportIdentity()", { state, LAYOUT_PDF_EXPORT_REVISION: 23 });
    const firstIdentity = identity();
    model.tableTranslationHash = "revised-table";
    assert.notEqual(identity(), firstIdentity, "a corrected table must invalidate PDF attachment deduplication even when body identity is unchanged");
    state.settings = { translateTables: false };
    assert.ok(!identity().includes(":tables-"), "original-table PDFs must not reuse the translated-table identity");
    const artifact = new context.LitMTrans.Agent.ArtifactService({ storage: new MemoryStorage() });
    const manifest = await artifact.manifestFromSnapshot({ context: { documentID: "table-only" }, snapshot: { parsed: { hasLayout: true }, layout: { translations: {}, model } } });
    assert.equal(manifest.layoutTranslation, true);
    const pipeline = new DocumentPipeline({ storage: new MemoryStorage(), parser: { loadParsed: async () => ({ markdown: "source", hasLayout: true }) },
      translation: { load: async () => ({ markdown: "" }) }, layout: { loadTranslations: async () => ({ translations: {} }) },
      chat: { listSessions: async () => [], loadSession: async () => null }, getSettings: () => ({}) });
    pipeline.buildLayoutState = async () => ({ translations: {}, model });
    const snapshot = await pipeline.snapshot({ documentID: "table-only", filePath: "table.pdf" });
    assert.equal(snapshot.capabilities.hasLayoutTranslation, true);
  }

  async function tablePreviewExports() {
    const controller = Object.create(context.LitMTrans.Controller.prototype);
    controller.storage = new MemoryStorage();
    let selections = 0;
    const opened = [];
    controller.openExportLocation = async (directory, isDirectory) => {
      assert.equal(controller.storage.text.size % 2, 0, "open the folder only after both HTML files are saved");
      opened.push({ directory, isDirectory });
      return true;
    };
    controller.selectDirectoryExportPath = async () => { selections++; return "/mem/export"; };
    const originalHTML = '<!doctype html><meta charset="utf-8"><table><tr><td>Variable</td></tr></table>';
    const translatedHTML = '<!doctype html><meta charset="utf-8"><table><tr><td>变量<math><mi>x</mi></math></td></tr></table>';
    const payload = { name: "table", originalHTML, translatedHTML };
    const result = await controller.saveTableHTML({ window: {} }, payload);
    assert.equal(selections, 1, "one folder selection must export both files");
    assert.equal(result.paths.length, 2);
    assert.equal(result.opened, true);
    assert.deepEqual(opened, [{ directory: "/mem/export", isDirectory: true }]);
    assert.equal(await controller.storage.readText(result.paths[0]), originalHTML);
    assert.equal(await controller.storage.readText(result.paths[1]), translatedHTML);
    const next = await controller.saveTableHTML({ window: {} }, { ...payload, originalHTML: "new original" });
    assert.notEqual(next.paths[0], result.paths[0], "repeated exports must not overwrite earlier pairs");
    assert.equal(await controller.storage.readText(result.paths[0]), originalHTML);
    const files = controller.storage.text.size;
    controller.selectDirectoryExportPath = async () => "";
    assert.equal((await controller.saveTableHTML({ window: {} }, payload)).cancelled, true);
    assert.equal(controller.storage.text.size, files, "cancelling must not write either file");
    assert.equal(opened.length, 2, "cancelling must not open the folder");
    const previous = { Cc: context.Cc, Ci: context.Ci, clipboard: context.Services.clipboard };
    const flavors = new Map();
    try {
      context.Cc = {
        "@mozilla.org/widget/transferable;1": { createInstance: () => ({ init() {}, addDataFlavor() {}, setTransferData: (type, value) => flavors.set(type, value.data) }) },
        "@mozilla.org/supports-string;1": { createInstance: () => ({ data: "" }) }
      };
      context.Ci = {};
      let copied = false;
      context.Services.clipboard = { kGlobalClipboard: 1, setData: () => { copied = true; } };
      const html = '<table><tr><td rowspan="2">中文</td><td>12.5</td></tr><tr><td>42</td></tr></table>';
      const text = "中文\t12.5\n\t42";
      controller.writeClipboardTable({ html, text });
      assert.equal(copied, true);
      assert.equal(flavors.get("text/html"), html, "rich clipboard must preserve merged cells");
      assert.equal(flavors.get("text/unicode"), text, "plain clipboard must preserve column separators");
    } finally { context.Cc = previous.Cc; context.Ci = previous.Ci; context.Services.clipboard = previous.clipboard; }
  }

  async function tablePreviewImageOnly() {
    const source = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const code = source.slice(source.indexOf("  async function reusePreviewImage()"), source.indexOf("  async function copyPreviewImage()"));
    const calls = [];
    const state = { aiMode: "web", previewTable: { imageURL: "original-table.jpg", name: "table", quote: { text: "must not be attached" } } };
    const testContext = { state, els: { "image-preview-dialog": { close: () => calls.push(["close"]) } },
      imageDescriptorDataURL: async image => { assert.equal(image.url, "original-table.jpg"); return "data:image/jpeg;base64,original"; },
      prepareWebReference: async payload => calls.push(["web", payload]), addImageDescriptorToComposer: async image => calls.push(["api", image]),
      toast: message => { throw new Error(message); } };
    vm.createContext(testContext);
    vm.runInContext(code, testContext);
    await testContext.reusePreviewImage();
    const web = calls.find(row => row[0] === "web")[1];
    assert.equal(web.image.dataURL, "data:image/jpeg;base64,original");
    assert.equal(Object.hasOwn(web, "quote"), false);
    state.aiMode = "api";
    await testContext.reusePreviewImage();
    const api = calls.find(row => row[0] === "api")[1];
    assert.equal(api.url, "original-table.jpg");
    assert.equal(Object.hasOwn(api, "quote"), false);
    state.previewTable.imageURL = "";
    const count = calls.length;
    await testContext.reusePreviewImage();
    assert.equal(calls.length, count, "missing images must not fall back to text references");
  }

  async function tableSupplementPreservesPublishedBody() {
    context.DOMParser = DOMParser;
    try {
      const { service, storage, settings, documentID, llm, calls } = sharedService();
      const paths = service.paths(documentID, settings.targetLanguage);
      await storage.writeJSON(paths.translations, { p1: "已有正文" });
      await storage.writeJSON(paths.meta, { complete: true, identity: "published-body" });
      await storage.writeText(storage.path(documentID, "full.cleaned.md"), "FULL PAPER CONTEXT: wind measurement.");
      const complete = llm.complete;
      llm.complete = async messages => {
        assert.ok(messages[1].content.includes("FULL PAPER CONTEXT: wind measurement."));
        return complete(messages);
      };
      const beforeBody = JSON.stringify(await storage.readJSON(paths.translations));
      const beforeMeta = JSON.stringify(await storage.readJSON(paths.meta));
      await service.translateTablesOnly(documentID);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].every(block => block.type === "table_cells"), "supplement requests must contain only table targets");
      assert.equal(JSON.stringify(await storage.readJSON(paths.translations)), beforeBody);
      assert.equal(JSON.stringify(await storage.readJSON(paths.meta)), beforeMeta);
      await service.translateTablesOnly(documentID);
      assert.equal(calls.length, 1, "complete table caches require no new request");
      const cache = await storage.readJSON(paths.tables);
      const model = T.attach({ sourceFingerprint: cache.sourceFingerprint, pages: [{ blocks: [{ type: "table_body", bbox: [40, 100, 550, 250] }] }] }, cache);
      assert.ok(model.tableTranslationHash);
      assert.equal(T.visibleModel(model, false).tableTranslationHash, undefined);
      assert.ok(T.visibleModel(model, true).pages[0].blocks[0].translatedTableHTML);
      assert.ok(model.pages[0].blocks[0].translatedTableHTML, "switching display must not alter cached models");
      await assert.rejects(service.translateTablesOnly(documentID, { expectedFingerprint: "old-source", responses: "{}", manual: true }), /解析结果已变化/);
    } finally { delete context.DOMParser; }
  }

  async function partialTablesOnlyRetryMissing() {
    context.DOMParser = DOMParser;
    try {
      const { service, storage, settings, documentID, llm } = sharedService();
      const originalComplete = llm.complete;
      const data = payload(html);
      const other = JSON.parse(JSON.stringify(data.pdf_info[0].preproc_blocks[0]));
      other.bbox = other.blocks[0].bbox = [40, 350, 550, 500];
      data.pdf_info[0].preproc_blocks.push(other);
      const raw = JSON.stringify(data);
      storage.text.set(storage.path(documentID, "layout.json"), raw);
      storage.text.set(storage.path(documentID, "full.cleaned.md"), "Whole source paper");
      service.loadLayout = async () => ({ rawText: raw, pages: data.pdf_info });
      let requests = 0;
      llm.complete = async messages => {
        const records = JSON.parse(messages[1].content.split("Input blocks JSON:\n").at(-1)).blocks;
        requests++;
        assert.equal(records.length, requests === 1 ? 2 : 1);
        return { text: JSON.stringify({ translations: records.slice(0, 1).map(record => ({ id: record.id,
          cells: record.cells.map(([index, text]) => [index, text === "Parameter" ? "参数" : text]) })) }) };
      };
      const first = await service.translateTablesOnly(documentID);
      assert.equal(first.remaining, 1);
      const paths = service.paths(documentID, settings.targetLanguage);
      const saved = JSON.stringify((await storage.readJSON(paths.tables)).tables[0]);
      await service.translateTablesOnly(documentID);
      const cache = await storage.readJSON(paths.tables);
      assert.equal(cache.tables.length, 2);
      assert.equal(JSON.stringify(cache.tables[0]), saved);
      llm.complete = originalComplete;
      await service.translate(documentID, { translateTables: false });
      assert.equal((await storage.readJSON(paths.tables)).tables.length, 2);
    } finally { delete context.DOMParser; }
  }

  async function tableDialogQueueWaitsForOtherModals() {
    const source = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const code = source.slice(source.indexOf("  function tableDocumentKey("), source.indexOf("  async function rememberTableDisplay("));
    const state = { data: { item: { documentID: "paper" } }, settings: { targetLanguage: "简体中文" }, running: new Set(["layout"]) };
    let modalOpen = true;
    const sandbox = vm.createContext({ state, document: { hidden: false, querySelector: () => modalOpen, body: { dataset: {} } },
      setTimeout: callback => setTimeout(callback, 1), updateOperationUI: () => {}, updateAnnouncementUI: () => {}, toast: message => assert.fail(message) });
    vm.runInContext("let startupNoticeGateClosed = false, exportBusy = false, tableInteraction = false; let tableDecisionQueue = Promise.resolve();\n" + code, sandbox);
    const events = [];
    const queue = vm.runInContext("queueTableTask", sandbox);
    const pause = () => new Promise(resolve => setTimeout(resolve, 5));
    const first = queue(async () => { events.push("first-start"); await pause(); events.push("first-end"); });
    const second = queue(async () => events.push("second"));
    await pause();
    assert.deepEqual(events, [], "startup notices must finish before table decisions");
    vm.runInContext("startupNoticeGateClosed = true", sandbox);
    await pause();
    assert.deepEqual(events, [], "an existing modal must retain focus");
    modalOpen = false;
    await pause();
    assert.deepEqual(events, [], "translation operations must finish before supplementary prompts");
    state.running.clear();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first-start", "first-end", "second"], "table and PDF decisions must execute sequentially");
    modalOpen = true;
    const stale = queue(async () => events.push("stale"));
    await pause();
    state.data.item.documentID = "another-paper";
    await stale;
    assert.ok(!events.includes("stale"), "queued decisions must not apply to a different document");
  }

  function tableOnlyPagesDoNotShowWaitingOverlay() {
    const source = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const code = source.slice(source.indexOf("  function layoutTranslationPageState("), source.indexOf("  function fitLayoutText("));
    const pageState = vm.runInNewContext(code + "\nlayoutTranslationPageState");
    const body = { translatable: true, text: "Untranslated body" };
    const table = { type: "table_body", translatedTableHTML: "<table><tr><td>译表</td></tr></table>" };
    const page = { blocks: [body, table] };
    const before = JSON.stringify(page);
    assert.equal(pageState(page, true).showAwaitingOverlay, false, "a valid translated table is visible without a translated body");
    assert.equal(JSON.stringify(page), before, "recognizing table content must not change body translation state");
    assert.equal(pageState({ blocks: [body], restoration: { absoluteBlocks: [table] } }, true).showAwaitingOverlay, false);
    assert.equal(pageState({ blocks: [body, { ...table, translatedTableHTML: "" }] }, true).showAwaitingOverlay, true);
    assert.equal(pageState({ blocks: [body] }, true).showAwaitingOverlay, true, "untranslated pages must retain their placeholder");
    assert.equal(pageState({ blocks: [body] }, false).showAwaitingOverlay, false);
    assert.equal(pageState({ blocks: [{ type: "image" }] }, true).showAwaitingOverlay, false);
  }

  async function tableOpenCheckResumesDeferredPDF() {
    const source = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const keyAndWait = source.slice(source.indexOf("  function tableDocumentKey("), source.indexOf("  function tableDecision("));
    const tasks = source.slice(source.indexOf("  function queueTableTask("), source.indexOf("  async function rememberTableDisplay("));
    const remember = source.slice(source.indexOf("  async function rememberTableDisplay("), source.indexOf("  async function askTablePDFUpdate("));
    const open = source.slice(source.indexOf("  function queueTableOpenCheck("), source.indexOf("  async function changeTablePreference("));
    const pdf = source.slice(source.indexOf("  function queueLayoutPDFAttachmentsAfterFinalPublication("), source.indexOf("  function tableDocumentKey("));
    for (const scenario of ["deferred", "declined", "already-current", "recover-no-pdf", "preserve-pending", "unknown-pdf"]) {
      let finishStatus, generated = 0, asked = 0;
      const pendingStatus = new Promise(resolve => { finishStatus = resolve; });
      let meta = { tablePDFPending: ["recover-no-pdf", "preserve-pending", "unknown-pdf"].includes(scenario) };
      const controller = Object.create(context.LitMTrans.Controller.prototype);
      controller.attachmentContext = async () => ({ documentID: "paper" });
      controller.storage = { setDocumentMeta: async (_, patch) => (meta = { ...meta, ...patch }) };
      const state = { data: { item: { documentID: "paper", ...meta, layoutPDFIdentity: scenario === "already-current" ? "new" : "old" },
        parsed: { hasLayout: true }, layout: { meta: { complete: true }, model: { pages: [{}] } } },
        settings: { targetLanguage: "简体中文", translateTables: scenario !== "declined" }, running: new Set() };
      let sandbox;
      sandbox = vm.createContext({ state, document: { hidden: false, querySelector: () => null, body: { dataset: {} } },
        els: { "translate-tables-check": {} }, setTimeout, updateOperationUI() {}, updateAnnouncementUI() {},
        hostCall: (method, payload) => method === "table-translation-status" ? pendingStatus : controller.dispatch({ attachmentID: 1 }, method, payload),
        tableDecision: async () => false,
        updateTableDisplay() {}, askTablePDFUpdate: async () => { asked++; },
        toast: message => assert.fail(message), layoutPDFExportIdentity: () => "new", addLog() {},
        createLayoutPDFAttachmentsAfterTranslation: async () => {
          assert.equal(vm.runInContext("tableInteraction", sandbox), false, "PDF generation must wait until the table interaction lock is released");
          generated++;
          return {};
        } });
      vm.runInContext('let startupNoticeGateClosed=true,exportBusy=false,tableInteraction=false,tablePreferenceSaving=false,tablePreferenceRevision=0,tableOpenChecked="",tableOpenResolved="",tableDecisionQueue=Promise.resolve();\n'
        + keyAndWait + tasks + remember + pdf + open, sandbox);
      vm.runInContext("queueTableOpenCheck(); queueLayoutPDFAttachmentsAfterFinalPublication();", sandbox);
      await Promise.resolve();
      assert.equal(generated, 0, "an unfinished opening check must defer generation");
      finishStatus({ available: scenario === "declined", previousDisplay: scenario === "declined",
        hasPDF: scenario === "unknown-pdf" ? undefined : ["declined", "preserve-pending"].includes(scenario) });
      await vm.runInContext("tableDecisionQueue", sandbox);
      await Promise.resolve();
      assert.equal(generated, ["deferred", "recover-no-pdf"].includes(scenario) ? 1 : 0, scenario);
      assert.equal(state.data.item.tablePDFPending, Boolean(meta.tablePDFPending), "reader and persisted pending flags must agree");
      if (scenario === "recover-no-pdf") assert.equal(meta.tablePDFPending, false, "reopening without old PDFs must repair a persisted stale flag");
      if (["preserve-pending", "unknown-pdf"].includes(scenario)) assert.equal(meta.tablePDFPending, true, "existing or uncertain PDFs must retain an earlier refusal");
      if (scenario === "declined") {
        assert.equal(asked, 1);
        assert.equal(state.data.item.tablePDFPending, true, "declining the PDF update must continue blocking automatic generation");
      }
    }
  }

  async function tableSupplementWithoutPDFAllowsLaterBodyExport() {
    const source = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const queue = source.slice(source.indexOf("  function tableDocumentKey("), source.indexOf("  function tableDecision("))
      + source.slice(source.indexOf("  function queueTableTask("), source.indexOf("  function chatContextPayload("));
    const pdf = source.slice(source.indexOf("  function queueLayoutPDFAttachmentsAfterFinalPublication("), source.indexOf("  function tableDocumentKey("));
    const start = source.indexOf("      if (manualTablesOnly) {");
    const manual = source.slice(start, source.indexOf('      const mode = state.mode === "layout" ? "layout" : "stream";', start));
    for (const entry of ["automatic", "manual"]) {
      let meta = { tablePDFPending: false }, generated = 0, requests = 0;
      const controller = Object.create(context.LitMTrans.Controller.prototype);
      controller.attachmentContext = async () => ({ documentID: "paper" });
      controller.storage = { setDocumentMeta: async (_, patch) => (meta = { ...meta, ...patch }) };
      const body = { complete: false, translatedBlocks: 0 };
      const state = { data: { item: { documentID: "paper", ...meta }, parsed: { hasLayout: true },
        layout: { meta: body, translations: {}, model: { pages: [{}] } } },
        settings: { targetLanguage: "简体中文", translateTables: false }, running: new Set() };
      const sandbox = vm.createContext({ state, document: { hidden: false, querySelector: () => null, body: { dataset: {} } },
        els: { "translate-tables-check": {}, "manual-translation-dialog": { close() {} } }, setTimeout,
        updateOperationUI() {}, updateAnnouncementUI() {}, updateTableDisplay() {}, addLog() {},
        toast: message => assert.fail(message), tableDecision: async () => true,
        hasCurrentTranslationForExport: () => true, layoutPDFExportIdentity: () => "completed-layout:pdf-26",
        createLayoutPDFAttachmentsAfterTranslation: async () => { generated++; return {}; },
        setData: data => { state.data = data; },
        hostCall: async (method, payload) => {
          if (method === "set-table-preference") return {};
          if (method === "table-translation-status") return { available: false, missing: 1, total: 1, hasPDF: false };
          if (method === "translate-tables") {
            requests++;
            assert.equal(Boolean(payload.manual), entry === "manual");
            return { state: { ...state.data, item: { ...state.data.item, ...meta },
              layout: { ...state.data.layout, model: { pages: [{}], tableTranslationHash: "new-table" } } } };
          }
          return controller.dispatch({ attachmentID: 1 }, method, payload);
        } });
      vm.runInContext('let startupNoticeGateClosed=true,exportBusy=false,tableInteraction=false,tablePreferenceSaving=false,tablePreferenceRevision=0,tableOpenChecked="paper|简体中文",tableOpenResolved="paper|简体中文",tableDecisionQueue=Promise.resolve(),tableSupplementRunning=false,manualTablesOnly=true,manualTableContext={fingerprint:"source",targetLanguage:"简体中文"};\n'
        + queue + pdf + '\nasync function importManualTable() { const response="table response";\n' + manual + '\n}', sandbox);
      if (entry === "automatic") await vm.runInContext("changeTablePreference(true)", sandbox);
      else {
        state.settings.translateTables = true;
        await vm.runInContext("importManualTable()", sandbox);
        await vm.runInContext("tableDecisionQueue", sandbox);
      }
      assert.equal(requests, 1, entry);
      assert.equal(meta.tablePDFPending, false, `${entry}: no old PDF needs an update decision`);
      assert.equal(state.data.item.tablePDFPending, false, entry);
      assert.strictEqual(state.data.layout.meta, body, "supplementing tables must retain body completion metadata");
      state.data.layout.meta = { complete: true, translatedBlocks: 1 };
      vm.runInContext("queueLayoutPDFAttachmentsAfterFinalPublication()", sandbox);
      await Promise.resolve();
      assert.equal(generated, 1, `${entry}: later body completion must generate its first PDF`);
    }
  }

  function sameDocumentTranslationLock() {
    const controller = Object.create(context.LitMTrans.Controller.prototype);
    const first = { tabID: "first", attachmentID: 1 }, second = { tabID: "second", attachmentID: 1 }, other = { tabID: "other", attachmentID: 2 };
    controller.tabs = new Map([[first.tabID, first], [second.tabID, second], [other.tabID, other]]);
    const active = new Map([[first.tabID, new Map()], [second.tabID, new Map([["layout", {}]])], [other.tabID, new Map()]]);
    controller.activeOperationMap = id => active.get(id);
    for (const operation of ["layout", "translate", "parse", "manual-translation"]) {
      assert.throws(() => controller.assertOperationAvailable(first, operation), /另一项任务正在进行/);
    }
    controller.assertOperationAvailable(other, "layout");
    active.get(second.tabID).clear();
    controller.assertOperationAvailable(first, "layout");
  }

  function tableDisplaySwitchRetainsDOMAndMeasurements() {
    const source = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const fit = source.slice(source.indexOf("  function fitLayoutTables("), source.indexOf("  function layoutTextRects("));
    const update = source.slice(source.indexOf("  function updateTableDisplay("), source.indexOf("  function renderLayoutPanes("));
    const document = new DOMParser().parseFromString('<div id="translation-layout"><div class="layout-page"><p id="body">正文保持不变</p><div class="layout-table-translation-host" data-table-source-width="300"><div class="layout-table-original"><img src="original.png" /></div><div class="layout-translated-table"><table><tr><td>译文</td></tr></table></div></div></div></div>', "text/html");
    const container = document.querySelector("#translation-layout");
    const host = container.querySelector(".layout-table-translation-host"), wrap = host.querySelector(".layout-translated-table");
    const table = wrap.querySelector("table"), body = container.querySelector("#body"), original = host.querySelector(".layout-table-original");
    let width = 300, measurements = 0;
    Object.defineProperties(host, { clientWidth: { get: () => width }, clientHeight: { value: 100 } });
    Object.defineProperties(wrap, { scrollWidth: { value: 0 }, scrollHeight: { value: 0 } });
    host.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 100, width, height: 100 });
    table.getBoundingClientRect = () => { measurements++; return host.getBoundingClientRect(); };
    const state = { settings: { translateTables: true } };
    const toggle = vm.runInNewContext(fit + update + "\nupdateTableDisplay", { document, state,
      els: { "translation-layout": container }, LitMTrans: context.LitMTrans,
      measureLayoutTableColumns: () => assert.fail("a fitting table needs no column redistribution") });
    toggle();
    assert.equal(measurements, 1);
    for (let i = 0; i < 20; i++) {
      state.settings.translateTables = false;
      toggle();
      assert.equal(original.hidden, false);
      assert.equal(wrap.hidden, true);
      state.settings.translateTables = true;
      toggle();
      assert.equal(original.hidden, true);
      assert.equal(wrap.hidden, false);
    }
    assert.equal(measurements, 1, "repeated visibility changes must reuse table measurements");
    assert.equal(container.querySelector("#body"), body, "table switches must retain the body DOM");
    assert.equal(wrap.querySelector("table"), table, "table switches must retain the translated table DOM");
    width = 400;
    toggle();
    assert.equal(measurements, 2, "a resized table must be measured again");
    const keyCode = source.slice(source.indexOf("  function layoutFitSnapshotKey("), source.indexOf("  function layoutFitPageKey("));
    state.data = { item: { documentID: "paper" }, layout: { model: { tableTranslationHash: "tables" } } };
    const key = vm.runInNewContext(keyCode + "\nlayoutFitSnapshotKey", { state, U, LitMTrans: context.LitMTrans });
    const enabledKey = key();
    state.settings.translateTables = false;
    assert.equal(key(), enabledKey, "table visibility must not invalidate the body's layout cache");
  }

  async function tableResponsesBypassBodyRepair() {
    context.DOMParser = DOMParser;
    try {
      const { service, documentID, storage, settings, llm } = sharedService();
      llm.complete = async messages => {
        const blocks = JSON.parse(messages[1].content.split("Input blocks JSON:\n").at(-1)).blocks;
        return { text: JSON.stringify({ translations: blocks.map(block => block.type === "table_cells"
          ? { id: block.id, cells: block.cells.map(([index, text]) => [index, index === 0 ? "参数 ~12!" : text]) }
          : { id: block.id, text: "正文译文。" }) }) };
      };
      await service.translate(documentID);
      const cache = await storage.readJSON(service.paths(documentID, settings.targetLanguage).tables);
      assert.equal(cache.tables[0].translations[0], "参数 ~12!", "body equation-reference heuristics must not rewrite table responses");
      const input = await service.tableTranslationInput(documentID, { includeMarkdown: false });
      assert.equal(input.markdown, "");
      const machine = sharedService();
      machine.service.webMachine = { translateRecords: async records => Object.fromEntries(records.map(record =>
        [record.id, record.type === "table_cell" ? "参数 ~12!" : "正文译文。"])) };
      await machine.service.translate(machine.documentID, { provider: "free_machine" });
      const machineCache = await machine.storage.readJSON(machine.service.paths(machine.documentID, machine.settings.targetLanguage).tables);
      assert.equal(machineCache.tables[0].translations[0], "参数 ~12!", "machine table cells must also bypass body repairs");
    } finally { delete context.DOMParser; }
  }

  function columnAllocation() {
    assert.equal(T.fitColumnWidths([35, 70, 40], [40, 200, 45], 140), null, "protected content must not be squeezed below its measured minimum");
    const widths = T.fitColumnWidths([35, 70, 40], [40, 200, 45], 240);
    assert.ok(Math.abs(widths.reduce((sum, value) => sum + value, 0) - 240) < .001);
    assert.ok(widths[0] >= 35 && widths[1] >= 70 && widths[2] >= 40);
    assert.ok(widths[1] - 70 > widths[0] - 35, "the text column must receive more space than short numeric columns");
    const balanced = T.fitColumnWidths([10, 10, 10], [110, 35, 35], 180, true);
    const proportional = T.fitColumnWidths([10, 10, 10], [110, 35, 35], 180);
    assert.ok(balanced[0] < proportional[0] && balanced[1] > proportional[1], "balanced widths must reduce domination by a single long heading");
    assert.deepEqual(Array.from(T.fitColumnWidths([30, 30], [30, 30], 100)), [50, 50]);
  }

  return { gridAndProtection, paddedCachedTableFormulasRender, rejectUncertainStructures, translationAndCache, paddlePreservesStructure, legacyPaddleTablePipeline, batchingAndCancellation, invalidTablesNeverAddRetries, unchangedTableResponsesAreComplete, sharedMachineAndFastGrouping, manualCommandsMergeAndImport, manualBoundariesAndTableOnly, entryPointCoverage, tableOnlyAvailability, tablePreviewExports, tablePreviewImageOnly, tableSupplementPreservesPublishedBody, partialTablesOnlyRetryMissing, tableDialogQueueWaitsForOtherModals, tableOnlyPagesDoNotShowWaitingOverlay, tableOpenCheckResumesDeferredPDF, tableSupplementWithoutPDFAllowsLaterBodyExport, sameDocumentTranslationLock, tableDisplaySwitchRetainsDOMAndMeasurements, tableResponsesBypassBodyRepair, columnAllocation };
};
