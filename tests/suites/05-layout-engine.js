"use strict";

module.exports = function createSuite(env) {
  const {
    assert, fs, path, root, prefValues, context, zlib, nodeCrypto, vm,
    crc32, zipU16, zipU32, zipU64, oneEntryZip, oneEntryZip64,
    MemoryStorage, withResolvedChatModel,
    U, M, H, LLMService, LLMInternals,
    TranslationService, TranslationInternals,
    WebMachineTranslationService, WebMachineTranslation,
    EdgeLocalTranslation, LayoutTranslationService, LayoutHelpers,
    MinerUService, MinerUInternals, Mindmap, MindmapV2, Flowchart,
    ChatService, ChatInternals, ControllerInternals, DocumentPipeline
  } = env;

async function testLayout() {
  const documentID = "1-ABC";
  const payload = {
    pdf_info: [{
      page_size: [600, 800],
      preproc_blocks: [
        { type: "title", bbox: [50, 40, 550, 90], lines: [{ spans: [{ type: "text", content: "Source title" }] }] },
        { type: "text", bbox: [50, 120, 550, 220], lines: [{ spans: [
          { type: "text", content: "Body " },
          { type: "equation_inline", content: "x+y" },
          { type: "text", content: "." }
        ] }] },
        { type: "interline_equation", bbox: [180, 225, 420, 255], image_path: "images/equation.png", lines: [{ spans: [{ type: "text", content: "\\\\[E = mc^2 \\\\tag{1}\\\\]" }] }] },
        {
          type: "image", bbox: [100, 260, 500, 520], image_path: "images/figure.png", lines: [],
          blocks: [{
            type: "image_footnote", bbox: [348, 521, 559, 545],
            lines: [{ spans: [{ type: "text", content: "Open Access This article is licensed." }] }]
          }]
        }
      ]
    }]
  };
  const files = new Map([
    ["/data/1-ABC/layout.json", payload],
    ["/data/1-ABC/asset-map.json", { "images/figure.png": "assets/figure.png" }]
  ]);
  const storage = {
    path: (...parts) => path.posix.join("/data", ...parts),
    async readJSON(file, fallback) {
      const value = files.get(file);
      // Storage deserializes JSON on every read. Keep the fixture faithful so
      // layout-model normalization cannot mutate its persisted source.
      return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
    },
    async writeJSON(file, value) {
      files.set(file, value);
    },
    async readText(file) { return file.endsWith("layout.json") ? JSON.stringify(payload) : ""; },
    resourceURL(id, relative) { return `resource://litmtrans-data/${id}/${relative}`; }
  };
  const llm = { getSettings: () => ({ targetLanguage: "简体中文" }) };
  const service = new LayoutTranslationService(storage, llm);
  const revision = {
    sourceFingerprint: U.hashString(JSON.stringify(payload)),
    assetMapHash: U.hashString(JSON.stringify(files.get("/data/1-ABC/asset-map.json")))
  };
  const translations = {
    p001_b0001: "译文标题",
    p001_b0002: "正文 \\(x+y\\)。",
    p001_c0003: "开放获取：本文采用知识共享许可。"
  };
  const model = await service.buildModel(documentID, translations, null, revision);
  assert(files.has("/data/1-ABC/compiled-model.json"), "compiled model must be saved to disk cache");
  let rawReadCount = 0;
  const originalReadText = storage.readText;
  storage.readText = async file => {
    if (file.endsWith("layout.json")) rawReadCount++;
    return originalReadText(file);
  };
  const cachedModel = await service.buildModel(documentID, translations, null, revision);
  assert.equal(rawReadCount, 0, "buildModel on cache hit must bypass raw layout.json reading");
  assert.equal(cachedModel.pages.length, 1);
  assert.equal(cachedModel.pages[0].blocks[0].translatedText, "译文标题");
  await service.buildModel(documentID, translations, null, { ...revision, sourceFingerprint: "changed-layout-fingerprint" });
  assert.equal(rawReadCount, 1, "a compiled model must not be reused when the current layout fingerprint differs");
  rawReadCount = 0;
  const persistedRevision = await service.ensureRevision(documentID);
  assert.equal(rawReadCount, 1, "legacy layout caches must create a durable revision manifest once");
  assert.equal(persistedRevision.sourceFingerprint, revision.sourceFingerprint);
  rawReadCount = 0;
  const reusedRevision = await service.ensureRevision(documentID);
  assert.equal(rawReadCount, 0, "a durable layout revision must avoid later layout.json reads");
  assert.equal(reusedRevision.assetMapHash, revision.assetMapHash);
  assert.equal(model.pages.length, 1);
  assert.equal(model.pages[0].blocks[0].id, "p001_b0001");
  assert.equal(model.pages[0].blocks[0].translatedText, "译文标题");
  assert.equal(model.pages[0].blocks[2].kind, "formula", "equation blocks with an image crop must remain semantic formulas");
  assert.equal(model.pages[0].blocks[2].imageURL, "", "formula crops must not replace the TeX renderer");
  assert.equal(model.pages[0].blocks[3].imageURL, "resource://litmtrans-data/1-ABC/assets/figure.png");
  const restoredFormula = model.pages[0].restoration.absoluteBlocks.find(block => block.kind === "formula");
  assert(restoredFormula, "restored layout must retain the equation as a formula block");
  assert.equal(restoredFormula.imageURL, "", "restored formula must not emit an image element");
  assert.equal(restoredFormula.bbox[2], 420,
    "a TeX-tagged formula must retain MinerU's formula-ink bbox");
  assert.equal(restoredFormula.numberRight, 550,
    "a TeX-tagged formula must retain a separate local-column anchor for its number");
  const restoredImageFootnote = model.pages[0].restoration.absoluteBlocks.find(block => block.type === "image_footnote");
  assert(restoredImageFootnote, "image footnotes must remain absolute layout blocks");
  assert.equal(restoredImageFootnote.translatedText, "开放获取：本文采用知识共享许可。");
  assert.equal(restoredImageFootnote.fontSize, 7.2);
  assert.equal(restoredImageFootnote.lineHeight, 1.2);
  const pipeline = new DocumentPipeline({ storage, mineru: {}, translation: {}, layout: service, chat: {}, getSettings: () => ({}) });
  const parsed = { imageMap: [{ originalTarget: "images/figure.png", cleanTarget: "images/figure.png" }] };
  pipeline.attachImageWidths(parsed, model);
  assert.equal(parsed.imageWidths["images/figure.png"], 400 / 600 * 100, "layout image width must use source page ratio");
  model.pages[0].blocks[3].imagePath = "assets/p001-figure.png";
  const multipartParsed = { imageMap: [{ originalTarget: "images/figure.png", cleanTarget: "images/image_001.png" }] };
  pipeline.attachImageWidths(multipartParsed, model);
  assert.equal(
    multipartParsed.imageWidths["images/image_001.png"],
    400 / 600 * 100,
    "multipart layout asset prefixes must not prevent stream images from retaining their source-page width"
  );
  const records = await service.extractRecords(documentID);
  assert.equal(records.length, 3);
  assert.equal(records[1].text, "Body \\(x+y\\).", "layout translation input must retain delimiters around inline equation spans");
  assert.equal(records[2].type, "image_footnote");
  assert.equal(records[2].text, "Open Access This article is licensed.");
  assert(M.mathIntegrityIssue(records[1].text, "正文 x+y。"), "a missing inline-equation delimiter must be visible to layout validation");
  assert(records[1].formulas.includes("\\(x+y\\)"));
}

async function testLayoutEquationBarrier() {
  const prose = "This paragraph contains enough ordinary academic prose to be promoted as body text and to exercise the restored-column merge logic. It deliberately has multiple sentences and sufficient length for the body classifier to accept it.";
  const payload = {
    pdf_info: [{
      page_size: [600, 800],
      preproc_blocks: [
        { type: "text", bbox: [50, 500, 270, 550], lines: [{ spans: [{ type: "text", content: prose }] }] },
        { type: "interline_equation", bbox: [50, 555, 270, 585], lines: [{ spans: [{ type: "text", content: "\\\\[a=b\\\\]" }] }] },
        { type: "text", bbox: [50, 590, 270, 645], lines: [{ spans: [{ type: "text", content: `Following paragraph is separate prose, not a continuation. ${prose}` }] }] }
      ]
    }]
  };
  const storage = {
    path: (...parts) => path.posix.join("/data", ...parts),
    async readJSON(file, fallback) {
      if (file.endsWith("layout.json")) return payload;
      if (file.endsWith("asset-map.json")) return {};
      return fallback;
    },
    async readText(file) { return file.endsWith("layout.json") ? JSON.stringify(payload) : ""; },
    resourceURL() { return ""; }
  };
  const service = new LayoutTranslationService(storage, { getSettings: () => ({ targetLanguage: "简体中文" }) });
  const model = await service.buildModel("equation-barrier");
  const streams = model.pages[0].restoration.streams.filter(stream => stream.debugRole === "merged_body");
  assert.equal(streams.length, 2, "an interline equation must prevent adjacent body blocks from becoming one stream");
  const formula = model.pages[0].restoration.absoluteBlocks.find(block => block.kind === "formula");
  assert.deepEqual(formula?.bbox, [50, 555, 270, 585],
    "an untagged equation must retain its original MinerU ink bbox");
}

function testSingleColumnBodyPromotion() {
  const textBlock = (bbox, lines = 5) => ({
    type: "text",
    bbox,
    lines: Array.from({ length: lines }, () => ({ spans: [{ type: "text", content: "prose" }] }))
  });
  const pages = [
    { page_size: [600, 800], preproc_blocks: [textBlock([48, 160, 552, 610]), textBlock([48, 615, 552, 740])] },
    { page_size: [600, 800], preproc_blocks: [textBlock([48, 60, 552, 430]), textBlock([48, 435, 552, 730])] }
  ];
  const profile = LayoutHelpers.inferSingleColumnProfile(pages);
  assert(profile, "repeated full-width source text must establish a single-column profile");
  assert.equal(profile.supportingPages.size, 2);

  const anchor = {
    kind: "text", bbox: [48, 430, 552, 700], originalLineCount: 7,
    pageIndex: 3, debugRole: "body_candidate"
  };
  const transition = {
    kind: "text", bbox: [48, 350, 230, 366], originalLineCount: 1,
    pageIndex: 3, debugRole: "text"
  };
  const frontMatter = {
    kind: "text", bbox: [48, 110, 250, 126], originalLineCount: 1,
    pageIndex: 0, debugRole: "text"
  };
  const inherited = LayoutHelpers.inheritStableSingleColumnShortItems(
    [anchor, transition, frontMatter], 600, 800, profile
  );
  assert.equal(inherited[1].debugRole, "body_inherited",
    "a later left-aligned derivation transition must inherit the body baseline");
  assert.equal(inherited[0].debugRole, "body_candidate",
    "the stable full-width anchor must retain its normal body role");
  assert.equal(inherited[2].debugRole, "text",
    "first-page metadata geometry must remain on the legacy path");

  const twoColumnItems = [
    anchor,
    { kind: "text", bbox: [48, 220, 280, 620], originalLineCount: 8, pageIndex: 3, debugRole: "body_candidate" },
    { kind: "text", bbox: [320, 220, 552, 620], originalLineCount: 8, pageIndex: 3, debugRole: "body_candidate" },
    transition
  ];
  const blocked = LayoutHelpers.inheritStableSingleColumnShortItems(twoColumnItems, 600, 800, profile);
  assert.equal(blocked.at(-1).debugRole, "text",
    "parallel columns on the current page must veto the single-column short-text role");
}

function testEquationNumberAnchorUsesLocalColumns() {
  const numberRight = LayoutHelpers.equationNumberRightForBBox;
  const textBoxes = [
    { columnKey: "column-0", left: 40, right: 180, top: 180, bottom: 310 },
    { columnKey: "column-1", left: 210, right: 380, top: 180, bottom: 310 },
    { columnKey: "column-2", left: 410, right: 580, top: 180, bottom: 310 }
  ];
  const edges = { bodyBoxes: [], textBoxes };
  assert.deepEqual(
    numberRight([250, 220, 320, 246], 620, edges),
    380,
    "a numbered equation in a three-column middle lane must anchor its number at that lane's right edge"
  );
  assert.deepEqual(
    numberRight([80, 220, 170, 246], 620, edges),
    180,
    "ordinary text geometry, even when not body-fitted, must support a single-column number anchor"
  );
  assert.deepEqual(
    numberRight([100, 220, 350, 246], 620, edges),
    380,
    "a formula spanning two locally visible columns must place its number at the outer span edge"
  );
  assert.deepEqual(
    numberRight([250, 500, 320, 526], 620, edges),
    320,
    "without nearby column evidence, the number must stay at the source formula edge"
  );
  const edgesWithShortTransition = {
    "column-0": 288,
    bodyBoxes: [
      { columnKey: "column-0", left: 44, right: 288, top: 400, bottom: 450 }
    ],
    textBoxes: [
      { columnKey: "column-0", left: 54, right: 171, top: 490, bottom: 503 },
      { columnKey: "column-0", left: 44, right: 288, top: 400, bottom: 450 }
    ]
  };
  assert.deepEqual(
    numberRight([44, 513, 94, 525], 612, edgesWithShortTransition),
    288,
    "a formula vertically near an incomplete transition line must still align with the full column right edge"
  );
}

async function testLayoutCodeAndContentsRules() {
  const contents = [
    "1 Introduction ........ 1",
    "1.1 Motivation ........ 3",
    "1.2 Contributions ........ 5",
    "2 Methods ........ 9",
    "2.1 Dataset ........ 11",
    "2.2 Evaluation ........ 14",
    "3 Results ........ 18"
  ].join("\n");
  const tocLines = [{ spans: [{ type: "text", content: contents }] }];
  const rows = LayoutHelpers.parseTocRows(tocLines);
  assert.equal(rows.length, 7, "an embedded multi-line contents span must be split into logical rows");
  assert.equal(
    LayoutHelpers.layoutVisualLineCount([{ spans: [{ type: "text", content: "Keywords:\nUnderwater explosion\nShock wave\nBubble motion\nEulerian finite element formulation\nContinuous simulation" }] }]),
    6,
    "embedded span newlines must count as visual source lines"
  );
  assert.equal(LayoutHelpers.layoutVisualLineCount([{ spans: [{ type: "text", content: "Abstract" }] }]), 1);
  assert.equal(rows[1].level, 1, "numbered subsections must retain their contents indentation level");
  assert.equal(rows[6].page, "18", "contents page numbers must be retained separately from titles");
  assert.equal(
    LayoutHelpers.parseTocRows([{ spans: [{ type: "text", content: "1 First item\n2 Second item\n3 Third item\n4 Fourth item\n5 Fifth item\n6 Sixth item" }] }]),
    null,
    "an ordinary numbered list without leader/page pairs must not be classified as contents"
  );

  const codeBlock = {
    type: "code",
    guess_lang: "python",
    bbox: [50, 300, 550, 430],
    lines: [{ spans: [{ type: "text", content: "def outer():" }] }],
    blocks: [{
      type: "code_body",
      lines: [
        { spans: [{ type: "text", content: "    if ready:" }] },
        { spans: [{ type: "text", content: "        return value" }] }
      ]
    }]
  };
  assert.equal(
    LayoutHelpers.codeTextFromBlock(codeBlock),
    "def outer():\n    if ready:\n        return value",
    "code/code_body collection must preserve leading indentation"
  );
  assert.equal(
    context.LitMTransPort.codeTextFromLayoutBlock(codeBlock),
    "def outer():\n    if ready:\n        return value",
    "the typed core model must preserve the same code text"
  );
  assert.equal(context.LitMTransPort.parseTocRows(tocLines).length, 7);
  const normalizedToc = context.LitMTransPort.normalizeLayoutBlock(
    { type: "text", lines: tocLines },
    1,
    0
  );
  assert(normalizedToc.text.includes("\n1.1 Motivation"), "typed translation input must retain contents row boundaries");

  const payload = {
    pdf_info: [{
      page_size: [600, 800],
      preproc_blocks: [
        { type: "text", bbox: [45, 60, 555, 250], lines: tocLines },
        codeBlock
      ]
    }]
  };
  const storage = {
    path: (...parts) => path.posix.join("/data", ...parts),
    async readJSON(file, fallback) {
      if (file.endsWith("layout.json")) return payload;
      if (file.endsWith("asset-map.json")) return {};
      return fallback;
    },
    async readText(file) { return file.endsWith("layout.json") ? JSON.stringify(payload) : ""; },
    resourceURL() { return ""; }
  };
  const service = new LayoutTranslationService(storage, { getSettings: () => ({ targetLanguage: "简体中文" }) });
  const model = await service.buildModel("code-and-contents");
  const translationRecords = await service.extractRecords("code-and-contents");
  assert(
    translationRecords.find(record => record.type === "text")?.text.includes("\n1.1 Motivation"),
    "runtime layout translation input must retain contents row boundaries"
  );
  const tocStream = model.pages[0].restoration.streams.find(stream => stream.debugRole === "toc");
  assert(tocStream, "recognized contents must remain a dedicated stream instead of being promoted to body prose");
  assert.equal(tocStream.items[0].tocRows.length, 7);
  const renderedCode = model.pages[0].restoration.absoluteBlocks.find(block => block.kind === "code");
  assert(renderedCode, "code/code_body must be carried to the absolute layout renderer as code");
  assert.equal(renderedCode.codeLanguage, "python");
  assert(renderedCode.text.includes("\n    if ready:"), "the rendered code model must retain indentation");

  const workbenchSource = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(workbenchSource.includes('<pre class="layout-code"'), "the workbench must render code through pre/code");
  assert(workbenchSource.includes("function clampTranslatedCodeOverflow()"), "translated code blocks must have a dedicated overflow fitter");
  assert(workbenchSource.includes("code.scrollHeight > code.clientHeight + 1"), "code fitting must measure the pre container instead of silently clipping it");
  assert(workbenchSource.includes("code.style.overflow = 'auto';"), "overlong code must fall back to an internal scrollbar");
  assert(workbenchSource.includes("clampTranslatedCodeOverflow();"), "the translated code fitter must run with the layout fit pass");
  assert(workbenchSource.includes("const minFont = 7.0;"), "code fitting must preserve a readable minimum font size");
  assert(workbenchSource.includes("const minLineRatio = 1.10;"), "code fitting must preserve a readable minimum line-height");
  assert(workbenchCSS.includes("line-height: inherit;"), "code line-height must inherit the fitted parent value");
  assert(workbenchSource.includes("renderLayoutTocRows"), "the workbench must use the dedicated contents row renderer");
  assert(
    workbenchSource.includes("tuneEach('.layout-flow-stream.debug-text[data-flow-kind=\"text\"][data-original-lines=\"multi\"]', {"),
    "multi-line text must use the same Python-parity fitting selector"
  );
  assert(workbenchSource.includes("litmtrans-layout-fit-runtime:v23:"), "layout fitting must invalidate snapshots that predate inherited single-column body text");
  assert(workbenchSource.includes('U.hashString(String(node.textContent || "").replace(/\\s+/g, " ").trim())'),
    "a retranslated page must not reuse a fit snapshot for different text");
  assert(workbenchSource.includes('pending = restored.size === active.length ? [] : active;'),
    "a partial cache miss must rerun the document-wide fitter over every page");
  assert(
    workbenchSource.includes("function queueLayoutPageScaleRefresh(container)")
      && workbenchSource.includes("page._litmtransRefreshLayoutScale?.(false);")
      && workbenchSource.includes("queueLayoutPageScaleRefresh(els[\"translation-layout\"]);"),
    "a completed layout and AI-rail visibility transitions must reapply the existing page scale without rebuilding or refitting text"
  );
  assert(
    workbenchSource.includes("const savedLayoutFont = Number(layoutFonts[documentID]);")
      && workbenchSource.includes("state.layoutFontPt = Number.isFinite(savedLayoutFont) && savedLayoutFont > 0")
      && workbenchSource.includes("else delete document.body.dataset.userBodyFontPt;"),
    "an absent per-document layout font must leave body typography to the automatic fitter instead of treating the stream-reader default as an override"
  );
  assert(
    workbenchSource.includes("function reflectAutomaticLayoutFont(container)")
      && workbenchSource.includes("state.detectedLayoutFontPt = Math.round(fontPt * 10) / 10;")
      && workbenchSource.includes("reflectAutomaticLayoutFont(container);"),
    "the layout font control must reflect the fitted body size before a first user adjustment becomes a per-document override"
  );
  const workbenchMarkup = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  assert(workbenchMarkup.includes('id="reader-font-input" type="number" step="any" value="" placeholder="自动"'),
    "layout fitting must not advertise the unrelated 12pt stream-reader default while its automatic result is pending");
  assert(workbenchSource.includes('els["reader-font-input"].value = automaticLayout ? "" : value;')
      && workbenchSource.includes("else delete layoutReaderFonts[documentID];"),
    "clearing the layout font control must restore automatic fitting instead of persisting a 12pt override");
  assert(
    workbenchSource.includes("demoteFalseSingleLineText(active);")
      && workbenchSource.includes("function demoteFalseSingleLineText(pages = null)"),
    "the active Zotero layout fit path must demote MinerU false single-line blocks before restoring a fit snapshot"
  );
  assert(workbenchSource.includes("installLayoutImageMemoryManager"), "long layout documents must unload distant images");
  assert(workbenchSource.includes('rootMargin: "1800px 0px"'), "nearby pages must be prefetched before they enter the viewport");
  assert(workbenchSource.includes("await prepareLayoutImagesForPrint();"), "PDF export must restore and await distant images");
  assert(workbenchSource.includes('window.addEventListener("beforeprint", restoreLayoutImagesForPrintEvent)'), "system printing must restore distant images");
  assert(workbenchSource.includes('window.addEventListener("afterprint", resumeLayoutImageMemoryManagement)'), "image eviction must resume after printing");
  assert(workbenchCSS.includes(".toc-leader"), "contents rows must expose a dotted leader column");
  assert(workbenchCSS.includes("content-visibility: auto"), "offscreen layout pages must avoid unnecessary paint/layout work");
  const controllerSource = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  assert(
    controllerSource.includes('doc.getElementById("litmtrans-reader-toolbar-button")')
      && controllerSource.includes('button.id = "litmtrans-reader-toolbar-button";'),
    "Reader toolbar rendering must deduplicate the LitMTrans entry point after host redraws"
  );
}

function testLayoutTranslationValidation() {
  assert.equal(
    LayoutHelpers.layoutLinesToHTML([
      { spans: [{ type: "text", content: "first" }] },
      { spans: [{ type: "text", content: "second" }] }
    ]),
    "first<br />second",
    "layout HTML must be valid for the XHTML workbench"
  );
  assert.equal(LayoutHelpers.safeLayoutTextToHTML("first\nsecond"), "first<br />second");
  const glossaryParagraphs = LayoutHelpers.symbolGlossaryParagraphs({
    symbolGlossary: true,
    html: "\\(a\\)alpha<br />\\(b\\)beta",
    text: "\\(a\\)alpha\n\\(b\\)beta",
    translatedText: "\\(a\\) 阿尔法\n\n\\(b\\) 贝塔"
  });
  assert.equal(glossaryParagraphs.length, 2,
    "translated nomenclature rows must remain independent layout paragraphs");
  assert.equal(glossaryParagraphs[1].parts[0].translatedText, "\\(b\\) 贝塔");
  assert(LayoutHelpers.hasUnsafeControlCharacters("bad\bTeX"));
  assert.equal(LayoutHelpers.sanitizeModelText("bad\bTeX\f"), "badTeX");
  const parser = new LayoutTranslationService(new MemoryStorage(), { getSettings: () => ({ targetLanguage: "简体中文" }) });
  const transportRecord = { id: "transport", type: "text", text: "Source \\(x\\)." };
  assert.deepEqual(
    parser.parseTranslationResponse(
      JSON.stringify({ translations: [{ id: "transport", text: "译文\b" }], formula_replacements: [] }),
      [transportRecord]
    ).translations,
    {},
    "JSON escape artefacts from model TeX must be retried instead of reaching the renderer"
  );
  assert.equal(
    LayoutHelpers.plainBlockText({
      lines: [{ spans: [
        { type: "text", content: "At " },
        { type: "equation_inline", content: "\\(R / R _ { 0 } = 6\\)" },
        { type: "text", content: ", the afterflow dominates." }
      ] }]
    }),
    "At \\(R / R _ { 0 } = 6\\), the afterflow dominates.",
    "translation records must preserve one canonical delimiter pair for inline equation spans"
  );
  const unchangedModelAnswer = {
    id: "unchanged-model-answer",
    type: "text",
    text: "A sufficiently long English answer may be intentionally retained by a model and must not trigger a paid retry from a language heuristic."
  };
  assert.equal(
    LayoutHelpers.recordsNeedingRetry([unchangedModelAnswer], { [unchangedModelAnswer.id]: unchangedModelAnswer.text }).length,
    0,
    "an unchanged model answer must not trigger a language-based retry"
  );

  const fragment = {
    id: "fragment",
    type: "text",
    text: "The result indicates that the proposed mechanism affects the observed pheno-"
  };
  assert(LayoutHelpers.looksOverexpanded(fragment, "海马编码与地点和事件有关的记忆。".repeat(20)));
  assert.equal(
    LayoutHelpers.repairEquationReferenceTranslation("See Eqs. (3) and (4).", "见式 3 和式 4。"),
    "见式 (3) 和式 (4)。"
  );
  const formula = {
    id: "formula",
    type: "text",
    text: "The measured value is \\(x + y\\) under compression."
  };
  assert(M.mathIntegrityIssue(formula.text, "测得的数值为 \\(x+y\\)。"));
  assert.equal(
    M.mathRetryIssue(formula.text, "测得的数值为 \\(x+y\\)。"),
    "",
    "same-count formula spelling differences are review warnings, not retry triggers"
  );
  assert.equal(
    LayoutHelpers.recordsNeedingRetry(
      [formula],
      { formula: "测得的数值为 \\(x+y\\)。" },
      "简体中文"
    ).length,
    0
  );
  assert.equal(
    LayoutHelpers.recordsNeedingRetry(
      [formula],
      { formula: "测得的数值为 \\(x-z\\)。" },
      "简体中文"
    ).length,
    0,
    "same-count formula-body differences must be review warnings, not layout retries"
  );
  assert.equal(
    LayoutHelpers.recordsNeedingRetry(
      [formula],
      { formula: "测得的数值为 x+y。" },
      "简体中文"
    ).length,
    1,
    "losing a formula delimiter remains a structural retry condition"
  );
  const variableList = {
    id: "variable-list",
    type: "text",
    text: "where \\(n_w, n_g, \\rho_w\\) and \\(p\\) denote the variables."
  };
  assert.equal(
    M.mathRetryIssue(variableList.text, "式中 \\(n_w\\)、\\(n_g\\)、\\(\\rho_w\\) 和 \\(p\\) 表示这些变量。"),
    "",
    "safe formula-list splitting must not spend another translation request"
  );
  assert.equal(
    M.mathRetryIssue(
      "After normalizing by \\(\\Delta E\\), the result contains parameter M.",
      "用 \\(\\Delta E\\) 归一化后，结果包含参数 \\(M\\)。"
    ),
    "",
    "wrapping a source-side bare variable in TeX is a safe formatting repair"
  );
  assert.equal(
    M.mathRetryIssue(
      "After normalizing by \\(\\Delta E\\), the result contains parameter M.",
      "用 \\(\\Delta E\\) 归一化后，结果包含参数 \\(Z\\)。"
    ),
    "",
    "additional TeX is audited but must not trigger another paid request"
  );
  assert.equal(
    M.mathRetryIssue("速度为 \\(u_{sw}\\)。", "速度为 \\(u_{{sw}}\\)。"),
    "",
    "redundant nested TeX braces must not trigger a paid retry"
  );
  assert.equal(
    M.mathRetryIssue("元素 \\(\\mathrm{H}\\)。", "元素 \\(H\\)。"),
    "",
    "equivalent mathrm presentation must not trigger a paid retry"
  );
  assert.equal(
    M.mathRetryIssue("参数 \\(C_p = 1; (ii)\\)。", "参数 \\(C_p = 1\\) (ii)。"),
    "",
    "an OCR list marker moved out of a formula must not trigger a paid retry"
  );
  assert(
    M.mathRetryIssue("参数 \\(x+y\\)。", "参数 \\(x+z\\)。").includes("标准化源"),
    "real formula changes must return a concrete normalized diff"
  );
}

async function testManualLayoutJSONLProtocol() {
  const records = [
    { id: "p001_b0001", page: 1, type: "text", text: "First source line with \\(x+y\\)." },
    { id: "p001_b0002", page: 1, type: "title", text: "Second source block" },
    { id: "p001_b0003", page: 1, type: "text", text: "Third source block" }
  ];
  const service = new LayoutTranslationService(
    new MemoryStorage(),
    { getSettings: () => ({ targetLanguage: "简体中文" }) }
  );
  service.extractRecords = async () => records;
  const pipeline = new DocumentPipeline({
    storage: {},
    mineru: { loadParsed: async () => ({ hasLayout: true }) },
    translation: {},
    layout: service,
    chat: {},
    getSettings: () => ({ targetLanguage: "简体中文" })
  });

  const command = await pipeline.manualTranslationCommand({ documentID: "manual-jsonl" }, "layout");
  assert(command.includes("JSON Lines"));
  assert(command.includes('{"id":"原始id","text":"该id对应的译文"}'));
  assert(command.includes("不要添加外层对象、外层数组或 `translations` 字段"));
  assert(!command.includes('{"translations":[{"id":"...","text":"..."}]}'),
    "the manual command must no longer require one aggregate JSON document");

  const firstText = "第一行\n第二行保留 \\(x+y\\)。";
  const firstLine = JSON.stringify({ id: records[0].id, text: firstText });
  const secondLine = JSON.stringify({ id: records[1].id, text: "第二个文本块" });
  const unknownLine = JSON.stringify({ id: "unknown", text: "不应导入" });
  const truncatedResponse = [
    '模型回答：以下是“JSON Lines”记录。',
    "```text",
    firstLine,
    unknownLine,
    secondLine,
    '{"id":"p001_b0003","text":"未闭合的最后一条记录'
  ].join("\n");
  const parsed = service.parseManualTranslationResponse(truncatedResponse, records).translations;
  assert.equal(parsed[records[0].id], firstText,
    "manual JSONL must preserve escaped newlines and TeX backslashes");
  assert.equal(parsed[records[1].id], "第二个文本块");
  assert.equal(parsed[records[2].id], undefined,
    "an incomplete final record must not invalidate earlier complete records");
  assert.equal(parsed.unknown, undefined);

  const legacy = service.parseManualTranslationResponse(JSON.stringify({
    translations: records.map((record, index) => ({ id: record.id, text: `旧格式译文${index + 1}` }))
  }), records).translations;
  assert.deepEqual(Object.keys(legacy), records.map(record => record.id),
    "legacy aggregate manual answers must remain readable");

  const truncatedLegacy = [
    '{"translations":[',
    JSON.stringify({ id: records[0].id, text: "旧格式中已完成的记录" }) + ",",
    '{"id":"p001_b0002","text":"未闭合"'
  ].join("\n");
  assert.equal(
    service.parseManualTranslationResponse(truncatedLegacy, records).translations[records[0].id],
    "旧格式中已完成的记录",
    "the compatibility parser should also salvage complete rows from a truncated legacy answer"
  );

  const normalized = service.normalizeManualTranslations(records, [truncatedResponse]);
  assert.deepEqual(Object.keys(normalized), [records[0].id, records[1].id]);
  const merged = await service.mergeManualTranslationResponse(
    "manual-jsonl",
    { [records[0].id]: "先前译文" },
    JSON.stringify({ id: records[2].id, text: "第三个文本块" })
  );
  assert.equal(merged.translations[records[0].id], "先前译文");
  assert.equal(merged.translations[records[2].id], "第三个文本块");
  assert.equal(merged.parsedBlocks, 1);

  const recovery = await pipeline.manualTranslationRecoveryCommand(
    { documentID: "manual-jsonl" },
    "layout",
    normalized
  );
  assert(recovery.includes("JSON Lines"));
  assert(recovery.includes(records[2].id));
  assert(!recovery.includes(`\"id\": \"${records[0].id}\"`),
    "manual recovery must request only IDs still missing after JSONL salvage");

  const apiCalls = [];
  const apiService = new LayoutTranslationService(new MemoryStorage(), {
    async complete(messages, options) {
      apiCalls.push({ messages, options });
      return {
        text: JSON.stringify({
          translations: [{ id: records[0].id, text: "第一段来源文本保留 \\(x+y\\)。" }]
        })
      };
    }
  });
  await apiService.translateGroup(
    [records[0]], "", "", "api-unchanged", "identity",
    { targetLanguage: "简体中文" }, 0, 1, null, null
  );
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].options.responseFormat, "json_object",
    "automatic API layout translation must keep its structured JSON response mode");
  assert(String(apiCalls[0].messages[1].content).includes('{"translations":[{"id":"...","text":"..."}]}'),
    "automatic API layout translation must keep its existing aggregate response prompt");
  assert(!String(apiCalls[0].messages[1].content).includes("JSON Lines"));
}

async function testDeferredLayoutRetryPreservesTrueMissingState() {
  const storage = new MemoryStorage();
  const llm = {
    async complete() {
      return { text: JSON.stringify({ translations: [] }), reasoning: "" };
    }
  };
  const service = new LayoutTranslationService(storage, llm);
  service.parseTranslationResponse = () => ({ translations: {}, formulaReplacements: {} });
  const record = {
    id: "p001_b0001",
    page: 1,
    type: "text",
    text: "A sufficiently long English source paragraph must remain absent until document-wide validation classifies it."
  };
  const result = await service.translateGroup(
    [record],
    "",
    "",
    "deferred-missing",
    "identity",
    {
      provider: "gemini",
      baseURL: "https://example.invalid",
      model: "test",
      apiKey: "test",
      targetLanguage: "简体中文",
      deferLayoutRetry: true
    },
    0,
    1
  );
  assert.equal(result.translations[record.id], undefined);
  const classified = LayoutHelpers.classifyRetryRecords([record], result.translations);
  assert.deepEqual([...classified[0].reasons], ["missing"]);
}

function testLayoutWholePaperGrouping() {
  const service = new LayoutTranslationService({}, {});
  const records = Array.from({ length: 205 }, (_, index) => ({
    id: `p001_b${String(index + 1).padStart(4, "0")}`,
    text: `Block ${index + 1}`
  }));
  const wholePaper = service.groupRecords(records, 0, 0);
  assert.equal(wholePaper.length, 1);
  assert.equal(wholePaper[0].length, records.length);
  const grouped = service.groupRecords(records, 0, 80);
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped.flat().map(record => record.id), records.map(record => record.id));
}

async function testLayoutConcurrentGroupsAndCache() {
  const storage = new MemoryStorage();
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `p001_b${String(index + 1).padStart(4, "0")}`,
    page: 1,
    type: "text",
    text: `Source block number ${index + 1} contains enough English words for deterministic translation validation.`
  }));
  let active = 0;
  let maximumActive = 0;
  const maximumActiveByProvider = new Map();
  let requestCount = 0;
  const attemptsByID = new Map();
  const llm = {
    getSettings: () => ({
      provider: "gemini",
      baseURL: "https://example.invalid",
      model: "test-model",
      apiKey: "not-a-secret",
      targetLanguage: "简体中文",
      layoutChunkChars: 0,
      layoutChunkBlocks: 1
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "stable-layout-source" });
  service.extractRecords = async () => records;
  service.extractFormulaContext = async () => [];
  service.buildGuide = async () => "统一术语指南";
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings) => {
    requestCount++;
    for (const record of group) {
      attemptsByID.set(record.id, (attemptsByID.get(record.id) || 0) + 1);
    }
    active++;
    maximumActive = Math.max(maximumActive, active);
    const provider = String(settings.provider || "").toLowerCase();
    maximumActiveByProvider.set(
      provider,
      Math.max(maximumActiveByProvider.get(provider) || 0, active)
    );
    const ordinal = Number(group[0].id.slice(-4));
    await new Promise(resolve => setTimeout(resolve, (13 - ordinal) % 4 + 1));
    active--;
    return {
      translations: Object.fromEntries(group.map(record => {
        const recordOrdinal = Number(record.id.slice(-4));
        return [
          record.id,
          attemptsByID.get(record.id) === 1
            ? record.text
            : `这是第 ${recordOrdinal} 个块的完整中文译文。`
        ];
      })),
      formulaReplacements: {}
    };
  };

  const first = await service.translate("concurrent-layout", {
    mode: "chunked",
    layoutChunkChars: 0,
    layoutChunkBlocks: 1,
    layoutConcurrency: 6
  });
  assert(maximumActive > 1 && maximumActive <= 3, `expected bounded concurrency, got ${maximumActive}`);
  assert.equal(requestCount, records.length + 1, "all first-pass findings must share one bounded layout retry request");
  assert([...attemptsByID.values()].every(count => count === 2), "the consolidated retry must repair every flagged block in one request");
  assert.deepEqual(Object.keys(first.translations), records.map(record => record.id), "out-of-order completions must merge in source-group order");
  assert.equal(first.meta.complete, true);

  const second = await service.translate("concurrent-layout", {
    mode: "chunked",
    layoutChunkChars: 0,
    layoutChunkBlocks: 1,
    layoutConcurrency: 6
  });
  assert.equal(second.cached, true, "a complete concurrent result must hit the final cache");
  assert.equal(requestCount, records.length + 1, "cache hit must not issue a new primary or repair request");

  const deepSeek = await service.translate("concurrent-layout-deepseek", {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    mode: "chunked",
    layoutChunkChars: 0,
    layoutChunkBlocks: 1,
    layoutConcurrency: 999
  });
  assert(maximumActiveByProvider.get("deepseek") > 3 && maximumActiveByProvider.get("deepseek") <= 500,
    `expected DeepSeek layout concurrency to exceed the default cap and stay within 500, got ${maximumActiveByProvider.get("deepseek")}`);
  assert.equal(deepSeek.meta.concurrency, 500);
  assert.equal(LayoutHelpers.layoutConcurrencyLimit("gemini"), 3);
  assert.equal(LayoutHelpers.layoutConcurrencyLimit("deepseek"), 500);
  assert.equal(
    LayoutHelpers.layoutConcurrencyLimit("oneapi", "https://api.deepseek.com/v1"),
    500,
    "official DeepSeek URLs imported as OpenAI-compatible profiles must retain the DeepSeek cap"
  );
}

async function testDeepSeekFastLayoutWarmupConcurrencyAndTelemetry() {
  const storage = new MemoryStorage();
  const records = [
    { id: "p001_b0001", page: 1, type: "title", text: "Fast layout translation test title." },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `p001_b${String(index + 2).padStart(4, "0")}`,
      page: 1,
      type: "text",
      text: (`Source paragraph ${index + 1} provides sufficient academic context for the DeepSeek cache concurrency regression test. `.repeat(32)).trim()
    }))
  ];
  storage.text.set(storage.path("fast-layout", "full.cleaned.md"), "# Fast layout translation test title\n\n![ignored](figure.png)\n\n<img src=\"ignored.png\">\n\n" + records.map(record => record.text).join("\n\n"));
  const calls = [];
  const logs = [];
  let active = 0;
  let maximumActive = 0;
  let waits = 0;
  const llm = {
    getSettings: () => ({
      provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash",
      apiKey: "test-key", targetLanguage: "简体中文", deepseekFastLayoutTranslation: true
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "deepseek-fast-layout-source" });
  service.extractRecords = async () => records;
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.waitForFastCacheSettle = async () => { waits++; };
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings, index) => {
    calls.push({ ids: group.map(record => record.id), settings: { ...settings }, index });
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, index < 2 ? 2 : 12));
    active--;
    return {
      translations: Object.fromEntries(group.map(record => [record.id, `高速中文译文：${record.id}`])),
      formulaReplacements: {},
      usage: {
        prompt_tokens: 1000 + index,
        completion_tokens: 100 + index,
        prompt_cache_hit_tokens: index === 1 ? 900 : (index > 1 ? 850 : 0),
        prompt_cache_miss_tokens: index === 1 ? 100 : 150
      }
    };
  };
  const result = await service.translate("fast-layout", { mode: "full_context" }, event => {
    if (event.type === "log") logs.push(event.message);
  });
  assert.deepEqual(calls[0].ids, ["p001_b0001"], "the title request must be the first fast-layout warm-up");
  assert.equal(waits, 2, "fast layout must wait one cache-settle interval after each warm-up stage");
  assert(maximumActive > 1, "cache-hit confirmation must release the remaining fast groups concurrently");
  assert(calls.every(call => call.settings.thinkingMode === "disabled"), "fast layout must force DeepSeek thinking off");
  assert(calls.every(call => call.settings.fullMarkdownContext && !call.settings.fullMarkdownContext.includes("ignored.png")), "each initial fast request must carry the same image-free Markdown context");
  assert(logs.some(message => message.includes("正在使用 DeepSeek 快速翻译")));
  assert(logs.some(message => message.includes("快速翻译已准备就绪")));
  assert(logs.some(message => message.includes("已完成第")));
  assert.equal(result.meta.translationMode, "deepseek_fast");
  assert.equal(result.meta.fastCacheTelemetry.length, calls.length);
}

async function testDeepSeekFastLayoutStopsBeforeParallelWaveWhenProbeIsBelowThreshold() {
  const storage = new MemoryStorage();
  const records = [
    { id: "p001_b0001", page: 1, type: "title", text: "Fast layout translation test title." },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `p001_b${String(index + 2).padStart(4, "0")}`,
      page: 1,
      type: "text",
      text: (`Source paragraph ${index + 1} provides sufficient academic context for the DeepSeek cache protection regression test. `.repeat(40)).trim()
    }))
  ];
  storage.text.set(storage.path("fast-layout-cache-protection", "full.cleaned.md"), records.map(record => record.text).join("\n\n"));
  const calls = [];
  const llm = {
    getSettings: () => ({
      provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash",
      apiKey: "test-key", targetLanguage: "简体中文", deepseekFastLayoutTranslation: true
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "deepseek-fast-layout-cache-protection-source" });
  service.extractRecords = async () => records;
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.waitForFastCacheSettle = async () => {};
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, _settings, index) => {
    calls.push(group.map(record => record.id));
    return {
      translations: Object.fromEntries(group.map(record => [record.id, `高速中文译文：${record.id}`])),
      formulaReplacements: {},
      usage: {
        prompt_cache_hit_tokens: index === 1 ? 49 : (index === 2 ? 59 : 0),
        prompt_cache_miss_tokens: index === 1 ? 51 : (index === 2 ? 41 : 100)
      }
    };
  };

  await assert.rejects(
    () => service.translate("fast-layout-cache-protection", { mode: "full_context" }),
    /DEEPSEEK_FAST_CACHE_PROTECTION/
  );
  assert.equal(calls.length, 3, "a below-50% second probe must send one third verification request before stopping");
  const checkpoint = await storage.readJSON(storage.path("fast-layout-cache-protection", "layout-translation", "meta.简体中文.json"), {});
  assert.equal(checkpoint.complete, false);
  assert.equal(checkpoint.completedGroups, 3);
}

async function testStaleDeepSeekFastPreferenceDoesNotAffectGemini() {
  const storage = new MemoryStorage();
  const records = [
    { id: "p001_b0001", page: 1, type: "text", text: "A source paragraph for Gemini translation." }
  ];
  const events = [];
  const calls = [];
  const llm = {
    getSettings: () => ({
      provider: "gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      apiKey: "test-key",
      targetLanguage: "简体中文",
      deepseekFastLayoutTranslation: true
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "gemini-standard-layout-source" });
  service.extractRecords = async () => records;
  service.extractFormulaContext = async () => [];
  service.buildGuide = async () => "";
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings) => {
    calls.push({ ...settings });
    return {
      translations: Object.fromEntries(group.map(record => [record.id, `中文：${record.text}`])),
      formulaReplacements: {}
    };
  };

  const result = await service.translate("gemini-stale-fast-preference", { mode: "full_context" }, event => events.push(event));
  assert.equal(result.meta.translationMode, "full_context", "a remembered DeepSeek preference must not change Gemini's translation mode");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].thinkingMode, undefined, "Gemini thinking settings must not be disabled by a remembered DeepSeek preference");
  assert(!events.some(event => /DeepSeek|快速排版/.test(String(event.message || ""))),
    "Gemini translation must not show a DeepSeek fallback or fast-mode message");
}

async function testLayoutRetriesFailedTransportGroupOnce() {
  const storage = new MemoryStorage();
  const records = [
    { id: "p001_b0001", page: 1, type: "text", text: "First source block." },
    { id: "p001_b0002", page: 1, type: "text", text: "Second source block." }
  ];
  const attempts = [];
  const warnings = [];
  const llm = {
    getSettings: () => ({
      provider: "gemini", baseURL: "https://example.invalid", model: "test-model",
      apiKey: "not-a-secret", targetLanguage: "简体中文", layoutChunkChars: 0, layoutChunkBlocks: 1
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "transport-retry-layout-source" });
  service.extractRecords = async () => records;
  service.extractFormulaContext = async () => [];
  service.buildGuide = async () => "";
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings) => {
    attempts.push({ id: group[0].id, recovery: Boolean(settings.transportRecovery) });
    if (group[0].id === records[0].id && !settings.transportRecovery) {
      throw new Error("JSON.parse: malformed response");
    }
    return { translations: { [group[0].id]: `中文：${group[0].text}` }, formulaReplacements: {} };
  };

  const result = await service.translate("transport-retry-layout", {
    mode: "chunked", layoutChunkChars: 0, layoutChunkBlocks: 1, layoutConcurrency: 1
  }, event => {
    if (event.type === "warning") warnings.push(event.message);
  });
  assert.deepEqual(attempts, [
    { id: records[0].id, recovery: false },
    { id: records[0].id, recovery: true },
    { id: records[1].id, recovery: false }
  ], "a failed group must be retried exactly once with transport recovery enabled");
  assert.equal(result.meta.complete, true);
  assert.equal(Object.keys(result.translations).length, records.length);
  assert(warnings.some(message => message.includes("正在自动重试一次")));
}

async function testLayoutFullContextIgnoresChunkLimits() {
  const storage = new MemoryStorage();
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `p001_b${String(index + 1).padStart(4, "0")}`,
    page: 1,
    type: "text",
    text: `Source block ${index + 1} contains enough English words to require a real translation.`
  }));
  const seenGroupSizes = [];
  let guideCalls = 0;
  const llm = {
    getSettings: () => ({
      provider: "gemini",
      baseURL: "https://example.invalid",
      model: "test-model",
      apiKey: "not-a-secret",
      targetLanguage: "简体中文",
      translationMode: "full_context",
      layoutChunkChars: 1,
      layoutChunkBlocks: 1,
      layoutConcurrency: 3
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "full-context-layout-source" });
  service.extractRecords = async () => records;
  service.extractFormulaContext = async () => [];
  service.buildGuide = async () => {
    guideCalls++;
    return "不应生成";
  };
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.translateGroup = async group => {
    seenGroupSizes.push(group.length);
    return {
      translations: Object.fromEntries(
        group.map((record, index) => [record.id, `这是第 ${index + 1} 个版面块的完整中文译文。`])
      ),
      formulaReplacements: {}
    };
  };

  const result = await service.translate(
    "full-context-layout",
    { mode: "full_context", layoutChunkChars: 1, layoutChunkBlocks: 1, layoutConcurrency: 3 }
  );
  assert.deepEqual(seenGroupSizes, [records.length], "layout full-context mode must send every layout block in one request");
  assert.equal(guideCalls, 0, "a one-request full-context translation must not build a chunk glossary");
  assert.equal(result.meta.translationMode, "full_context");

  const chunked = await service.translate(
    "full-context-layout",
    { mode: "chunked", layoutChunkChars: 0, layoutChunkBlocks: 1, layoutConcurrency: 3 }
  );
  assert.equal(chunked.cached, false, "switching layout strategy must not reuse the other strategy's final cache");
  assert.deepEqual(
    seenGroupSizes.slice(1),
    Array(records.length).fill(1),
    "layout chunked mode must apply its block grouping limit"
  );
  assert.equal(guideCalls, 1);
  assert.equal(chunked.meta.translationMode, "chunked");
}

async function testLayoutTargetedRetryKeepsPrimaryPrefix() {
  const storage = new MemoryStorage();
  const calls = [];
  const record = {
    id: "p001_b0001",
    page: 1,
    type: "text",
    text: "A sufficiently long English sentence that remains deliberately untranslated for retry validation and layout checking."
  };
  const llm = {
    async complete(messages, options) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      const text = calls.length <= 2
        ? JSON.stringify({ translations: [{ id: record.id, text: record.text }], formula_replacements: [] })
        : JSON.stringify({ translations: [{ id: record.id, text: "这是一段用于重试验证和排版检查的完整中文译文。" }], formula_replacements: [] });
      options.onText?.(text);
      return { text };
    }
  };
  const service = new LayoutTranslationService(storage, llm);
  const result = await service.translateGroup(
    [record],
    "guide",
    "",
    "doc",
    "identity",
    { targetLanguage: "简体中文" },
    0,
    1,
    null,
    null
  );
  assert.equal(calls.length, 1, "the default must not retry an unchanged LLM answer");
  assert.equal(result.translations[record.id], record.text);

  const enabledResult = await service.translateGroup(
    [record], "guide", "", "doc", "identity",
    { targetLanguage: "简体中文", enableUntranslatedCheck: true }, 0, 1, null, null
  );
  assert.equal(calls.length, 3, "the internal opt-in must retain the legacy heuristic");
  assert.deepEqual(calls[2].slice(0, 2), calls[1]);
  assert.equal(calls[2].length, 3);
  assert.equal(enabledResult.translations[record.id], "这是一段用于重试验证和排版检查的完整中文译文。");

  await service.translateGroup(
    [record], "guide", "", "doc", "identity",
    { targetLanguage: "简体中文", transportRecovery: true }, 0, 1, null, null
  );
  assert(
    String(calls.at(-1)?.[1]?.content || "").includes("Transport recovery notice"),
    "a transport-recovery retry must tell the model about malformed JSON/TeX escaping without exposing host stack traces"
  );
}

async function testLayoutFirstRetryContextPolicy() {
  const storage = new MemoryStorage();
  const calls = [];
  const sourceGroup = [
    { id: "p001_b0001", page: 1, type: "text", text: "First complete source block." },
    { id: "p001_b0002", page: 1, type: "text", text: "Second complete source block with \(x\)." }
  ];
  const llm = {
    async complete(messages) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      return { text: JSON.stringify({ translations: [{ id: "p001_b0002", text: "第二个完整译文，含 \(x\)。" }] }) };
    }
  };
  const service = new LayoutTranslationService(storage, llm);
  const base = {
    targetLanguage: "简体中文",
    deferLayoutRetry: true,
    retryContextGroup: sourceGroup
  };
  await service.translateGroup(
    [sourceGroup[1]], "", "", "doc", "identity",
    { ...base, retryDetails: new Map([[sourceGroup[1].id, { reasons: ["missing"], currentTranslation: "" }]]) },
    0, 1, null, null
  );
  assert.equal(calls[0].length, 3, "the first translation-quality retry must retain its original complete group");
  assert(String(calls[0][1].content).includes(sourceGroup[0].text));

  await service.translateGroup(
    [sourceGroup[1]], "", "", "doc", "identity",
    {
      ...base,
      retryContextGroup: null,
      retryDetails: new Map([[sourceGroup[1].id, { reasons: ["formula-structure"], currentTranslation: "第二个完整译文，含 \(x\)。" }]])
    },
    0, 1, null, null
  );
  assert.equal(calls[1].length, 2, "a formula-only retry must send only the complete affected block");
  assert(!String(calls[1][1].content).includes(sourceGroup[0].text));
}

async function testLayoutFormatRetryIsSurgicalAndBounded() {
  const storage = new MemoryStorage();
  const record = {
    id: "p001_formula",
    page: 1,
    type: "text",
    text: "The value is \\(x+y\\)."
  };
  const calls = [];
  const badJSON = JSON.stringify({ translations: [{ id: record.id, text: "数值为 x+y。" }] });
  const llm = {
    async complete(messages, options) {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)), options });
      return { text: badJSON };
    }
  };
  const service = new LayoutTranslationService(storage, llm);
  await service.translateGroup(
    [record], "", "", "doc", "identity",
    { targetLanguage: "简体中文", enableUntranslatedCheck: false }, 0, 1, null, null
  );
  assert.equal(calls.length, 2, "a pure formula issue must receive at most one paid format retry");
  assert.equal(calls[1].options.thinkingMode, "disabled");
  assert.equal(calls[1].options.reasoningEffort, "minimal");
  assert.equal(calls[1].messages.length, 2, "a pure format retry must not resend the full primary context");
  assert(String(calls[1].messages[1].content).includes("retry_details"));
}

async function testCompleteReferenceCorpus() {
  assert.equal(
    TranslationInternals.compactReferenceMarkdown("Before\n\n![figure](images/a.png)\n\nAfter"),
    "Before\n\n\nAfter"
  );
  const storage = new MemoryStorage();
  await storage.writeText("/refs/reference.md", "# Reference\n\nAcademic wording and complete discourse.");
  const llm = {
    getSettings: () => ({
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-chat",
      targetLanguage: "简体中文",
      translationReferencePaths: ["/refs/reference.md"]
    })
  };
  const service = new TranslationService(storage, llm);
  const result = await service.buildReferenceCorpus("doc", llm.getSettings(), null, null);
  assert(result.corpus.includes("Academic wording and complete discourse."));
  assert(result.corpus.includes("Full reference corpus 1: reference.md"));
  assert(!result.corpus.includes("/refs/reference.md"), "absolute reference paths must not be sent to the model");
}

function testLayoutReaderIsAvailableBeforeParsing() {
  const pipeline = fs.readFileSync(path.join(root, "src", "pipeline.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");

  assert(pipeline.includes('canUseLayoutReader = U.extension(context.filePath) === ".pdf"'));
  assert(pipeline.includes('enableUntranslatedCheck: Boolean(payload.enableUntranslatedCheck)'));
  assert(workbench.includes('data?.item?.readerMode === "stream" ? "stream" : "layout"'));
  assert(workbench.includes('hostCall("save-reader-mode", { mode: "layout" })'));
  assert(workbench.includes('hostCall("save-reader-mode", { mode: "stream" })'));
  assert(workbench.includes('els["layout-mode-button"].disabled = !caps.canUseLayoutReader'));
  assert(!workbench.includes('els["layout-mode-button"].disabled = !caps.hasLayout'));
  assert(controller.includes('options.preview = false'), "the embedded original PDF must retain PDF.js's selectable text layer");
  assert(controller.includes('preview._isReadOnly = () => false'), "the embedded original PDF must retain native annotation interactions");
  assert(controller.includes('const readerWindow = preview._iframeWindow || frame.contentWindow'), "the embedded interactive reader must restore its outer UI for the selection toolbar");
  assert(controller.includes('#reader-ui > div > div:first-child'), "the embedded interactive reader must hide only its toolbar, not its context-menu layer");
  assert(controller.includes('preview._openContextMenu = async'), "the embedded reader must provide a popup host for native PDF context menus");
  assert(controller.includes('type: "native-pdf-selection"'), "native PDF selections must be transported to the workbench Ask AI toolbar");
  assert(workbench.includes('function askNativePDFSelection()'), "the workbench must send a native-PDF selection into the document chat");
  assert(workbench.includes('if (type === "chat-usage")'), "per-turn chat usage must be recorded without opening a notification");
  assert(workbench.includes('sourcePDFAvailable && switchToReferenceMode'), "native-PDF citations must jump in the embedded source pane before falling back to Zotero");
  assert(controller.includes('id = "litmtrans-pdf-reference-focus"'), "embedded PDF citations must restore their selected-page highlight");
  assert(workbench.includes('pdfRects: selection.pdfRects'), "native-PDF selection geometry must persist with the chat reference");
  assert(controller.includes('convertToViewportRectangle'), "native Zotero PDF selections must retain their page-relative highlight geometry");
  assert(controller.includes('pdfReaderView: "both"'), "native Zotero PDF citations must return to the dual-pane workbench view");
}

function testCompletedLayoutCreatesPDFItemAttachments() {
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  assert(controller.includes('async createLayoutComparisonPDF(sourcePath, translationPath, outputPath)'));
  assert(controller.includes('const translationTitle = `${targetLanguage}-译文-${stem}`;'), "generated translation PDFs must use the target-language prefix without a layout label");
  assert(controller.includes('const comparisonTitle = `${targetLanguage}-译文对照版-${stem}`;'), "generated comparison PDFs must use the target-language prefix without a layout label");
  assert(controller.includes('await this.createGeneratedPDFAttachment(context, translationPath, translationTitle)'));
  assert(controller.includes('await this.createGeneratedPDFAttachment(context, comparisonPath, comparisonTitle)'));
  assert(controller.includes('if (item?.getField?.("title") !== title) continue;'), "retranslation must replace generated attachments by their stable title");
  assert(controller.includes('await Zotero.Items.trashTx(id);'), "old generated attachments must be moved to trash before importing replacements");
  assert(!controller.includes('item.trashTx()'), "attachment replacement must use Zotero.Items.trashTx(), not a nonexistent item method");
  assert(controller.includes('page.drawPage(embedded,'), "comparison PDF must draw source and translation pages together");
  assert(controller.includes('const normalizePDFBytes = value => value instanceof global.Uint8Array'), "pdf-lib inputs must be normalized into its privileged runtime realm");
  assert(controller.includes('let stableChecks = 0;'), "PDF export must wait for the asynchronous writer to finish reading print DOM");
  assert(controller.includes('if (stableChecks < 12)'), "PDF export must not clean up its print snapshot after only the first written bytes");
  assert(controller.includes('const expectedPages = Math.max(0, Number(payload.expectedPages || 0));'), "printed layout PDFs must verify their expected page count");
  assert(controller.includes('const contentIndexes = Array.from({ length: expectedPages }, (_, index) => index * 2);'), "an exact Gecko continuation-page double must be compacted before page-count validation");
  assert(!controller.includes('const layoutScale = Number(payload.layoutScale || 0);'), "layout pages must be paint-scaled before printing instead of rewritten after printing");
  assert(controller.includes('const layoutPDFIdentity = String(payload.layoutIdentity || "")'), "controller must use the completed layout identity provided by the workbench");
  assert(workbench.includes('queueLayoutPDFAttachmentsAfterFinalPublication();'), "final layout event must queue PDF attachment generation");
  assert(workbench.includes('if (result?.meta?.complete === true) queueLayoutPDFAttachmentsAfterFinalPublication();'), "the first completed layout response must provide the PDF-generation fallback");
  assert(controller.includes('await this.storage.setDocumentMeta(context.documentID, { layoutPDFIdentity })'), "completed PDF exports must be persisted to avoid duplicate regeneration");
  assert(workbench.includes('withLayoutPaintPrintRoot((expectedPages, layoutPaper) =>'), "automatic PDF generation must reuse the same complete-page print root as manual export");
  assert(workbench.includes('async function waitForLayoutPDFReady()'), "PDF exports must wait for the translated layout to finish fitting");
  assert(workbench.includes('if (!await waitForLayoutPDFReady()) return null;'), "automatic attachment exports must defer while the fitting mask is active");
  assert(workbench.includes('async function withLayoutPaintPrintRoot(callback)'), "PDF export must build an isolated complete-page print root");
  assert(workbench.includes('const clone = page.cloneNode(true);'), "PDF export must retain the complete fitted page DOM");
  assert(workbench.includes('const printScale = 96 / 72;'), "source-point page coordinates must be converted to the 96dpi print canvas before printing");
  assert(workbench.includes('clone.style.transform = `scale(${printScale})`;'), "the complete page must receive one paint-only scale without rebuilding text or formulas");
  assert(workbench.includes('sheet.style.height = `${Math.max(1, printPaper.height - 1)}px`;'), "the paint container must absorb custom-paper quantization without a continuation page");
  assert(workbench.includes('contain:layout paint'), "each complete print page must contain scaled paint to prevent a blank continuation page");
  assert(workbench.includes('hostCall("export-pdf", { pane, layout: true, expectedPages, layoutPaper })'), "manual PDF export must use the same already-scaled print DOM as automatic export");
  assert(workbench.includes('document.body.dataset.printLayout = "false";'), "only stream exports may enable the legacy live-DOM print stylesheet");
  assert(workbench.includes('hostCall("create-layout-pdf-attachments", { layoutIdentity, targetLanguage, expectedPages, layoutPaper })'), "automatic PDF attachments must preserve the completed translation language while using the same already-scaled print DOM as manual export");
  assert(!workbench.includes('page:litmtransFrozen${index}'), "frozen PDF pages must not use Gecko's named-page continuation path");
  assert(!controller.includes('page.setSize(width, height);'), "all layout pages must retain the same common print sheet instead of restoring mixed source MediaBoxes");
  assert(!controller.includes('layoutPageSizes'), "mixed per-page source sizes must not be sent into post-print PDF rewriting");
  assert(workbench.includes('const LAYOUT_PDF_EXPORT_REVISION = 20;'), "an exporter change must replace stale generated PDF attachments without rerunning translation");
  assert(controller.includes('settings.paperWidth = paperWidth / 96;'), "layout PDF printing must explicitly set the native paper width instead of falling back to Letter");
  assert(controller.includes('settings.paperHeight = paperHeight / 96;'), "layout PDF printing must explicitly set the native paper height instead of falling back to Letter");
  assert(!controller.includes('settings.paperName ='), "layout PDF printing must not add unsupported properties to Zotero's WrappedNative print settings");
  assert(workbench.includes('transform:scale(${printScale}) !important;'), "text and KaTeX must remain in one inline layout and receive the same paint transform");
  assert(!workbench.includes('hostCall("export-pdf", { pane, layout: true, expectedPages, layoutScale:'), "layout PDF export must not request post-print content scaling");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(workbenchCSS.includes('body[data-print-pane] .toast-region,'), "print output must exclude transient completion toasts");
}

function testLayoutBodyLeadingIsSlightlyRelaxed() {
  const layout = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  assert(layout.includes('Math.min(1.28, Math.max(1.22, inferredBodyStyle[1] + .06))'),
    "translated body leading must preserve the Python render_translated_layout formula");
}

function testLayoutCapacityUsesTranslatedText() {
  const layout = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  assert(layout.includes("function translatedFlowPlainText(part)"));
  assert(layout.includes("Math.floor((text.length - first + full - 1) / full)"),
    "stream wrapping must preserve Python's floating-point floor expression");
  assert(layout.includes('part?.translatedText || part?.text'));
  assert(layout.includes(".map(translatedFlowPlainText)"),
    "stream capacity must measure the translation that the browser renders");
  assert.equal(
    LayoutHelpers.translatedFlowPlainText({ translatedText: "正文<sup>12</sup>与\\(x &gt; 1\\)" }),
    "正文 12 与\\(x &gt; 1\\)",
    "capacity text must match Python body_text_from_html tag spacing and entity preservation"
  );
  assert.equal(LayoutHelpers.fixedLayoutFontSize("chart_caption"), 7.6);
  assert.equal(LayoutHelpers.fixedLayoutFontSize("table_footnote"), 7.2);
  assert.equal(LayoutHelpers.fixedLayoutFontSize("image_footnote"), 7.2);
  assert(layout.includes("cached.version === 11"));
  assert(layout.includes("version: 11"));
  assert(layout.includes("String(record?.translatedText || text)"),
    "absolute title and caption estimates must see the text that is rendered");
}

function testLayoutCollisionGeometryUsesSourcePdfCoordinates() {
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  assert(workbench.includes('node.dataset.fitBandRatio = "0.120"'),
    "caption blocks must preserve Python's frame-relative fit band");
  assert(workbench.includes('table_caption|table_footnote|chart_caption|image_caption|image_footnote'),
    "image footnotes must use the caption fit band");
  assert(workbench.includes("tuneCaptionGroup('.layout-block.type-image_footnote');"),
    "image footnotes must participate in caption collision iteration");
  assert(workbench.includes("function layoutPageCoordinateScale(page)"),
    "the canonical reader page needs an explicit source-coordinate conversion");
  assert(workbench.includes("/ scaleX / coordinateScale"));
  assert(workbench.includes("/ scaleY / coordinateScale"));
  assert(workbench.includes("const pageWidth = layoutPageSourceSize(page).width"));
  assert(workbench.includes("rect.right > pageSize.width + 1.5"));
  assert(workbench.includes("rect.bottom > pageSize.height + 1.5"));
}

function testLayoutComposesAtSourcePdfDimensions() {
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(workbench.includes('const canonicalWidth = Math.max(1, Number(page.width) || 1)'));
  assert(workbench.includes('node.dataset.layoutFontScale = "1"'));
  assert(workbench.includes('pageNode.style.setProperty("--layout-scale", "1")'));
  assert(!workbench.includes('node.dataset.layoutFontScale = String(920 /'),
    "920px must remain a display limit rather than a second layout coordinate system");
  assert(css.includes("width: var(--layout-canonical-width, 612px)"));
  assert(css.includes(".layout-line-debug-box { position: absolute; z-index: 5; display: none;"));
  assert(css.includes(".layout-debug .layout-line-debug-box { display: block; }"),
    "original MinerU line boxes must never leak into the production reader");
}

function testBundledSourceHanSerif() {
  const css = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  const font = path.join(root, "assets", "fonts", "SourceHanSerifCN-Regular.ttf");
  const license = path.join(root, "assets", "fonts", "LICENSE-SourceHanSerif.txt");

  assert(fs.existsSync(font), "the reading font must be shipped with the plugin");
  assert(fs.statSync(font).size > 10_000_000, "the bundled font must not be a placeholder");
  assert(fs.existsSync(license), "the bundled font license must be shipped with the plugin");
  assert(css.includes('font-family: "LitMTrans Source Han Serif"'), "the reader must declare its bundled font face");
  assert(css.includes('url("../assets/fonts/SourceHanSerifCN-Regular.ttf")'), "the reader must load the bundled font asset");
  assert(css.includes(".layout-block .katex { font-size: 100%; }"),
    "KaTeX must use the Python MathJax root scale inside layout blocks");
  assert(css.includes('.katex:not(.katex-display) { font-size: 92%; }'),
    "translated body formulas must preserve Python's optical scale");
}

function testLayoutMultiPassTargetedRetryWithErrorFeedback() {
  const layoutCode = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  assert(
    layoutCode.includes('RETRY_REASON_DESCRIPTIONS'),
    "layout service must define RETRY_REASON_DESCRIPTIONS for mapping block errors"
  );
  assert(
    layoutCode.includes("retry_reasons: reasons || []"),
    "layout retry payload must include heuristic retry reasons for LLM"
  );
  assert(
    layoutCode.includes('const maxAttempts = 1;'),
    "group retry loop must issue at most one targeted repair"
  );
  assert(
    layoutCode.includes('attempt === 1 && !retryFormatOnly ? primaryMessages'),
    "only non-format first retries may retain the complete source-group context"
  );
  assert(
    layoutCode.includes("not factual conclusions; they can be false positives or false negatives"),
    "layout retry prompt must describe automated quality signals as fallible heuristics"
  );
  assert(
    layoutCode.includes('repair_mode: isFormatOnlyRetryReasons(reasons)'),
    "layout retry payload must distinguish symbol-format-only repairs"
  );
  assert(
    layoutCode.includes('const maxDocumentRetryPasses = 1;'),
    "document recovery phase must issue at most one targeted pass"
  );
}

function testLayoutFitParityForTitlesAndGlyphCollision() {
  const layoutCode = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  const workbenchCode = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(
    layoutCode.includes("bboxHeight(block.bbox) >= Math.max(24, pageHeight * .035)"),
    "layout model must use desktop-equivalent geometry for later article titles"
  );
  assert(workbenchCode.includes("function runLayoutParityEngine(pageWraps = null, persist = false)"),
    "the runtime reader must have one named Python-parity layout engine");
  assert(workbenchCode.includes("const MAX_CONSECUTIVE_LAYOUT_FIT_PASSES = 2;"),
    "a feedbacking page-size observer must not monopolize the Zotero UI thread with unbounded fits");
  assert(workbenchCode.includes("const observerTarget = documentRoot || wrap;")
    && workbenchCode.includes("observer.observe(observerTarget)"),
  "layout resizes must observe the reader width, not each height-mutating page wrapper");
  assert(workbenchCode.includes("const MAX_FINAL_COLLISION_REPAIRS_PER_NODE = 192;"),
    "one malformed text frame must have a local final-audit repair limit");
  assert(workbenchCode.includes("let scanIndex = 0;")
    && workbenchCode.includes("textCollisionDetails([candidate], options)")
    && workbenchCode.includes("while (scanIndex < nodes.length)"),
  "final collision safety must recheck only the source that just moved instead of rescanning every page");
  assert(!workbenchCode.includes("for (let safety = 0; safety < 3000; safety += 1)"),
    "the old 3,000-pass whole-document final collision scan must not return");
  assert(layoutCode.includes("if (isMainTitle) {\n        // A title remains the article's main title"),
    "main-title classification must not depend on whether a publisher first page exposes a body stream");
  assert(layoutCode.includes("cached.version === 11"),
    "models compiled before nomenclature-row paragraph restoration must be rebuilt");
  assert(!workbenchCode.includes("function runPythonParityFit("),
    "the previous parity-engine name must not leave a second callable engine behind");
  assert(workbenchCode.includes("function rectUnion(rects)"),
    "the parity fitter must define the rendered-text union helper used by title recovery");
  assert(workbenchCode.includes("contentBounds: contentGeometry.bounds"),
    "the parity fitter must retain the union broad phase before exact glyph collision tests");
  assert(workbenchCode.includes("layout-fit-v43-logical-span-lines"),
    "the parity engine must invalidate styles created before embedded span lines were counted");
  const shortTitleRepair = workbenchCode.slice(
    workbenchCode.indexOf("function keepShortTitlesOnOneLine(selector, options = {})"),
    workbenchCode.indexOf("// Monotone collision-constrained growth")
  );
  assert(shortTitleRepair.includes("renderedTextLineCount(node) <= 1")
    && !shortTitleRepair.includes("dataset.originalLines"),
  "short-title repair must use actual rendered lines instead of MinerU's single-line label");
  assert(shortTitleRepair.includes("node.style.whiteSpace = 'nowrap';")
    && shortTitleRepair.includes("borrowedWidth > maxBorrowPx")
    && shortTitleRepair.includes("requiredWidth / ownWidth > maxWidthRatio"),
  "short-title repair must remain a tightly bounded no-wrap exception");
  assert(shortTitleRepair.includes("requiredWidth * coordinateScale")
    && shortTitleRepair.includes("textCollisionDetails([node]")
    && shortTitleRepair.includes("avoidPageOverflow: true"),
  "short-title borrowing must use Zotero page scaling and exact collision safety");
  assert(workbenchCode.includes("keepShortTitlesOnOneLine('.layout-block.type-title:not(.main-title)'"),
    "short-title borrowing must exclude article titles and ordinary text blocks");
  assert(workbenchCode.includes("fitLayoutFormulas(pages);\n    runLayoutParityEngine(wraps, false);"),
    "formula boxes must converge before they become barriers for the text fitter");
  assert(workbenchCode.includes('formula.style.width = "max-content"'));
  assert(workbenchCode.includes('formula.style.maxWidth = "none"'),
    "equation fitting must measure intrinsic formula content rather than a capped wrapper");
  assert(workbenchCode.includes("const availableWidth = Math.max(1, blockRect.width - 4);"),
    "formula fitting must retain the original width-only rule");
  assert(!workbenchCode.includes("const availableHeight = Math.max(1, blockRect.height - 2);"),
    "equation numbering must not add a formula-height fitting rule");
  assert(workbenchCSS.includes(".layout-block.layout-formula { display: grid; place-items: center; overflow: visible; text-align: center; }"),
    "equation numbering must not clip formula or neighboring text frames");
  const flowRule = workbenchCSS.match(/\.layout-flow-stream\s*\{([^}]*)\}/)?.[1] || "";
  assert(/\boverflow:\s*visible;/.test(flowRule),
    "layout flow streams must expose collision-safe text that extends beyond MinerU's source bbox");
  assert(workbenchCode.includes(".mjx-assistive-mml, .katex-mathml"));
  assert(workbenchCode.includes("!parent.closest('.katex-html')"),
    "KaTeX's visible aria-hidden HTML glyphs must be measured while its hidden MathML is excluded");
  assert(workbenchCode.includes("const firstLineTopCollision = !isBodyText"));
  assert(workbenchCode.includes("lineRatio = Math.min(1.85, lineRatio + 0.025)"),
    "top-edge glyph collisions must move the first baseline down instead of farther up");
  assert(workbenchCode.includes("const overflowTolerance = 1.5 * coordinateScale"),
    "canonical-page height measurements must scale the Python source-pixel tolerance");
  assert(workbenchCode.includes("snapshot?.version !== 11")
    && workbenchCode.includes("snapshot.pages.length !== requested.length")
    && workbenchCode.includes("return restored;"),
    "the runtime must reject old or partial snapshots instead of mixing per-page solves");
  assert(workbenchCode.includes('if (fittedTranslation) reflectAutomaticLayoutFont(els["translation-layout"])'),
    "every automatic refit must publish its final body font to the control");
  assert(workbenchCode.includes("node.dataset.originalLines = originalLineCount > 1 ? \"multi\" : \"single\""),
    "absolute text blocks must expose Python's original-lines contract to the fitter");
  assert(layoutCode.includes("lineCount: Math.max(1, Number(block._layout_original_line_count"),
    "the restored absolute-text model must retain original line counts");
  assert(workbenchCode.includes("refreshLayoutPageScales(pageWraps);\n      resetBodyIterationInspection"),
    "the core parity engine must preserve Python's scale-before-glyph-measurement call order");
  assert(workbenchCode.includes("function continueUnderfilledNodes(nodes, options)"),
    "the runtime reader must retain Python's second body-text iteration");
  assert(workbenchCode.includes("reason=line-backoff-exhausted"),
    "a failed body-text growth round must roll back instead of shrinking one body block");
  assert(workbenchCode.includes("collisionMinLineRatio: 1.02")
    && workbenchCode.includes("const sourceMinLineRatio = minLineRatio;")
    && workbenchCode.includes("const minLineRatio = isBodyText ? 1.02 : 0.98;"),
  "body-text collision recovery must use the 1.02 local line-height minimum");
  assert(workbenchCode.includes("bodyColumnIndependentFit: true"),
    "body-text fitting must preserve Python's independent-column rule");
  assert(workbenchCode.includes("function enforceFinalTextCollisionSafety()"),
    "the runtime reader must retain Python's final glyph-level safety audit");
  assert(workbenchCode.includes("function syncInheritedBodyFontToBodyGroup()")
    && workbenchCode.includes("syncInheritedBodyFontToBodyGroup();"),
  "single-column short transitions must inherit the final shared body font before the final audit");
  assert(workbenchCode.includes("const ALLOW_INHERITED_BODY_FONT_BACKOFF = true;")
    && workbenchCode.includes("if (ALLOW_INHERITED_BODY_FONT_BACKOFF && isInheritedBodyText"),
  "the final audit must allow only a colliding inherited transition to shrink locally");
  assert(
    workbenchCode.includes("if (firstBad === -1 && lastOk < ticks)")
      && workbenchCode.includes("if (collides(at(ticks))) firstBad = ticks;"),
    "galloping font search must probe its unvisited tail before accepting the maximum size"
  );
  assert(workbenchCode.includes("runLayoutParityEngine(wraps, false);"),
    "fitLayoutPages must route normal rendering through the sole parity engine");
  assert(workbenchCSS.includes(".layout-debug .layout-flow-stream[data-fit-label]::after"),
    "fit diagnostics must be visible only in explicit layout-debug mode");
  assert(workbenchCSS.includes(".layout-fit-pending .layout-page-wrap {\n  /* The fitter measures real Range glyph rectangles"),
    "pending layout pages must stay measurable while their paint is masked");
  assert(workbenchCSS.includes(".layout-fit-measuring .layout-page-wrap {")
    && workbenchCSS.includes("content-visibility: visible;")
    && workbenchCode.includes('root.classList.add("layout-fit-measuring")')
    && workbenchCode.includes('root.classList.remove("layout-fit-measuring")'),
    "every cold or later document-wide fit must materialize off-screen page glyphs");
  assert(!workbenchCSS.includes(".layout-fit-pending .layout-page-wrap { visibility: hidden; }"),
    "visibility:hidden must never erase glyphs from the collision fitter");
  assert(workbenchCode.includes("if (!visiblePages.length) return false;"),
    "a hidden translated pane must not be treated as a completed layout fit");
  assert(workbenchCode.includes("function scheduleLayoutPaneSettle(container, scroll, renderVersion, position = null)"),
    "translated layouts must retain a versioned settle task until visible measurement succeeds");
  assert(workbenchCode.includes('classList.contains("layout-fit-pending")'),
    "showing a previously hidden translated pane must resume its document-wide fit");
  assert(!workbenchCSS.includes("\n.layout-flow-stream[data-fit-label]::after,"),
    "fit diagnostics must never leak into ordinary reader pages");
}

  return {
    testLayout,
    testLayoutEquationBarrier,
    testSingleColumnBodyPromotion,
    testEquationNumberAnchorUsesLocalColumns,
    testLayoutCodeAndContentsRules,
    testLayoutTranslationValidation,
    testManualLayoutJSONLProtocol,
    testDeferredLayoutRetryPreservesTrueMissingState,
    testLayoutWholePaperGrouping,
    testLayoutConcurrentGroupsAndCache,
    testDeepSeekFastLayoutWarmupConcurrencyAndTelemetry,
    testDeepSeekFastLayoutStopsBeforeParallelWaveWhenProbeIsBelowThreshold,
    testStaleDeepSeekFastPreferenceDoesNotAffectGemini,
    testLayoutRetriesFailedTransportGroupOnce,
    testLayoutFullContextIgnoresChunkLimits,
    testLayoutTargetedRetryKeepsPrimaryPrefix,
    testLayoutFirstRetryContextPolicy,
    testLayoutFormatRetryIsSurgicalAndBounded,
    testCompleteReferenceCorpus,
    testLayoutReaderIsAvailableBeforeParsing,
    testCompletedLayoutCreatesPDFItemAttachments,
    testLayoutBodyLeadingIsSlightlyRelaxed,
    testLayoutCapacityUsesTranslatedText,
    testLayoutCollisionGeometryUsesSourcePdfCoordinates,
    testLayoutComposesAtSourcePdfDimensions,
    testBundledSourceHanSerif,
    testLayoutMultiPassTargetedRetryWithErrorFeedback,
    testLayoutFitParityForTitlesAndGlyphCollision,
  };
};
