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
      ],
      discarded_blocks: [
        { type: "header", bbox: [50, 12, 250, 28], lines: [{ spans: [{ type: "text", content: "Journal header" }] }] },
        { type: "footer", bbox: [50, 760, 300, 776], lines: [{ spans: [{ type: "text", content: "Journal footer 4/18" }] }] },
        { type: "footer", bbox: [580, 200, 590, 500], lines: [{ spans: [{ type: "text", content: "Side label" }] }] },
        { type: "aside_text", bbox: [580, 300, 590, 500], lines: [{ spans: [{ type: "text", content: "Watermark" }] }] }
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
  const legacyCompiled = { version: 11, model: { pages: [{ blocks: [] }] } };
  files.set("/data/1-ABC/compiled-model.json", legacyCompiled);
  rawReadCount = 0;
  await service.buildModel(documentID, translations, null, revision);
  assert.equal(rawReadCount, 1, "an older compiled model must be regenerated from the saved layout");
  assert.deepEqual(files.get("/data/1-ABC/compiled-model.json"), legacyCompiled,
    "upgrading must leave the older compiled model untouched");
  assert.equal(files.get("/data/1-ABC/compiled-model.v13.json")?.version, 13);
  rawReadCount = 0;
  await service.buildModel(documentID, translations, null, revision);
  assert.equal(rawReadCount, 0, "the upgraded sidecar must avoid repeated layout reads");
  assert.equal(model.pages.length, 1);
  assert.equal(model.pages[0].blocks[0].id, "p001_b0001");
  assert.equal(model.pages[0].blocks[0].translatedText, "译文标题");
  assert.equal(model.pages[0].blocks[2].kind, "formula", "equation blocks with an image crop must remain semantic formulas");
  assert.equal(model.pages[0].blocks[2].imageURL, "", "formula crops must not replace the TeX renderer");
  assert.equal(model.pages[0].blocks[3].imageURL, "resource://litmtrans-data/1-ABC/assets/figure.png");
  const furniture = model.pages[0].restoration.absoluteBlocks.filter(block => block.sourceOnly);
  assert.deepEqual(furniture.map(block => block.text), ["Journal header", "Journal footer 4/18"],
    "only horizontal page headers and footers must be restored, never side text");
  assert.deepEqual(furniture.map(block => block.type), ["page_header", "page_footer"]);
  assert(furniture.every(block => block.sourceHTML && !block.translatedText),
    "restored page furniture must reuse its original text without changing translation records");
  assert(model.pages[0].restoration.absoluteBlocks.some(block => block.sourceOnly),
    "page furniture must enter the blocks before body fitting");
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
  assert(workbenchSource.includes("const minLineRatio = 1.05;"), "code fitting must preserve its configured minimum line-height");
  assert(workbenchCSS.includes("line-height: inherit;"), "code line-height must inherit the fitted parent value");
  assert(workbenchSource.includes("renderLayoutTocRows"), "the workbench must use the dedicated contents row renderer");
  assert(
    workbenchSource.includes("tuneEach('.layout-flow-stream.debug-text[data-flow-kind=\"text\"][data-original-lines=\"multi\"],"),
    "multi-line text must retain its fitting selector alongside single-line abstracts"
  );
  assert(workbenchSource.includes('litmtrans-layout-fit-runtime:snapshot-v${LAYOUT_FIT_SNAPSHOT_VERSION}:')
    && Number(workbenchSource.match(/const LAYOUT_FIT_SNAPSHOT_VERSION = (\d+);/)[1]) > 12,
    "layout fitting must invalidate snapshots that predate the current rules");
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
  assert.equal(
    parser.parseTranslationResponse(
      JSON.stringify({ translations: [{ id: "transport", text: "译文\b" }], formula_replacements: [] }),
      [transportRecord],
      { sanitizeUnsafe: true }
    ).translations.transport,
    "译文",
    "control characters must be removed without discarding the translated block"
  );
  assert.equal(
    parser.parseTranslationResponse(
      JSON.stringify({ translations: [{ id: "transport", text: "译文\b控制字符" }], formula_replacements: [] }),
      [transportRecord],
      { sanitizeUnsafe: true, allowSanitized: true }
    ).translations.transport,
    "译文控制字符",
    "retry and manual parsing must sanitize unsafe control characters and keep valid model translations"
  );
  const rawFormulaResponse = '{"translations":[{"id":"transport","text":"$\\frac{1}{2}$、$\\tfrac{a}{b}$、$\\textbf{测试}$、$\\not y$、$\\rangle$"}]}';
  const parsedFormulaResponse = parser.parseTranslationResponse(
    rawFormulaResponse,
    [transportRecord],
    { sanitizeUnsafe: true }
  ).translations;
  assert(parsedFormulaResponse.transport.includes("\\frac{1}{2}"),
    "production parser must preserve \\frac");
  assert(parsedFormulaResponse.transport.includes("\\tfrac{a}{b}"),
    "production parser must preserve \\tfrac");
  assert(parsedFormulaResponse.transport.includes("\\textbf{测试}"),
    "production parser must preserve \\textbf");
  assert(parsedFormulaResponse.transport.includes("\\not y"),
    "production parser must preserve \\not");
  assert(parsedFormulaResponse.transport.includes("\\rangle"),
    "production parser must preserve \\rangle");
  const shortDamagedResponse = '{"translations":[{"id":"transport","text":"引言"}';
  assert.equal(
    parser.parseTranslationResponse(shortDamagedResponse, [transportRecord]).translations.transport,
    "引言",
    "short damaged transport responses must salvage a complete block"
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
  assert.equal(
    LayoutHelpers.plainBlockText({
      lines: [{ spans: [
        { type: "text", content: "sample (\u0005100 lm separation)" }
      ] }]
    }),
    "sample (100 lm separation)",
    "plainBlockText must sanitize OCR control characters before sending to model"
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

  const chineseFragment = {
    id: "zh-fragment",
    type: "text",
    text: "实验结果表明，该方法在三个公开基准数据集上均显著优于现有最先进的基线算法。"
  };
  const normalEnglishTranslation = "Experimental results demonstrate that our proposed method significantly outperforms existing state-of-the-art baseline algorithms on three public benchmark datasets.";
  assert.equal(
    LayoutHelpers.looksOverexpanded(chineseFragment, normalEnglishTranslation, "English"),
    false,
    "valid Chinese to English translation must not be flagged as overexpanded"
  );
  assert.equal(
    LayoutHelpers.recordsNeedingRetry([chineseFragment], { [chineseFragment.id]: normalEnglishTranslation }, "English").length,
    0,
    "valid Chinese to English translation must not trigger retry"
  );
  assert.equal(
    LayoutHelpers.looksUntranslated(chineseFragment, chineseFragment.text, "English"),
    true,
    "Chinese source returned unchanged in English translation must be flagged as untranslated"
  );
  const zhToEnUntranslatedRetry = LayoutHelpers.classifyRetryRecords(
    [chineseFragment],
    { [chineseFragment.id]: chineseFragment.text },
    "English",
    true
  );
  assert.equal(zhToEnUntranslatedRetry.length, 0,
    "an unchanged nonempty answer must be accepted even when language heuristics disagree");

  assert.equal(
    LayoutHelpers.looksUntranslated(fragment, fragment.text, "简体中文"),
    true,
    "English source returned unchanged in Chinese translation must be flagged as untranslated"
  );

  const shortTechFormulaText = {
    id: "short-tech",
    type: "text",
    text: "p < 0.05"
  };
  assert.equal(
    LayoutHelpers.looksUntranslated(shortTechFormulaText, "p < 0.05", "简体中文"),
    false,
    "short technical text like 'p < 0.05' unchanged must not be flagged as untranslated in English-to-Chinese"
  );
  assert.equal(
    LayoutHelpers.recordsNeedingRetry(
      [shortTechFormulaText],
      { [shortTechFormulaText.id]: "p < 0.05" },
      "简体中文",
      true
    ).length,
    0,
    "short technical text unchanged must not trigger retry in English-to-Chinese even with enableUntranslatedCheck=true"
  );

  assert(
    LayoutHelpers.looksOverexpanded(
      chineseFragment,
      normalEnglishTranslation.repeat(10),
      "English"
    ),
    "runaway repetition in Chinese to English translation must still be caught as overexpanded"
  );

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
    0,
    "a formula delimiter difference must not trigger automatic retranslation of nonempty content"
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
  service.loadLayout = async () => ({ rawText: "manual-jsonl-source", pages: [] });
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
            ? ""
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

async function testLayoutAcceptsNonemptyAnswersWithoutQualityRetries() {
  for (const web of [false, true]) {
    const storage = new MemoryStorage();
    const records = [
      { id: "a", page: 1, type: "text", text: "An English source sentence that the model chooses to keep unchanged for this particular translation." },
      { id: "b", page: 1, type: "text", text: "First distinct source paragraph." },
      { id: "c", page: 1, type: "text", text: "Second distinct source paragraph." },
      { id: "d", page: 1, type: "text", text: "The value is \\(x+y\\)." },
      { id: "e", page: 1, type: "text", text: "Text with a transport artefact." }
    ];
    const answers = { a: records[0].text, b: "模型选择的长译文。".repeat(30), c: "模型选择的长译文。".repeat(30), d: "数值为 x+y。", e: "译文\b内容" };
    let calls = 0;
    const llm = {
      getSettings: () => ({ provider: "gemini", model: "test-model", targetLanguage: "简体中文" }),
      isWebEngineActive: () => web,
      resolveConfig: options => options,
      ensureConfiguredModel: async options => options,
      complete: async () => {
        calls++;
        return { text: JSON.stringify({ translations: records.map(record => ({ id: record.id, text: answers[record.id] })) }) };
      }
    };
    const service = new LayoutTranslationService(storage, llm);
    service.loadLayout = async () => ({ rawText: "nonempty-answer-source" });
    service.extractRecords = async () => records;
    service.extractFormulaContext = async () => [];
    service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
    const result = await service.translate("nonempty-answer", { mode: "full_context" });
    assert.equal(calls, 1, "unchanged, expanded, duplicated or formula-different answers must not trigger extra requests");
    assert.deepEqual({ ...result.translations }, { ...answers, e: "译文内容" });
    const cached = await service.translate("nonempty-answer", { mode: "full_context" });
    assert.equal(cached.cached, true, "accepted answers must remain usable from cache without heuristic retranslation");
    assert.equal(calls, 1);
    for (const payload of [{ id: "a", text: "已有译文" }, [{ id: "a", text: "已有译文" }]]) {
      assert.equal(service.parseTranslationResponse(JSON.stringify(payload), records).translations.a, "已有译文");
    }
    const missing = LayoutHelpers.classifyRetryRecords(records, { a: " ", b: "", c: "已有内容", d: "0" });
    assert.deepEqual(missing.map(item => item.record.id), ["a", "b", "e"]);
    assert(missing.every(item => item.reasons.length === 1 && item.reasons[0] === "missing"));
  }
}

async function testLayoutRetriesMissingBlocksAfterRepairOnce() {
  for (const fastMode of [false, true]) {
    for (const finishes of [false, true]) {
      const storage = new MemoryStorage();
      const records = [
        { id: "p001_b0001", page: 1, type: "text", text: "First source block." },
        { id: "p001_b0002", page: 1, type: "text", text: "Second source block." },
        { id: "p001_b0003", page: 1, type: "text", text: "Third source block." },
        { id: "p001_b0004", page: 1, type: "text", text: "The value is \\(x+1\\)." }
      ];
      const calls = [];
      const llm = {
        getSettings: () => ({
          provider: fastMode ? "deepseek" : "gemini", baseURL: "https://example.invalid", model: "test-model",
          apiKey: "test-key", targetLanguage: "简体中文", deepseekFastLayoutTranslation: fastMode
        }),
        resolveConfig: options => options,
        ensureConfiguredModel: async options => options
      };
      const service = new LayoutTranslationService(storage, llm);
      service.loadLayout = async () => ({ rawText: "missing-after-repair-source" });
      service.extractRecords = async () => records;
      service.extractFormulaContext = async () => [];
      service.buildGuide = async () => "";
      service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
      service.fastGroupRecords = group => [group];
      service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings) => {
        calls.push(group.map(record => record.id));
        if (calls.length === 1) {
          return { translations: { p001_b0001: "第一个完整译文。", p001_b0004: "数值。" }, formulaReplacements: {} };
        }
        assert(settings.deferLayoutRetry, "document repairs must not trigger nested retries");
        return {
          translations: calls.length === 2
            ? { p001_b0002: "第二个完整译文。", p001_b0004: "数值。" }
            : finishes ? { p001_b0003: "第三个完整译文。" } : {},
          formulaReplacements: {}
        };
      };
      const result = await service.translate("missing-after-repair", { mode: "full_context" });
      assert.deepEqual(calls, [
        records.map(record => record.id),
        ["p001_b0002", "p001_b0003"],
        ["p001_b0003"]
      ], "allow one extra request for missing blocks, without repeating successful or formula-only blocks");
      assert.equal(result.translations.p001_b0001, "第一个完整译文。");
      assert.equal(result.translations.p001_b0002, "第二个完整译文。");
      assert.equal(result.translations.p001_b0003, finishes ? "第三个完整译文。" : records[2].text,
        "if the last attempt still omits a block, retain the existing source-text fallback");
    }
  }
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
  assert.equal(calls.length, 2, "a legacy heuristic flag must not retranslate an accepted answer");
  assert.equal(enabledResult.translations[record.id], record.text);

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
  const result = await service.translateGroup(
    [record], "", "", "doc", "identity",
    { targetLanguage: "简体中文", enableUntranslatedCheck: false }, 0, 1, null, null
  );
  assert.equal(calls.length, 1, "formula heuristics must not trigger a paid retry for a nonempty answer");
  assert.equal(result.translations[record.id], "数值为 x+y。", "keep the model's original answer");
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
  assert(controller.includes('const translationTitle = `${targetLanguage}-译文-${stem}`;'), "generated translation PDFs must use the target-language prefix without a parser label");
  assert(controller.includes('const comparisonTitle = `${targetLanguage}-译文对照版-${stem}`;'), "generated comparison PDFs must use the target-language prefix without a parser label");
  assert(controller.includes('await this.createGeneratedPDFAttachment(context, translationPath, translationTitle)'));
  assert(controller.includes('await this.createGeneratedPDFAttachment(context, comparisonPath, comparisonTitle)'));
  assert(controller.includes('"generated-pdfs.json"') && !controller.includes('titles.has(Zotero.Items.get(id)?.getField?.("title"))'), "replacement must use generated ownership records instead of matching titles");
  assert(controller.includes('await Zotero.Items.trashTx(existingIDs);'), "confirmed old attachments must be moved to trash together after replacements are saved");
  assert(!controller.includes('item.trashTx()'), "attachment replacement must use Zotero.Items.trashTx(), not a nonexistent item method");
  assert(controller.includes('page.drawPage(embedded,'), "comparison PDF must draw source and translation pages together");
  assert(controller.includes('const normalizePDFBytes = value => value instanceof global.Uint8Array'), "pdf-lib inputs must be normalized into its privileged runtime realm");
  assert(controller.includes('let stableChecks = 0;'), "PDF export must wait for the asynchronous writer to finish reading print DOM");
  assert(controller.includes('if (stableChecks < 12)'), "PDF export must not clean up its print snapshot after only the first written bytes");
  assert(controller.includes('const expectedPages = Math.max(0, Number(payload.expectedPages || 0));'), "printed layout PDFs must verify their expected page count");
  assert(!controller.includes('const contentIndexes = Array.from({ length: expectedPages }, (_, index) => index * 2);'), "page counts alone must never authorize dropping alternating real PDF pages");
  assert(!controller.includes('const layoutScale = Number(payload.layoutScale || 0);'), "layout pages must be paint-scaled before printing instead of rewritten after printing");
  assert(controller.includes('const layoutPDFIdentity = String(payload.layoutIdentity || "")'), "controller must use the completed layout identity provided by the workbench");
  assert(workbench.includes('queueLayoutPDFAttachmentsAfterFinalPublication();'), "final layout event must queue PDF attachment generation");
  assert(workbench.includes('if (result?.meta?.complete === true) queueLayoutPDFAttachmentsAfterFinalPublication();'), "the first completed layout response must provide the PDF-generation fallback");
  assert(controller.includes('await this.storage.setDocumentMeta(context.documentID, { layoutPDFIdentity, tablePDFPending: false })'), "completed PDF exports must persist their identity and resolve pending table changes");
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
  assert(workbench.includes('hostCall("create-layout-pdf-attachments", { layoutIdentity, parseRevisionID, targetLanguage, expectedPages, layoutPaper })'), "automatic PDF attachments must carry their parse origin and completed translation language");
  assert(!workbench.includes('page:litmtransFrozen${index}'), "frozen PDF pages must not use Gecko's named-page continuation path");
  assert(!controller.includes('page.setSize(width, height);'), "all layout pages must retain the same common print sheet instead of restoring mixed source MediaBoxes");
  assert(!controller.includes('layoutPageSizes'), "mixed per-page source sizes must not be sent into post-print PDF rewriting");
  assert(Number(workbench.match(/const LAYOUT_PDF_EXPORT_REVISION = (\d+);/)[1]) >= 23,
    "an exporter change must replace stale generated PDF attachments without rerunning translation");
  assert(controller.includes('settings.paperWidth = paperWidth / 96;'), "layout PDF printing must explicitly set the native paper width instead of falling back to Letter");
  assert(controller.includes('settings.paperHeight = paperHeight / 96;'), "layout PDF printing must explicitly set the native paper height instead of falling back to Letter");
  assert(!controller.includes('settings.paperName ='), "layout PDF printing must not add unsupported properties to Zotero's WrappedNative print settings");
  assert(workbench.includes('transform:scale(${printScale}) !important;'), "text and KaTeX must remain in one inline layout and receive the same paint transform");
  assert(!workbench.includes('hostCall("export-pdf", { pane, layout: true, expectedPages, layoutScale:'), "layout PDF export must not request post-print content scaling");
  assert(workbench.includes('retranslationCount = Number(state.data?.layout?.meta?.retranslationCount || 0)'), "layout PDF export identity must incorporate retranslation revisions");
  const layout = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  assert(layout.includes('retranslationCount: Number(current.meta?.retranslationCount || 0) + 1'), "forced retranslations must increment retranslationCount");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(workbenchCSS.includes('body[data-print-pane] .toast-region,'), "print output must exclude transient completion toasts");
}

async function testWebMachineRetranslationIncrementsPDFRevision() {
  for (const provider of ["edge_local", "free_machine"]) {
    const documentID = "1-FREE-MACHINE";
    const stored = new Map();
    const paths = {
      root: "/test/free-machine",
      translations: "/test/free-machine/translations.json",
      formulaReplacements: "/test/free-machine/formula.json",
      meta: "/test/free-machine/meta.json"
    };
    let translationText = "第一版译文";
    let translationCalls = 0;
    let failTranslation = false;
    const events = [];
    const storage = {
      path: (...parts) => parts.join("/"),
      temporaryDir: () => "/test/staging",
      ensureDir: async () => {},
      readJSON: async (file, fallback) => stored.has(file) ? stored.get(file) : fallback,
      writeJSON: async (file, value) => { stored.set(file, JSON.parse(JSON.stringify(value))); },
      publishFilesAtomically: async entries => {
        for (const entry of entries) {
          assert(stored.has(entry.source), "the staged translation files must exist before publication");
          stored.set(entry.destination, stored.get(entry.source));
        }
      },
      remove: async () => {}
    };
    const service = {
      storage,
      paths: () => paths,
      webMachine: {
        translateRecords: async () => {
          translationCalls++;
          if (failTranslation) throw new Error("simulated machine translation failure");
          return { p001_b0001: translationText };
        }
      },
      loadLayout: async () => ({ rawText: "Source text" }),
      extractRecords: async () => [{ id: "p001_b0001", type: "text", text: "Source text" }],
      tableRequestPlan: () => ({ ids: new Set(), records: [], tables: [] }),
      loadTranslations: async () => ({
        meta: stored.get(paths.meta) || null,
        translations: stored.get(paths.translations) || {},
        formulaReplacements: stored.get(paths.formulaReplacements) || {}
      }),
      saveTableTranslations: async () => ({ tables: [] }),
      buildModel: async () => ({ pages: [{ blocks: [] }] })
    };
    const settings = { provider, targetLanguage: "简体中文", sourceLanguage: "en", machineSourceLanguage: "en", translateTables: false };
    const run = force => LayoutTranslationService.prototype.translateWebMachine.call(
      service, documentID, { ...settings, force }, event => events.push(event), null
    );
    const initial = await run(false);
    assert.equal(initial.meta.retranslationCount, undefined, "first-time machine translation must retain the legacy PDF identity");
    assert.equal(events.at(-1).meta.identity, initial.meta.identity, "the final publication event must carry persisted translation metadata");
    translationText = "第二版译文";
    const second = await run(true);
    assert.equal(second.meta.retranslationCount, 1, "first forced retranslation must advance the PDF export identity");
    assert.equal(stored.get(paths.meta).retranslationCount, 1, "the new revision must be persisted");
    assert.equal(events.at(-1).meta.retranslationCount, 1, "PDF generation must receive the revision in the completion event");
    translationText = "第三版译文";
    const third = await run(true);
    assert.equal(third.meta.retranslationCount, 2, "successive forced retranslations must advance monotonically");
    assert.equal(events.at(-1).meta.retranslationCount, 2);
    const cached = await run(false);
    assert.equal(cached.cached, true);
    assert.equal(cached.meta.retranslationCount, 2, "cache hits must not generate a new revision");
    assert.equal(events.at(-1).meta.retranslationCount, 2, "cached completion must still publish metadata");
    assert.equal(translationCalls, 3, "cache reuse must avoid repeated machine translation");
    failTranslation = true;
    await assert.rejects(run(true), /simulated machine translation failure/);
    assert.equal(stored.get(paths.meta).retranslationCount, 2, "a failed retranslation must preserve the last published revision");
  }
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
  assert(layout.includes("cached.version === 13"));
  assert(layout.includes("version: 13"));
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
    layoutCode.includes('const maxDocumentRetryPasses = 2;'),
    "document recovery may add only one missing-block pass after the targeted repair"
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
  assert(layoutCode.includes("cached.version === 13"),
    "models compiled before page furniture restoration must be rebuilt");
  assert(!workbenchCode.includes("function runPythonParityFit("),
    "the previous parity-engine name must not leave a second callable engine behind");
  assert(workbenchCode.includes("function rectUnion(rects)"),
    "the parity fitter must define the rendered-text union helper used by title recovery");
  assert(workbenchCode.includes("contentBounds: contentGeometry.bounds"),
    "the parity fitter must retain the union broad phase before exact glyph collision tests");
  assert(Number(workbenchCode.match(/const fitCacheVersion = 'layout-fit-v(\d+)/)[1]) >= 56,
    "the parity engine must invalidate styles created before final body style inheritance");
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
  assert(workbenchCode.includes("snapshot?.version !== LAYOUT_FIT_SNAPSHOT_VERSION")
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
  assert(workbenchCode.includes("collisionMinLineRatio: 1.1")
    && workbenchCode.includes("const sourceMinLineRatio = source.dataset.equationDense === '1' ? 1.02 : minLineRatio;")
    && workbenchCode.includes("const minLineRatio = source.dataset.equationDense === '1' ? 1.02 : 1.1;"),
  "collision recovery must preserve readable leading except for short equation-dense body text");
  assert(workbenchCSS.includes('.layout-flow-stream.equation-dense { line-height: 1.04 !important; }'),
    "short body text between equations must retain its compact leading");
  assert(workbenchCode.includes("bodyColumnIndependentFit: true"),
    "body-text fitting must preserve Python's independent-column rule");
  assert(workbenchCode.includes("function enforceFinalTextCollisionSafety(pages = null)"),
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
  assert(workbenchCSS.includes(".layout-debug .layout-flow-stream[data-debug-label]::after"),
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
  assert(!workbenchCSS.includes("\n.layout-flow-stream[data-debug-label]::after,"),
    "fit diagnostics must never leak into ordinary reader pages");
}

function testAbstractRecognitionAndBodyProtection() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helpers = source.slice(source.indexOf('  function abstractBlockIDs(model) {'), source.indexOf('  function buildLayoutDocument('));
  const detect = vm.runInNewContext(`${helpers}\nabstractBlockIDs`);
  const block = (id, type, text) => ({ id, type, text });
  for (const text of ['Abstract This paper describes a method.', 'Abstract\nThis paper describes a method.', 'Abstract. This paper describes a method.', 'Abstract—This paper describes a method.', '摘要：本文介绍方法。', '摘要\n本文介绍方法。']) {
    assert.deepEqual(Array.from(detect({ pages: [{ blocks: [block('a', 'text', text), block('end', 'text', 'Index Terms—Methods'), block('b', 'text', 'Body')] }] })), ['a']);
  }
  for (const text of ['Abstract', '1. Abstract', 'I. ABSTRACT', '摘 要']) {
    assert.deepEqual(Array.from(detect({ pages: [{ blocks: [block('heading', 'title', text), block('a', 'text', 'Summary'), block('end', 'text', '1. Motivation'), block('b', 'text', 'Body')] }] })), ['a']);
  }
  assert.deepEqual(Array.from(detect({ pages: [
    { blocks: [block('heading', 'title', 'Abstract'), block('a', 'text', 'Summary')] },
    { blocks: [block('b', 'text', 'Body on a later page without a heading')] }
  ] })), ['a']);
  const blocks = [block('heading', 'title', 'Abstract'), block('a', 'text', 'Summary'), block('body', 'text', 'Classified body'), block('following', 'text', 'Following body')];
  assert.deepEqual(Array.from(detect({ pages: [{ blocks, restoration: { streams: [{ styleKind: 'body_text', items: [{ id: 'merged', parts: [{ id: 'body' }] }] }] } }] })), ['a']);
  assert.deepEqual(Array.from(detect({ pages: [{ blocks: [block('heading', 'title', 'Abstract'), block('body', 'body_text', 'Body'), block('following', 'text', 'Following body')] }] })), []);
  const guard = vm.runInNewContext(`${helpers}\nshouldAdjustAbstractFont`);
  assert.equal(guard({ dataset: { abstractBody: '1', styleKind: 'body_text' } }), false);
  assert.equal(guard({ dataset: { abstractBody: '1', blockKind: 'body_text' } }), false);
  assert.equal(guard({ dataset: { styleKind: 'text' } }), false);
  const nodes = [
    { dataset: { abstractBody: '1', styleKind: 'text', layoutFontScale: '1' }, style: { fontSize: '10px' } },
    { dataset: { abstractBody: '1', styleKind: 'text', layoutFontScale: '2' }, style: { fontSize: '20px' } },
    { dataset: { abstractBody: '1', styleKind: 'body_text' }, style: { fontSize: '10px' } },
    { dataset: { abstractBody: '1', blockKind: 'body_text' }, style: { fontSize: '10px' } }
  ];
  const clearanceSource = source.slice(source.indexOf('  function applyFinalTextClearance('), source.indexOf('  function titleFrameFill('));
  vm.runInNewContext(`${clearanceSource}\napplyFinalTextClearance(new Map())`, {
    shouldAdjustAbstractFont: guard, scopedNodes: () => nodes,
    isOrdinaryMultilineText: () => false,
    layoutControlFontSize: node => parseFloat(node.style.fontSize) / Number(node.dataset.layoutFontScale || 1)
  });
  assert.deepEqual(nodes.map(node => node.style.fontSize), ['9.50px', '19.00px', '10px', '10px']);
  const manualStart = source.indexOf('  function applyLayoutBodyFont(pages) {');
  const manualSource = source.slice(manualStart, source.indexOf('  function applyLayoutFitSnapshot(', manualStart));
  const manual = vm.runInNewContext(`${manualSource}\napplyLayoutBodyFont`, { state: { layoutFontPt: 9 } });
  manual([{ querySelectorAll: () => [nodes[2]] }]);
  assert.equal(nodes[2].style.fontSize, '12.00px', 'manual body font must ignore an erroneous abstract marker and convert pt to px');
}

function testFinalTextClearanceBoundaries() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helpers = source.slice(source.indexOf('  function isOrdinaryMultilineText('), source.indexOf('  function titleFrameFill('));
  let peers = [];
  const page = { querySelectorAll: () => peers };
  const makeNode = (kind, box, font = 12.5, scale = 1) => ({
    dataset: { styleKind: kind === 'body' ? 'body_text' : 'text', layoutFontScale: String(scale) },
    style: { fontSize: `${font * scale}px`, lineHeight: '1.015' }, box,
    closest: () => page,
    matches: selector => selector.startsWith('.layout-title')
      ? ['title', 'caption'].includes(kind) : ['ordinary', 'body', 'caption'].includes(kind)
  });
  const api = vm.runInNewContext(`${helpers}\n({stoppedAtNextLowerBlock, applyFinalTextClearance})`, {
    scopedNodes: () => peers.filter(n => n.dataset.abstractBody === '1'),
    shouldAdjustAbstractFont: n => n.dataset.abstractBody === '1' && n.dataset.styleKind !== 'body_text',
    elementBoxInPage: n => n.box,
    horizontalBoxesOverlap: (a, b, tolerance) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance,
    layoutControlFontSize: n => parseFloat(n.style.fontSize) / Number(n.dataset.layoutFontScale || 1)
  });
  const own = { left: 10, right: 100, top: 10, bottom: 100 };
  const lower = { left: 10, right: 100, top: 110, bottom: 130 };
  const node = makeNode('ordinary', own);
  const blocker = makeNode('title', lower);
  peers = [node, blocker];
  const result = { fontSize: 12.5, stopReason: 'block-overlap', collision: { source: node, blocker, rect: { bottom: 115 } } };
  assert.equal(api.stoppedAtNextLowerBlock(node, result), true);
  assert.equal(api.stoppedAtNextLowerBlock(node, { ...result, stopReason: 'max-font' }), false);
  assert.equal(api.stoppedAtNextLowerBlock(node, { ...result, collision: { ...result.collision, blocker: null } }), false);
  for (const box of [{ ...lower, top: 0, bottom: 8 }, { ...lower, left: 110, right: 200 }]) {
    blocker.box = box;
    assert.equal(api.stoppedAtNextLowerBlock(node, result), false);
  }
  blocker.box = lower;
  peers.push(makeNode('title', { ...lower, top: 103 }));
  assert.equal(api.stoppedAtNextLowerBlock(node, result), false, 'must stop at the nearest lower block');
  peers.pop();
  const body = makeNode('body', own), caption = makeNode('caption', own), title = makeNode('title', own);
  for (const protectedNode of [body, caption, title]) {
    assert.equal(api.stoppedAtNextLowerBlock(protectedNode, { ...result, collision: { ...result.collision, source: protectedNode } }), false);
  }
  const repaired = makeNode('ordinary', own, 12.25);
  const scaled = makeNode('ordinary', own, 12.5, 2);
  const abstract = makeNode('ordinary', own);
  abstract.dataset.abstractBody = '1';
  peers.push(abstract);
  const fitted = new Map([node, body, caption, title, repaired, scaled, abstract].map(n => [n, 12.5]));
  api.applyFinalTextClearance(fitted);
  assert.equal(node.style.fontSize, '12.00px');
  assert.equal(node.style.lineHeight, '1.015');
  assert.equal(scaled.style.fontSize, '24.00px');
  assert.equal(abstract.style.fontSize, '12.00px', 'abstract must not shrink twice');
  assert.equal(repaired.style.fontSize, '12.25px', 'final repairs must not receive another reduction');
  for (const n of [body, caption, title]) assert.equal(n.style.fontSize, '12.5px');
  api.applyFinalTextClearance(new Map([[node, 12.5]]));
  assert.equal(node.style.fontSize, '12.00px', 'ordinary clearance must not accumulate');
  assert(source.indexOf('      applyFinalTextClearance(fittedTexts);') > source.indexOf('      enforceFinalTextCollisionSafety();'));
}

function testDualColumnBodyFontCandidateProtection() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function dualColumnBodyFontCandidates('), source.indexOf('  function buildLayoutDocument('));
  const find = vm.runInNewContext(`${helper}\ndualColumnBodyFontCandidates`, { Layout: LayoutHelpers });
  const prose = 'According to the theory, researchers measured atmospheric turbulence using repeated observations. The structure function can be calculated from the wind speed fluctuation term, and these measurements provide evidence for the relationship between energy dissipation and atmospheric motion.';
  const stream = (box, styleKind = 'text') => ({ bbox: box, styleKind, debugRole: styleKind === 'text' ? 'text' : 'merged_body',
    items: [{ id: 'candidate', kind: 'text', text: prose, originalLineCount: 20 }] });
  const candidate = stream([42, 99, 290, 722]);
  const baseline = stream([302, 62, 550, 471], 'body_text');
  const model = { pages: [
    { index: 1, width: 595, height: 842, restoration: { streams: [stream([43, 340, 289, 665], 'body_text')] } },
    { index: 2, width: 595, height: 842, restoration: { streams: [candidate, baseline] } }
  ] };
  const original = JSON.stringify(model);
  assert.deepEqual([...find(model)], [candidate]);
  assert.equal(JSON.stringify(model), original, 'marking must not mutate the cached model or merge streams');
  const cases = [
    m => { m.pages[1].index = 1; },
    m => { m.pages[0].restoration.streams = []; m.pages[1].restoration.streams[1].styleKind = 'text'; },
    m => { m.pages[1].restoration.streams.pop(); },
    m => { m.pages[1].restoration.streams[0].bbox = [195, 99, 576, 722]; },
    m => { m.pages[1].restoration.streams[0].items[0].text = 'Figure 2. ' + prose; },
    m => { m.pages[1].restoration.streams[0].items[0].fromList = true; },
    m => { m.pages[1].restoration.streams[0].items[0].originalLineCount = 3; },
    m => { m.pages[1].restoration.streams[0].refsOnly = true; }
  ];
  for (const change of cases) {
    const m = JSON.parse(original); change(m);
    assert.equal(find(m).size, 0);
  }
}

function testOffsetSingleColumnBodyProfile() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function offsetSingleColumnBodyProfile('), source.indexOf('  function promoteOffsetBodyNode('));
  const find = vm.runInNewContext(`${helper}\noffsetSingleColumnBodyProfile`, { Layout: LayoutHelpers });
  const prose = 'The researchers measured atmospheric turbulence using repeated observations over several years. These measurements provide evidence for the relationship between energy dissipation and atmospheric motion and explain the observed variation across different regions.';
  const stream = (id, bbox, text = prose, lines = 8) => ({ styleKind: 'text', debugRole: 'text', bbox,
    items: [{ id, kind: 'text', text, originalLineCount: lines, fontEstimate: 9.2 }] });
  const pages = [1, 2, 3].map(index => ({ index, width: 600, height: 800, restoration: { streams: [
    stream(`long${index}`, [192, 80, 564, 260]), stream(`other${index}`, [192, 300, 564, 490]),
    stream(`short${index}`, [192, 530, 550, 560], 'These measurements were collected from the same location.', 2),
    stream(`caption${index}`, [192, 600, 564, 650], 'Figure 2. ' + prose),
    stream(`side${index}`, [32, 80, 155, 260], 'Funding: ' + prose)
  ] } }));
  const model = { pages }; const original = JSON.stringify(model);
  const profile = find(model);
  assert.equal(profile.roles.size, 6, 'recover long and short paragraphs only in the repeated main lane after page one');
  assert.equal(profile.sourceFont, 9.2);
  assert.equal(profile.roles.get(pages[1].restoration.streams[2]), 'candidate');
  assert.equal(JSON.stringify(model), original, 'runtime marking must preserve all cached roles and geometry');
  for (const type of ['centered', 'dual-column', 'one-page', 'parallel-prose']) {
    const m = JSON.parse(original);
    if (type === 'one-page') m.pages = m.pages.slice(0, 2);
    else for (const page of m.pages) for (const s of page.restoration.streams) {
      if (type === 'parallel-prose' && s.bbox[0] < 100) s.items[0].text = prose;
      if (s.bbox[0] > 100 && type === 'centered') s.bbox = [48, s.bbox[1], 552, s.bbox[3]];
      if (s.bbox[0] > 100 && type === 'dual-column') s.bbox = [310, s.bbox[1], 565, s.bbox[3]];
    }
    assert.equal(find(m), null, type);
  }
  const m = JSON.parse(original); m.pages[1].restoration.streams[0].styleKind = 'body_text';
  const result = find(m, new Set(['short2']));
  assert.equal(result.roles.get(m.pages[1].restoration.streams[0]), 'donor');
  assert.equal(result.roles.has(m.pages[1].restoration.streams[2]), false, 'abstract membership must remain excluded');
}

function testOffsetBodyUnifiedFitPromotion() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function promoteOffsetBodyNode('), source.indexOf('  function buildLayoutDocument('));
  const promote = vm.runInNewContext(`${helper}\npromoteOffsetBodyNode`, {});
  const classes = new Set(['layout-flow-stream', 'debug-text']);
  const node = { dataset: { styleKind: 'text', baseFont: '7.6' }, style: { left: '195px', width: '381px', lineHeight: '1.28' },
    classList: { remove: value => classes.delete(value), add: value => classes.add(value) } };
  promote(node, 'candidate', 9.2);
  assert.equal(node.dataset.styleKind, 'body_text');
  assert.equal(node.dataset.baseFont, '9.2');
  assert.equal(node.dataset.bodyInherited, '0', 'short prose joins the uniform body solve instead of inheriting at the end');
  assert.equal(classes.has('debug-text'), false, 'promoted body must leave ordinary paragraph fitting and final minus-0.5');
  assert.equal(node.style.left, '195px'); assert.equal(node.style.width, '381px');
  const donor = { dataset: { styleKind: 'body_text', baseFont: '9.5' }, style: { lineHeight: '1.24' } };
  promote(donor, 'donor', 9.2);
  assert.equal(donor.dataset.baseFont, '9.5'); assert.equal(donor.style.lineHeight, '1.24');
  const engine = source.slice(source.indexOf('  function runLayoutParityEngine('));
  assert(engine.includes("not([data-offset-body-promoted=\"1\"])', bodyFitOptions)"));
  assert(engine.includes("[data-offset-body-role][data-style-kind=\"body_text\"][data-flow-kind=\"text\"]', bodyFitOptions)"),
    'the offset main lane must retain the same body fitting options and edge tolerance');
  assert(!source.includes('inheritFinalOffsetBodyStyle'), 'remove the superseded final style patch');
}

function testPublishedTranslationClearsWorkbenchFontOverride() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function resetLayoutFontForTranslation('), source.indexOf('  function handleEvent('));
  const state = { mode: 'layout', data: { item: { documentID: 'target', layoutPDFIdentity: 'old-pdf' } }, layoutPDFGenerationKey: 'old-key', settings: { layoutReaderFonts: { target: 5, other: 9 } }, layoutFontPt: 5, detectedLayoutFontPt: 5 };
  const body = { dataset: { userBodyFontPt: '5' } }; const input = { value: '5' };
  const reset = vm.runInNewContext(`${helper}\nresetLayoutFontForTranslation`, { state, document: { body }, els: { 'reader-font-input': input } });
  for (const event of [
    { complete: false, resetLayoutFont: true, documentID: 'target' },
    { complete: true, cached: true, resetLayoutFont: true, documentID: 'target' },
    { complete: true, resetLayoutFont: true, documentID: 'other' },
    { complete: true, documentID: 'target' }
  ]) { reset(event); assert.equal(state.layoutFontPt, 5); assert.equal(input.value, '5'); assert.equal(state.data.item.layoutPDFIdentity, 'old-pdf'); assert.equal(state.layoutPDFGenerationKey, 'old-key'); }
  reset({ complete: true, resetLayoutFont: true, documentID: 'target' });
  assert.equal(state.layoutFontPt, 0); assert.equal(state.detectedLayoutFontPt, 0);
  assert.equal(state.data.item.layoutPDFIdentity, ''); assert.equal(state.layoutPDFGenerationKey, '', 'fresh publication must regenerate PDFs even with unchanged translation settings');
  assert.equal(state.settings.layoutReaderFonts.target, undefined); assert.equal(state.settings.layoutReaderFonts.other, 9);
  assert.equal(body.dataset.userBodyFontPt, undefined); assert.equal(input.value, '');
  const handler = source.slice(source.indexOf('    if (type === "layout-translation")'), source.indexOf('    if (type === "chat-session")'));
  assert(handler.indexOf('resetLayoutFontForTranslation(event);') < handler.indexOf('renderLayoutPanes();'), 'clear the override before publishing and fitting the new DOM');
}

function testOffsetBodyToolbarFont() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const start = source.indexOf('  function reflectAutomaticLayoutFont(');
  const end = source.indexOf('\n  function ', start + 10);
  let main = { style: { fontSize: '11.75px' } };
  const legacy = { style: { fontSize: '8.75px' } };
  const container = { querySelector: selector => selector.includes('offset-body-role') ? main : legacy };
  const state = { mode: 'layout', layoutFontPt: 0 };
  const input = {}; const els = { 'translation-layout': container, 'reader-font-input': input };
  const reflect = vm.runInNewContext(`${source.slice(start, end)}\nreflectAutomaticLayoutFont`, {
    state, els, document: { documentElement: { style: { setProperty() {} } } }
  });
  reflect(container); assert.equal(input.value, '8.8', 'report the main reading lane rather than cached sidebar body metadata');
  main = null; reflect(container); assert.equal(input.value, '6.6', 'ordinary documents retain the original font-control selection');
}

function testLayoutFontMemoryFollowsRulesVersion() {
  const snapshot = new Map(prefValues);
  const constants = context.LitMTrans.Constants;
  const rulesVersion = constants.LAYOUT_READER_FONT_RULES_VERSION;
  const workbench = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const keyHelper = workbench.slice(workbench.indexOf('  function layoutFitSnapshotKey('), workbench.indexOf('  function layoutFitPageKey('));
  const snapshotKey = vm.runInNewContext(`${keyHelper}\nlayoutFitSnapshotKey`, {
    state: { layoutFontPt: 0, data: { item: { documentID: 'target' }, layout: { model: {} } } },
    LitMTrans: context.LitMTrans
  });
  try {
    const controller = context.LitMTrans.createController({ id: 'litmtrans@local', version: '2.1.3', rootURI: 'file:///plugin/' });
    U.setPref('readerFontPt', 15);
    U.setPref('layoutReaderFonts', JSON.stringify({ target: 9, other: 8 }));
    U.clearPref('layoutReaderFontRulesVersion');
    assert.deepEqual(controller.getLayoutReaderFonts(), {}, 'unversioned legacy font memories must return to automatic fitting');
    assert.equal(U.getPref('layoutReaderFontRulesVersion'), rulesVersion);
    assert.equal(U.getPref('readerFontPt'), 15, 'stream-reader typography must not be reset');
    controller.saveSettings({ layoutReaderFonts: { target: 18, other: 8 } });
    assert.equal(U.getPref('layoutReaderFontRulesVersion'), rulesVersion);
    assert.deepEqual(controller.getLayoutReaderFonts(), { target: 18, other: 8 });
    const reopened = context.LitMTrans.createController({ id: 'litmtrans@local', version: '2.1.4', rootURI: 'file:///plugin/' });
    assert.deepEqual(reopened.getLayoutReaderFonts(), { target: 18, other: 8 }, 'a plugin update with unchanged rules must retain new user choices');
    const previousSnapshotKey = snapshotKey();
    constants.LAYOUT_READER_FONT_RULES_VERSION = rulesVersion + 1;
    assert.notEqual(snapshotKey(), previousSnapshotKey, 'rule changes must also invalidate automatic-fit snapshots');
    assert.deepEqual(reopened.getLayoutReaderFonts(), {}, 'a later layout-rule change must invalidate the previous rules font memories');
    reopened.saveSettings({ layoutReaderFonts: { target: 20 } });
    assert.deepEqual(reopened.getLayoutReaderFonts(), { target: 20 }, 'new manual choices under the new rules must persist');
  } finally {
    constants.LAYOUT_READER_FONT_RULES_VERSION = rulesVersion;
    prefValues.clear(); for (const [key, value] of snapshot) prefValues.set(key, value);
  }
}

function testSingleLineTextInkAbstractRegionBoundary() {
  const { parseHTML } = require('linkedom');
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function fitSingleLineTextInk('), source.indexOf('  function measureTextBand('));
  const stream = (id, extra = '', kind = 'text', lines = 'single') =>
    `<div id="${id}" class="layout-flow-stream debug-text" data-style-kind="${kind}" data-flow-kind="text" data-original-lines="${lines}" ${extra} style="font-size:16px;line-height:1.825;height:11.5px;width:321.5px"><div class="flow-para" style="white-space:nowrap;width:max-content">出版授权声明</div></div>`;
  const { document } = parseHTML(`<html><body><div id="translation-layout"><div class="layout-page">
    ${stream('license', 'data-abstract-body="1"')}
    ${stream('ordinary')}
    ${stream('body', '', 'body_text')}
    ${stream('abstract', 'data-abstract-body="1"', 'abstract')}
    ${stream('multiline', 'data-abstract-body="1"', 'text', 'multi')}
    ${stream('inherited', 'data-body-style-inherited="1"')}
    <div id="title" class="layout-block type-title" style="font-size:16px">标题</div>
    </div></div><div id="source-layout"><div class="layout-page">${stream('original')}</div></div></body></html>`);
  const protectedIDs = ['body', 'abstract', 'multiline', 'inherited', 'title', 'original'];
  const originals = protectedIDs.map(id => document.getElementById(id).outerHTML);
  const fit = vm.runInNewContext(`${helper}\nfitSingleLineTextInk`, {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    getComputedStyle: node => ({ fontSize: node.style.fontSize }),
    singleLineTextInkBand(node) {
      const top = 3 + parseFloat(node.firstElementChild.style.top || '0');
      return { top, bottom: top + parseFloat(node.style.fontSize), height: 11.5 };
    }
  });
  const pages = [...document.querySelectorAll('.layout-page')];
  fit(pages);
  for (const id of ['license', 'ordinary']) {
    const node = document.getElementById(id);
    assert(parseFloat(node.style.fontSize) <= 11.5, `${id} must fit its glyph height despite an abstract-region marker`);
    assert.equal(node.style.lineHeight, '1');
    assert.equal(parseFloat(node.firstElementChild.style.top), -3);
    assert.equal(node.firstElementChild.style.whiteSpace, 'nowrap');
    assert.equal(node.firstElementChild.style.width, 'max-content');
  }
  assert.equal(document.getElementById('license').dataset.abstractBody, '1', 'fitting must not rewrite existing classification');
  protectedIDs.forEach((id, index) => assert.equal(document.getElementById(id).outerHTML, originals[index], `${id} must retain its own fitting rules`));
  const fitted = document.getElementById('license').outerHTML;
  fit(pages);
  assert.equal(document.getElementById('license').outerHTML, fitted, 'snapshot replay must not accumulate vertical shifts');
}

async function testManualBodyFontRemainsUnconstrained() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const manual = source.slice(source.indexOf('  function applyLayoutBodyFont('), source.indexOf('  function applyLayoutFitSnapshot('));
  const finalize = source.slice(source.indexOf('  function finalizeLayoutTypography('), source.indexOf('  // A layout solve'));
  const solve = source.slice(source.indexOf('  async function runLayoutFit('), source.indexOf('  // The initial paint and ResizeObserver'));
  const body = { dataset: {}, style: { fontSize: '8px', lineHeight: '1.4' } };
  const sourceBody = { dataset: {}, style: { fontSize: '8px', lineHeight: '1.4' } };
  const rootNode = { classList: { add() {}, remove() {} }, querySelectorAll: () => [layoutPage] };
  const layoutPage = { isConnected: true, clientWidth: 600, clientHeight: 800, dataset: {}, style: {},
    closest: selector => selector === '.layout-document' ? rootNode : null,
    getBoundingClientRect: () => ({ width: 600, height: 800 }), querySelectorAll: () => [body] };
  const state = { layoutFontPt: 18 };
  let automaticFits = 0;
  let released = 0;
  const api = vm.runInNewContext(`${manual}\n${finalize}\n${solve}\n({runLayoutFit, applyLayoutBodyFont})`, {
    state, document: {}, fitLayoutTables() {}, demoteFalseSingleLineText() {}, publishCompactLayoutDebugLabels() {},
    layoutFitPageKey: () => 'current', restoreLayoutFitSnapshot: async () => new Set(),
    fitLayoutPages: () => { automaticFits++; body.style.fontSize = '8px'; body.style.lineHeight = '1.4'; },
    inheritFinalDualColumnBodyFont: () => assert.equal(body.style.fontSize, '8px', 'style inheritance must finish before the manual override'),
    inheritFinalTextRegionBodyFont() {}, fitLayoutFormulas() {}, fitSingleLineTextInk() {}, clampTranslatedCodeOverflow: () => false,
    releaseBodyLeading: () => { released++; assert.equal(body.style.fontSize, '8px'); },
    saveLayoutFitSnapshot: () => { layoutPage.dataset.layoutFitKey = 'current'; }
  });
  await api.runLayoutFit([layoutPage]);
  assert.equal(body.style.fontSize, '24.00px', 'manual enlargement must not be reduced by collision checks');
  assert.equal(body.style.lineHeight, '1.4', 'manual enlargement must not compress the automatic leading');
  await api.runLayoutFit([layoutPage]);
  assert.equal(automaticFits, 1, 'restored manual layout must skip automatic refitting');
  assert.equal(released, 1, 'restoring a completed snapshot must not repeat leading release');
  assert.equal(body.style.fontSize, '24.00px');
  delete layoutPage.dataset.layoutFitKey;
  await api.runLayoutFit([layoutPage]);
  assert.equal(body.style.fontSize, '24.00px', 'resize-driven refitting must reapply the user choice afterward');
  api.applyLayoutBodyFont([{ closest: () => ({}), querySelectorAll: () => [sourceBody] }]);
  assert.equal(sourceBody.style.fontSize, '8px', 'manual translated font must not change parsed source text');
  state.layoutFontPt = 0;
  delete layoutPage.dataset.layoutFitKey;
  await api.runLayoutFit([layoutPage]);
  assert.equal(body.style.fontSize, '8px', 'clearing the manual choice must restore automatic fitting');
  const engine = source.slice(source.indexOf('  function runLayoutParityEngine('), source.indexOf('  // Route the inspection hook'));
  assert(!engine.includes('applyLayoutBodyFont('), 'the automatic collision engine must never consume manual overrides');
  const fit = source.slice(source.indexOf('  function fitLayoutPages('), source.indexOf('  // A layout solve'));
  let expanded = false, finalAudit = false;
  const wrap = {};
  const page = { closest: () => wrap };
  vm.runInNewContext(`${fit}\nfitLayoutPages(testPages)`, {
    testPages: [page], runLayoutParityEngine() {},
    resetBodyLeadingRelease() {},
    fitLayoutFormulas: (_pages, options) => { expanded = Boolean(options?.expand); },
    enforceFinalTextCollisionSafety: checkedPages => {
      assert(expanded, 'the last text collision audit must observe fully expanded formula geometry');
      assert.equal(checkedPages[0], page, 'the final audit must stay inside the requested document');
      finalAudit = true;
    }
  });
  assert(finalAudit);
}

function testPaddlePageFurnitureFrameCoordinates() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const policy = source.slice(source.indexOf('  function isPaddlePageFurniture('), source.indexOf('  function isOrdinaryMultilineText('));
  const collision = source.slice(source.indexOf('  function textCollisionDetails('), source.indexOf('  function applyGroup('));
  const rect = { left: 12, top: 9.8, right: 50, bottom: 18 };
  const api = vm.runInNewContext(`${policy}\n${collision}\n({ pageFurnitureMinLineRatio, textCollisionDetails })`, {
    elementBoxInPage: () => ({ left: 10, top: 10, right: 100, bottom: 20 }),
    viewportRectInPage: () => ({ left: 10, top: 9.75, right: 100, bottom: 20 }),
    layoutPageSourceSize: () => ({ width: 100, height: 100 }),
    textRectsInPage: () => [rect], blockDebugName: () => 'test'
  });
  for (const provider of ['paddle', 'mineru', '']) {
    for (const type of ['header', 'page_header', 'footer', 'page_footer', 'page_number', 'page_footnote', 'text']) {
      const node = { dataset: { parseProvider: provider }, closest: () => ({ querySelectorAll: () => [] }), getBoundingClientRect: () => ({}),
        matches: selector => selector.split(', ').includes(`.type-${type}`) };
      const adapted = provider === 'paddle' && type !== 'text';
      assert.equal(api.pageFurnitureMinLineRatio(node), adapted ? 1.4 : 2);
      const hit = api.textCollisionDetails([node], { boundNodeBox: true });
      assert.equal(hit?.blockerName || null, adapted ? null : 'block-boundary',
        `${provider}/${type}: decimal frame alignment must remain limited to Paddle page furniture`);
      if (adapted) {
        rect.top = 8.5;
        assert.equal(api.textCollisionDetails([node], { boundNodeBox: true }), null,
          'Gecko small-font and KaTeX top metrics must not stop growth at the minimum font');
        rect.top = 8.2;
        assert.equal(api.textCollisionDetails([node], { boundNodeBox: true })?.blockerName, 'block-boundary',
          'real overflow must still stop font growth');
        rect.top = 9.8;
        rect.bottom = 20.2;
        assert.equal(api.textCollisionDetails([node], { boundNodeBox: true })?.blockerName, 'block-boundary',
          'top metric tolerance must not relax the bottom boundary');
        rect.bottom = 18;
      }
    }
  }
}

function testProseStartingLeadingBoundaries() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const each = source.slice(source.indexOf('  function tuneEach('), source.indexOf('  function stoppedAtNextLowerBlock('));
  const solve = source.slice(source.indexOf('  function tuneNodes('), source.indexOf('  function continueUnderfilledNodes('));
  const abstract = source.slice(source.indexOf('  function shouldAdjustAbstractFont('), source.indexOf('  function dualColumnBodyFontCandidates('));
  const makeNode = kind => ({
    kind, dataset: { baseFont: '8', lineRatio: '1.1', styleKind: ['body', 'promoted'].includes(kind) ? 'body_text' : 'text',
      ...(kind === 'list' ? { fromList: '1' } : {}),
      ...(kind === 'abstract' ? { abstractBody: '1' } : {}),
      ...(kind === 'inherited' ? { bodyStyleInherited: '1' } : {}) },
    style: {},
    matches: selector => selector.startsWith('.layout-title') ? ['title', 'caption'].includes(kind) : true
  });
  const nodes = ['ordinary', 'abstract', 'body', 'promoted', 'list', 'inherited', 'title', 'caption'].map(makeNode);
  const probes = new Map();
  const results = new Map();
  const api = vm.runInNewContext(`${abstract}\n${each}\n${solve}\n({tuneEach, proseFitMinLineRatio})`, {
    window: { __gallopDisabled: true }, scopedNodes: () => nodes, clearFitMarks() {},
    applyGroup(group, font, leading) {
      for (const node of group) {
        if (!probes.has(node)) probes.set(node, []);
        probes.get(node).push({ font, leading });
        Object.assign(node.style, { fontSize: String(font), lineHeight: String(leading) });
      }
    },
    beginBodyIterationProbe() {}, recordBodyIterationCollision() {},
    textCollisionDetails: ([node]) => Number(node.style.fontSize) * Number(node.style.lineHeight) * 6 > 100 ? { source: node } : null
  });
  const options = { minFont: 4.8, maxFont: 13, step: .35, lineStep: .035, maxLineRatio: 1.85,
    startFromMinimum: true, allowOverflow: true, avoidBlockOverlap: true, stopWhenFilled: false,
    minLineRatio: api.proseFitMinLineRatio, onFitted: (node, result) => results.set(node.kind, result) };
  api.tuneEach('existing-selector', options);
  for (const node of nodes) {
    const expected = ['ordinary', 'abstract'].includes(node.kind) ? 1.3 : 1.1;
    assert.equal(probes.get(node)[0].leading, expected, `${node.kind} must start with its own leading policy`);
    assert(probes.get(node).every(probe => probe.leading >= expected - 1e-6));
  }
  assert(results.get('ordinary').fontSize < results.get('body').fontSize,
    'reserving leading may reduce only the independent text font, not the protected body baseline');
  assert.equal(results.get('ordinary').lineRatio, 1.3);
  assert.equal(nodes.find(node => node.kind === 'abstract').dataset.styleKind, 'text');
  const markedList = makeNode('list'); markedList.dataset.abstractBody = '1';
  const markedInherited = makeNode('inherited'); markedInherited.dataset.abstractBody = '1';
  assert.equal(api.proseFitMinLineRatio(markedList), 1.1, 'list classification must remain protected even when an abstract marker is present');
  assert.equal(api.proseFitMinLineRatio(markedInherited), 1.1, 'inherited body style must retain its own baseline');
  const protectedStyles = new Map(nodes.filter(node => !['ordinary', 'abstract'].includes(node.kind))
    .map(node => [node.kind, { ...node.style }]));
  api.tuneEach('existing-selector', { ...options, minLineRatio: 1.1 });
  for (const node of nodes.filter(node => protectedStyles.has(node.kind))) {
    assert.deepEqual(node.style, protectedStyles.get(node.kind), `${node.kind} must retain the previous numeric-option behavior`);
  }
}

function testBoundedBodyLeadingRelease() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helpers = source.slice(source.indexOf('  function resetBodyLeadingRelease('), source.indexOf('  function fitLayoutPages('));
  const ratio = node => node.dataset.equationDense === '1' && node.style.priority !== 'important'
    ? 1.04 : Number(node.style.lineHeight);
  const makeNode = (capacity = 1.6, leading = 1.1, extra = {}) => ({
    dataset: { styleKind: 'body_text', flowKind: 'text' },
    style: { fontSize: '16px', lineHeight: String(leading), priority: '',
      setProperty(name, value, priority = '') { assert.equal(name, 'line-height'); this.lineHeight = value; this.priority = priority; },
      getPropertyPriority() { return this.priority; } },
    box: { left: 0, top: 0, right: 100, bottom: capacity * 100 }, ...extra
  });
  const ample = makeNode(), partial = makeNode(1.237), full = makeNode(1.1), overflow = makeNode(1.05);
  const wider = makeNode(1.6, 1.4), empty = makeNode(1.6, 1.1, { empty: true });
  const dense = makeNode(); dense.dataset.equationDense = '1';
  const denseOverflow = makeNode(1.03); denseOverflow.dataset.equationDense = '1';
  const neighbor = makeNode(1.6, 1.1, { collisionAt: 1.245 });
  const alreadyColliding = makeNode(1.6, 1.1, { collisionAt: 1 });
  const leftOverflow = makeNode(1.6, 1.1, { ink: { left: -1 } });
  const topOverflow = makeNode(1.6, 1.1, { ink: { top: -2 } });
  const opticalTop = makeNode(1.6, 1.1, { ink: { top: -1 } });
  const rightOverflow = makeNode(1.6, 1.1, { ink: { right: 101 } });
  const inlineMath = makeNode(1.3, 1.1, { math: true });
  const caption = makeNode(); caption.dataset.styleKind = 'caption';
  const inherited = makeNode(); inherited.dataset.styleKind = 'text'; inherited.dataset.bodyStyleInherited = '1';
  const abstract = makeNode(); abstract.dataset.styleKind = 'text'; abstract.dataset.abstractBody = '1';
  const abstractFull = makeNode(1.1); abstractFull.dataset.styleKind = 'text'; abstractFull.dataset.abstractBody = '1';
  const abstractNeighbor = makeNode(1.6, 1.1, { collisionAt: 1.245 });
  abstractNeighbor.dataset.styleKind = 'text'; abstractNeighbor.dataset.abstractBody = '1';
  const absoluteAbstract = makeNode(); absoluteAbstract.dataset.styleKind = 'abstract'; absoluteAbstract.dataset.blockKind = 'abstract';
  const all = [ample, partial, full, overflow, wider, empty, dense, denseOverflow, neighbor,
    alreadyColliding, leftOverflow, topOverflow, opticalTop, rightOverflow, inlineMath, caption, inherited,
    abstract, abstractFull, abstractNeighbor, absoluteAbstract];
  const page = {
    closest: () => null,
    querySelectorAll: selector => selector.startsWith('[data-body-leading-before-release]')
      ? all.filter(node => node.dataset.bodyLeadingBeforeRelease !== undefined)
      : all.filter(node => node.dataset.styleKind === 'body_text' || node.dataset.bodyStyleInherited === '1'
        || (node.dataset.abstractBody === '1' && selector.includes('[data-abstract-body="1"]'))
        || (node.dataset.blockKind === 'abstract' && selector.includes('.layout-block.type-abstract')))
  };
  const ink = node => [{ left: 0, top: 0, right: 100, bottom: ratio(node) * 100, ...node.ink }];
  const api = vm.runInNewContext(`${helpers}\n({releaseBodyLeading, resetBodyLeadingRelease})`, {
    getComputedStyle: node => ({ fontSize: node.style.fontSize, lineHeight: String(ratio(node) * 16) }),
    elementBoxInPage: node => node.box,
    textRectsInPage: node => node.empty ? [] : ink(node),
    renderedContentRectsInPage: node => node.math ? [...ink(node), { left: 10, top: 0, right: 20, bottom: ratio(node) * 100 + 10 }] : ink(node),
    textCollisionDetails: ([node]) => ratio(node) > (node.collisionAt ?? Infinity) ? { source: node } : null
  });
  api.releaseBodyLeading([page]);
  const first = all.map(node => [node.style.fontSize, node.style.lineHeight, node.style.priority]);
  assert.equal(Number(ample.style.lineHeight), 1.35, 'spacious blocks must stop at the common target');
  assert(Number(partial.style.lineHeight) > 1.23 && Number(partial.style.lineHeight) <= 1.237);
  assert(Number(neighbor.style.lineHeight) > 1.24 && Number(neighbor.style.lineHeight) <= 1.245);
  assert(Number(inlineMath.style.lineHeight) > 1.19 && Number(inlineMath.style.lineHeight) <= 1.2,
    'visible inline formula geometry must remain inside the frame too');
  assert.equal(Number(dense.style.lineHeight), 1.35, 'equation-dense body must be eligible without a line-count gate');
  assert.equal(dense.style.priority, 'important', 'a safe release must override the compact equation CSS');
  assert.equal(Number(inherited.style.lineHeight), 1.35);
  assert.equal(Number(abstract.style.lineHeight), 1.35, 'independently identified abstract streams must share the body leading target');
  assert.equal(Number(absoluteAbstract.style.lineHeight), 1.35, 'absolute abstract blocks must also receive safe leading release');
  assert.equal(abstract.dataset.styleKind, 'text', 'abstract release must preserve classification and stay outside the shared body font group');
  assert.equal(abstract.dataset.bodyStyleInherited, undefined);
  assert(Number(abstractNeighbor.style.lineHeight) > 1.24 && Number(abstractNeighbor.style.lineHeight) <= 1.245,
    'abstract leading must still stop at neighboring content');
  assert.equal(Number(opticalTop.style.lineHeight), 1.35, 'ordinary top-edge font metrics must use the existing 1.5 source-pixel tolerance');
  assert.equal(wider.style.lineHeight, '1.4', 'already spacious leading must not decrease');
  for (const node of [full, overflow, empty, denseOverflow, alreadyColliding, leftOverflow, topOverflow, rightOverflow, caption, abstractFull]) {
    assert.equal(node.style.lineHeight, '1.1', 'ineligible or constrained blocks must preserve their exact original style');
    assert.equal(node.dataset.bodyLeadingBeforeRelease, undefined);
  }
  assert(all.every(node => node.style.fontSize === '16px'), 'leading release must never change font size');
  api.resetBodyLeadingRelease([page]);
  assert.equal(dense.style.priority, '');
  assert.equal(ratio(dense), 1.04, 'refitting must restore compact equation behavior before automatic font solving');
  assert(all.every(node => node.dataset.bodyLeadingBeforeRelease === undefined));
  api.releaseBodyLeading([page]);
  assert.deepEqual(all.map(node => [node.style.fontSize, node.style.lineHeight, node.style.priority]), first,
    'a repeated full solve must start from the same leading instead of accumulating release');
  const protectedSource = makeNode();
  api.releaseBodyLeading([{ closest: () => ({}), querySelectorAll: () => [protectedSource] }]);
  assert.equal(protectedSource.style.lineHeight, '1.1');

  const finalize = source.slice(source.indexOf('  function finalizeLayoutTypography('), source.indexOf('  // A layout solve'));
  const order = [];
  vm.runInNewContext(`${finalize}\nfinalizeLayoutTypography([])`, {
    inheritFinalDualColumnBodyFont: () => order.push('columns'),
    inheritFinalTextRegionBodyFont: () => order.push('regions'),
    releaseBodyLeading: () => order.push('leading'), applyLayoutBodyFont: () => order.push('manual')
  });
  assert.deepEqual(order, ['columns', 'regions', 'leading', 'manual']);
}

function testBodyLeadingCollisionRollback() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function continueUnderfilledNodes('), source.indexOf('  function clampTranslatedOverflow('));
  let nodes = [], safeRatio = 1.08;
  const probes = [];
  const applyGroup = (group, font, ratio) => {
    for (const node of group) Object.assign(node.style, { fontSize: String(font), lineHeight: String(ratio) });
  };
  const continueFit = vm.runInNewContext(`${helper}\ncontinueUnderfilledNodes`, {
    document: { body: { classList: { contains: () => false } } },
    measureTextBand: () => ({ hasText: true, lastBottom: 50 }),
    layoutControlFontSize: node => Number(node.style.fontSize), applyGroup,
    beginBodyIterationProbe() {}, recordBodyIterationCollision() {},
    textCollisionDetails: group => {
      const hit = group.find(node => Number(node.style.fontSize) >= 11 && Number(node.style.lineHeight) > safeRatio + 1e-6);
      if (hit) probes.push(Number(hit.style.lineHeight));
      return hit ? { source: hit } : null;
    }
  });
  const reset = (dense = false) => {
    nodes = [
      { dataset: { equationDense: dense ? '1' : '0' }, style: {}, clientHeight: 100 },
      { dataset: {}, style: {}, clientHeight: 100 }
    ];
    applyGroup(nodes, 10, 1.22);
    probes.length = 0;
  };
  const options = { step: .5, lineStep: .04, maxFont: 11, collisionMinLineRatio: 1.1, avoidBlockOverlap: true };
  reset();
  continueFit(nodes, options);
  assert(nodes.every(node => Number(node.style.fontSize) === 10.5), 'a collision below the readable floor must roll back the whole font-growth round');
  assert(nodes.every(node => Number(node.style.lineHeight) === 1.22), 'failed growth must also restore each paragraph leading');
  assert(probes.every(ratio => ratio >= 1.1));

  safeRatio = 1.1;
  reset();
  continueFit(nodes, options);
  assert(nodes.every(node => Number(node.style.fontSize) === 11), 'readable collision recovery must retain a uniform body font');
  assert(nodes.every(node => Number(node.style.lineHeight) >= 1.1));

  safeRatio = 1.3;
  reset();
  applyGroup(nodes, 10, 1.4);
  continueFit(nodes, options);
  assert(nodes.every(node => Number(node.style.fontSize) === 11), 'body growth may trade some leading for readable uniform text size');
  assert(nodes.every(node => Number(node.style.lineHeight) >= 1.1 && Number(node.style.lineHeight) <= 1.3));

  safeRatio = 1.04;
  reset(true);
  nodes.pop();
  continueFit(nodes, options);
  assert.equal(Number(nodes[0].style.fontSize), 11, 'short text between equations must retain the existing compact exception');
  assert(Math.abs(Number(nodes[0].style.lineHeight) - 1.02) < 1e-6);
}

function testFinalBodyFontInheritanceCollisionRollback() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function applyFinalBodyStyle('), source.indexOf('  function titleFrameFill('));
  let fonts = [11.5, 11.5], collision = false, incoming = false, ordinary = true, strict = false;
  let safeLineRatio = null, incomingSafeLineRatio = null;
  const probedRatios = [];
  const peer = {};
  const pane = { querySelectorAll: () => fonts.map(font => ({
    style: { lineHeight: '1.2' }, dataset: {}, closest: () => page, classList: { contains: () => false },
    box: { top: 10, bottom: 100 }, ...(typeof font === 'number' ? { font } : font)
  })) };
  const page = { querySelectorAll: () => [node, peer] };
  const node = { dataset: { layoutFontScale: '2' }, style: { fontSize: '25.00px', lineHeight: '1.19', textAlign: 'left' }, box: { top: 10, bottom: 100 },
    closest: selector => selector === '.layout-page' ? page : pane };
  const inherit = vm.runInNewContext(`${helper}\ninheritFinalDualColumnBodyFont`, {
    document: { body: { classList: { contains: () => strict } } },
    scopedNodes: () => [node], isOrdinaryMultilineText: () => ordinary,
    layoutControlFontSize: body => body.font, elementBoxInPage: n => n.box,
    blockDebugName: () => 'peer',
    window: { getComputedStyle: () => ({ textAlign: 'justify' }) },
    textCollisionDetails: (_nodes, options) => {
      assert.equal(options.checkAllTextForCollisions, true);
      assert.equal(options.avoidPageOverflow, true);
      const ratio = Number(node.style.lineHeight);
      probedRatios.push(ratio);
      return collision || (safeLineRatio !== null && ratio > safeLineRatio) ? { blocker: peer } : null;
    },
    textRectsInPage: () => [{}], renderedContentRectsInPage: () => [{}],
    rectsOverlap: () => incoming || (incomingSafeLineRatio !== null && Number(node.style.lineHeight) > incomingSafeLineRatio)
  });
  inherit();
  assert.equal(node.style.fontSize, '23.00px');
  assert.equal(node.style.lineHeight, '1.2');
  assert.equal(node.style.textAlign, 'justify');
  fonts = [{ style: { fontSize: '9pt', lineHeight: '1.2' }, dataset: { layoutFontScale: '1' } }];
  inherit();
  assert.equal(node.style.fontSize, '24.00px', 'inherit the final manual body size after converting pt to source px');
  for (const direction of ['outgoing', 'incoming']) {
    safeLineRatio = direction === 'outgoing' ? 1.15 : null;
    incomingSafeLineRatio = direction === 'incoming' ? 1.15 : null;
    probedRatios.length = 0;
    inherit();
    assert.equal(node.style.fontSize, '24.00px', 'compression must retain the inherited body size');
    assert.equal(node.style.lineHeight, '1.15', 'stop at the first collision-free line ratio');
    assert.equal(node.style.textAlign, 'justify');
    assert.deepEqual(probedRatios, [1.2, 1.175, 1.15]);
  }
  safeLineRatio = 1.1; incomingSafeLineRatio = null;
  inherit();
  assert.equal(node.style.lineHeight, '1.1', 'try the readable body floor before abandoning inheritance');
  safeLineRatio = 1.075;
  Object.assign(node.style, { fontSize: '25.00px', lineHeight: '1.19', textAlign: 'left' });
  probedRatios.length = 0;
  inherit();
  assert.equal(node.style.fontSize, '25.00px', 'abandon inheritance if fitting requires excessive line compression');
  assert.equal(node.style.lineHeight, '1.19');
  assert(probedRatios.every(ratio => ratio >= 1.1));
  safeLineRatio = null;
  for (const reason of ['outgoing', 'incoming', 'missing-baseline', 'mixed-baseline', 'protected', 'abstract', 'strict-source']) {
    Object.assign(node.style, { fontSize: '25.00px', lineHeight: '1.19', textAlign: 'left' });
    collision = reason === 'outgoing'; incoming = reason === 'incoming'; strict = reason === 'strict-source';
    fonts = reason === 'missing-baseline' ? [] : reason === 'mixed-baseline' ? [11.5, 12] : [11.5, 11.5];
    ordinary = reason !== 'protected'; node.dataset.abstractBody = reason === 'abstract' ? '1' : '0';
    inherit();
    assert.equal(node.style.fontSize, '25.00px', reason);
    assert.equal(node.style.lineHeight, '1.19');
    assert.equal(node.style.textAlign, 'left', 'collision rollback must restore all inherited styles');
    assert(probedRatios.every(ratio => ratio >= 1.1), 'compression must not exceed the readable body floor');
  }
  const solve = source.slice(source.indexOf('  async function runLayoutFit('), source.indexOf('  function ensureLayoutFit('));
  assert(solve.indexOf('      finalizeLayoutTypography(pending);') > solve.indexOf('      fitLayoutPages(pending);'));
  assert(solve.indexOf('      finalizeLayoutTypography(pending);') < solve.lastIndexOf('      saveLayoutFitSnapshot(active);'));
}

function testInheritedBodyAlignmentSnapshot() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function applyLayoutFitSnapshot('), source.indexOf('  function restoreInjectedLayoutFitSnapshot('));
  const version = Number(source.match(/const LAYOUT_FIT_SNAPSHOT_VERSION = (\d+);/)[1]);
  const node = { dataset: {}, style: { fontSize: '10px', lineHeight: '1.1', textAlign: '' } };
  const page = { dataset: {}, querySelectorAll: () => [node] };
  const restore = vm.runInNewContext(`${helper}\napplyLayoutFitSnapshot`, { LAYOUT_FIT_SNAPSHOT_VERSION: version, layoutFitPageKey: () => 'key' });
  const snapshot = { version, pages: [{ key: 'key', styles: [{ fontSize: '12px', lineHeight: '1.2', textAlign: 'justify' }] }] };
  assert.equal(restore([page], { ...snapshot, version: 12 }).size, 0);
  assert.equal(node.style.textAlign, '');
  assert.equal(restore([page], snapshot).size, 1);
  assert.deepEqual(node.style, snapshot.pages[0].styles[0]);
  node.dataset.equationDense = '1';
  node.style.setProperty = function (_name, value, priority = '') { this.lineHeight = value; this.priority = priority; };
  snapshot.pages[0].styles[0] = { fontSize: '12px', lineHeight: '1.35', textAlign: 'justify', bodyLeadingBeforeRelease: '1.02' };
  assert.equal(restore([page], snapshot).size, 1);
  assert.equal(node.style.priority, 'important', 'restored equation text must retain its measured leading instead of falling back to compact CSS');
  assert.equal(node.dataset.bodyLeadingBeforeRelease, '1.02', 'restored layouts must remember the automatic leading for a future refit');
  const resetHelper = source.slice(source.indexOf('  function resetBodyLeadingRelease('), source.indexOf('  function releaseBodyLeading('));
  vm.runInNewContext(`${resetHelper}\nresetBodyLeadingRelease(testPages)`, { testPages: [page] });
  assert.equal(node.style.lineHeight, '1.02');
  assert.equal(node.style.priority, '');
  assert.equal(node.dataset.bodyLeadingBeforeRelease, undefined);
}

function testKeywordLineBreaks() {
  const text = 'Keywords: Aluminum particle\nShock speed\nEquivalence ratio\nPulsating shock\nHomogeneous reaction\nHeterogeneous reaction';
  const block = { type: 'text', lines: [{ spans: [{ type: 'text', content: text }] }] };
  assert.equal(LayoutHelpers.plainBlockText(block), text, '单个 span 内的关键词换行必须保留到翻译输入');
  assert.equal(LayoutHelpers.plainBlockText({ lines: [{ spans: [{ type: 'text', content: 'First<br />Second<br>Third' }] }] }), 'First\nSecond\nThird');
  assert(LayoutHelpers.isKeywordListText(text));
  assert(LayoutHelpers.isKeywordListText('Key words:\r\nWind\r\nLidar'));
  assert(LayoutHelpers.isKeywordListText('关键词：\n风速\n雷达'));
  assert(!LayoutHelpers.isKeywordListText('Keywords: Wind; lidar'));
  assert(!LayoutHelpers.isKeywordListText('Normal prose wraps\nonto another source line.'));
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function renderLayoutTranslatedText('), source.indexOf('  function renderLayoutTocRows('));
  const render = vm.runInNewContext(`${helper}\nrenderLayoutTranslatedText`, { Markdown: M, imageResolver: () => '' });
  const translated = '关键词：铝颗粒\n激波速度\n当量比\n脉动激波\n均相反应\n非均相反应';
  assert.equal((render(translated, true).match(/<br \/>/g) || []).length, 5);
  assert(!render('正文的物理折行\n仍由栏宽决定').includes('<br'), '正文不按源 PDF 的物理行强制换行');
  assert.equal(render('关键词：铝颗粒激波速度当量比', true), '关键词：铝颗粒激波速度当量比', '旧译文没有边界时不猜测切分');
  assert(render('<script>alert(1)</script>\n激波', true).includes('&lt;script&gt;'), '保留换行仍须转义不可信 HTML');
}

function testLayoutDOIWrapBoundaries() {
  const source = fs.readFileSync(path.join(root, 'src/workbench.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function restoreLayoutDOIWraps('), source.indexOf('  function layoutPartHTML('));
  const restore = vm.runInNewContext(`${helper}\nrestoreLayoutDOIWraps`, { U });
  for (const text of ['doi:10.1234/abc\nPublished online', 'https://doi.org/10.1234/abc\nPublished online\n2026']) {
    assert.equal(restore(text, text), text, 'ordinary prose following a DOI must remain separate');
    assert.equal(restore(text.replace(/\n/g, ' '), text), text.replace(/\n/g, ' '));
  }
  for (const [text, expected] of [
    ['https://doi.org/10.\n1016/j.neuron.2010.12.006 PMID: 21220100', 'https://doi.org/10.1016/j.neuron.2010.12.006 PMID: 21220100'],
    ['https://doi.org/10.1073/pnas.\n1101553108', 'https://doi.org/10.1073/pnas.1101553108'],
    ['https://doi.org/10.1158/1078-0432.CCR-07-\n4717', 'https://doi.org/10.1158/1078-0432.CCR-07-4717'],
    ['https://doi.org/10.1234/\nabc\nPublished online', 'https://doi.org/10.1234/abc\nPublished online']
  ]) {
    assert.equal(restore(text, text), expected);
    assert.equal(restore(U.escapeHTML(text.replace(/\n/g, ' ')), text, true), U.escapeHTML(expected.replace(/\n/g, ' ')));
  }
}

async function testLayoutPDFAttachmentReplacementKeepsLatest() {
  const method = context.LitMTrans.Controller.prototype.generateLayoutPDFAttachments.toString();
  const calls = [];
  let oldIDs = [1, 2, 3, 4, 5], failImport = false, failTrash = false, failRegistry = false;
  const titles = { 1: '用户改名后的译文', 2: '用户改名后的对照', 3: '原始PDF', 4: '简体中文-译文-paper', 5: '简体中文-译文-paper' };
  const itemOverrides = {};
  const originalRegistry = [
    { parseRevisionID: 'current', targetLanguage: '简体中文', translationKey: 'key-1', comparisonKey: 'key-2' },
    { parseRevisionID: 'old-paddle', targetLanguage: '简体中文', translationKey: 'key-5' }
  ];
  let registry = originalRegistry;
  const create = vm.runInNewContext(`({ ${method} }).generateLayoutPDFAttachments`, {
    U: { extension: () => '.pdf', safeStem: value => value, normalizeLanguageName: value => value },
    PathUtils: { join: (...parts) => parts.join('/') },
    LitMTrans: context.LitMTrans,
    Zotero: {
      getMainWindow: () => ({}),
      Items: {
        get: id => ({ id, libraryID: 1, parentID: 10, isAttachment: () => true,
          attachmentContentType: 'application/pdf', getField: () => titles[id], ...itemOverrides[id] }),
        getByLibraryAndKey: (_libraryID, key) => {
          const id = Number(key.replace('key-', ''));
          return oldIDs.includes(id) ? { id, key } : null;
        },
        trashTx: async ids => { if (failTrash) throw new Error('trash failed'); calls.push(`trash:${ids.join(',')}`); },
        erase: async ids => calls.push(`erase:${ids.join(',')}`)
      }
    },
    Services: { prompt: { confirmEx: () => assert.fail('latest PDF replacement needs no confirmation') } }
  });
  const controller = {
    generatedPDFHasUserContent: context.LitMTrans.Controller.prototype.generatedPDFHasUserContent,
    attachmentContext: async () => ({ filePath: 'paper.pdf', title: 'paper', documentID: 'doc', attachment: { id: 3, libraryID: 1 }, parent: { id: 10, isRegularItem: () => true, getAttachments: () => oldIDs } }),
    getSettings: () => ({ targetLanguage: '简体中文' }),
    storage: { temporaryDir: () => 'temp', path: (...parts) => parts.join('/'),
      getDocumentMeta: async () => ({ parseRevisionID: 'current', parseProvider: 'mineru', parseModel: 'vlm' }),
      readJSON: async () => registry,
      writeJSON: async (_path, value) => { if (failRegistry) throw new Error('registry failed'); registry = value; },
      ensureDir: async () => {}, remove: async () => calls.push('cleanup'), setDocumentMeta: async () => calls.push('meta') },
    printWorkbenchPDF: async () => calls.push('print'),
    createLayoutComparisonPDF: async () => calls.push('comparison'),
    createGeneratedPDFAttachment: async (_context, _file, title) => {
      calls.push(`import:${title}`);
      if (failImport && title.includes('对照版')) throw new Error('import failed');
      const id = title.includes('对照版') ? 12 : 11;
      return { id, key: `key-${id}` };
    }
  };
  const run = () => create.call(controller, {}, { layoutIdentity: 'new' });
  const replaced = await run();
  assert.equal(replaced.translationAttachmentID, 11);
  assert.deepEqual(calls.slice(-3), ['trash:4,5,1,2', 'meta', 'cleanup']);
  assert(calls.includes('import:简体中文-译文-paper'));
  assert(calls.indexOf('import:简体中文-译文对照版-paper') < calls.indexOf('trash:4,5,1,2'), 'save both replacements before moving any old attachment');
  assert(!calls.includes('trash:3'), 'never touch the original PDF');
  assert.equal(registry.length, 1, 'same-language PDFs from all parser revisions are replaced');
  assert.equal(registry[0].translationKey, 'key-11');
  registry = originalRegistry;
  calls.length = 0; failImport = true;
  await assert.rejects(run, /import failed/);
  assert(!calls.some(call => call.startsWith('trash:') || call === 'meta'), 'a failed replacement must preserve both old attachments');
  assert(calls.includes('erase:11'), 'erase the first newly imported attachment and its storage files when the second fails');
  assert.equal(calls.at(-1), 'cleanup');
  calls.length = 0; failImport = false; failTrash = true;
  await assert.rejects(run, /trash failed/);
  assert(calls.includes('erase:11,12'), 'erase only the new pair if moving the old pair fails');
  assert(!calls.includes('meta'));
  assert.deepEqual(registry, originalRegistry);
  calls.length = 0; failTrash = false; failRegistry = true;
  await assert.rejects(run, /registry failed/);
  assert(calls.includes('erase:11,12'));
  assert(!calls.some(call => call.startsWith('trash:')), 'failed ownership publication must leave old PDFs untouched');
  failRegistry = false;
  failTrash = false;
  calls.length = 0; failImport = false; oldIDs = [3, 4, 6, 7, 8, 9, 10];
  for (const id of [3, 7, 8, 9, 10]) titles[id] = titles[4];
  titles[6] = `${titles[4]}（备份）`;
  itemOverrides[7] = { attachmentContentType: 'text/plain' };
  itemOverrides[8] = { parentID: 20 };
  itemOverrides[9] = { libraryID: 2 };
  itemOverrides[10] = { deleted: true };
  await run();
  assert(!calls.includes('confirm'), 'first generation needs no replacement prompt');
  assert(calls.includes('trash:4'), 'replace exact-title legacy PDFs even without an ownership record');
  assert.deepEqual(calls.filter(call => call.startsWith('trash:')), ['trash:4'], 'preserve source, similar titles, non-PDFs, other parents/libraries and trashed items');
  calls.length = 0; oldIDs = [3];
  await run();
  assert(!calls.some(call => call.startsWith('trash:')), 'generation without any old PDF must not remove anything');
  calls.length = 0;
  oldIDs = [1, 2, 3, 4, 5];
  titles[4] = '简体中文-译文对照版-paper';
  registry = [{ parseRevisionID: 'current', targetLanguage: '简体中文', layoutIdentity: 'new', translationKey: 'key-1', comparisonKey: 'key-2' }];
  const cached = await run();
  assert(cached.cached);
  assert.deepEqual(calls, ['trash:4,5', 'meta'], 'cached publication removes same-title legacy duplicates without printing or removing the current pair');
  calls.length = 0;
  await assert.rejects(create.call(controller, {}, { layoutIdentity: 'old', parseRevisionID: 'old-paddle' }), /解析结果已变化/);
  assert.equal(calls.length, 0);
  registry = originalRegistry;
  calls.length = 0;
  itemOverrides[4] = { getAnnotations: () => [{ id: 90 }] };
  itemOverrides[5] = { getNotes: () => [91] };
  await run();
  assert.deepEqual(calls.filter(call => call.startsWith('trash:')), ['trash:1,2'], 'annotated PDFs and attached notes must survive a table display update');
}

async function testDocumentCleanupRemovesGeneratedPDFsAndFontOnly() {
  const prototype = context.LitMTrans.Controller.prototype;
  let registry = [{ translationKey: 'ZH', comparisonKey: 'COMPARE' }, { translationKey: 'EN', comparisonKey: 'ZH' }];
  const items = new Map(['SOURCE', 'ZH', 'COMPARE', 'EN', 'UNRELATED'].map((key, index) => [key, {
    id: index + 1, key, libraryID: 1, parentID: 10,
    attachmentContentType: 'application/pdf', isAttachment: () => true, getField: () => key
  }]));
  const removed = [];
  const parent = { id: 10, isRegularItem: () => true, getField: () => 'paper',
    getAttachments: () => [...items.values()].filter(item => item.parentID === 10).map(item => item.id) };
  const legacy = { id: 6, key: 'LEGACY', libraryID: 1, parentID: 10,
    attachmentContentType: 'application/pdf', isAttachment: () => true,
    getField: () => '简体中文-译文-paper' };
  let failTrash = false;
  const globals = {
    Zotero: { Items: {
      get: id => id === 10 ? parent : [...items.values()].find(item => item.id === id),
      getByLibraryAndKey: (_library, key) => items.get(key),
      trashTx: async ids => { if (failTrash) throw new Error('trash failed'); removed.push(...ids); }
    } },
    displayTitle: () => 'paper',
    U: { safeStem: U.safeStem, setPref: (key, value) => { assert.equal(key, 'layoutReaderFonts'); savedFonts = JSON.parse(value); } }
  };
  const remove = vm.runInNewContext(`({ ${prototype.removeGeneratedPDFAttachments} }).removeGeneratedPDFAttachments`, globals);
  const clear = vm.runInNewContext(`({ ${prototype.clearStorageData} }).clearStorageData`, globals);
  let savedFonts = null, deletedCache = false, inCleanup = false;
  const controller = {
    operations: new Map(), tabs: new Map(),
    removeCAJReaderAttachment: async () => ({ removed: false }),
    getLayoutReaderFonts: () => ({ '1-SOURCE': 9, '1-OTHER': 12 }),
    storage: {
      path: (...parts) => parts.join('/'), readJSON: async () => registry,
      parseDocumentID: () => ({ libraryID: 1, key: 'SOURCE' }),
      clearDocumentSubcategory: async (_id, category, beforeRemove) => {
        inCleanup = true;
        try { if (beforeRemove) await beforeRemove(); deletedCache = true; return { cleared: true }; }
        finally { inCleanup = false; }
      }
    },
    removeGeneratedPDFAttachments: function (id) { assert(inCleanup); return remove.call(this, id); }
  };
  await clear.call(controller, { target: 'document', documentID: '1-SOURCE', category: 'all' });
  assert.deepEqual(removed, [2, 3, 4], 'remove all registered languages once, preserving source and unregistered PDFs');
  assert.deepEqual(savedFonts, { '1-OTHER': 12 }, 'reset only this document font');
  assert(deletedCache);
  removed.length = 0;
  registry = [];
  items.set('LEGACY', legacy);
  items.set('LEGACY_COMPARE', { ...legacy, id: 7, key: 'LEGACY_COMPARE', getField: () => 'English-译文对照版-paper' });
  items.set('SIMILAR', { ...legacy, id: 8, key: 'SIMILAR', getField: () => '简体中文-译文-paper（备份）' });
  items.set('NON_PDF', { ...legacy, id: 9, key: 'NON_PDF', attachmentContentType: 'text/plain' });
  items.get('SOURCE').getField = () => '简体中文-译文-paper';
  await clear.call(controller, { target: 'document', documentID: '1-SOURCE', category: 'all' });
  assert.deepEqual(removed, [6, 7], 'without a registry, remove only exact generated titles in all languages and preserve source, similar names and non-PDFs');
  registry = [{ translationKey: 'LEGACY', comparisonKey: 'LEGACY_COMPARE' }];
  removed.length = 0;
  await clear.call(controller, { target: 'document', documentID: '1-SOURCE', category: 'all' });
  assert.deepEqual(removed, [6, 7], 'registered and title-matched attachments must be removed only once');
  removed.length = 0; savedFonts = null; deletedCache = false; failTrash = true;
  await assert.rejects(clear.call(controller, { target: 'document', documentID: '1-SOURCE', category: 'all' }), /trash failed/);
  assert(!deletedCache && !savedFonts, 'retain ownership records and font when attachment cleanup fails');
  failTrash = false;
  for (const key of ['SOURCE', 'UNRELATED']) {
    if (key === 'UNRELATED') items.get(key).parentID = 20;
    registry = [{ translationKey: key }];
    await assert.rejects(clear.call(controller, { target: 'document', documentID: '1-SOURCE', category: 'all' }), /关联信息异常/);
    assert.equal(removed.length, 0, 'never remove original or attachments belonging to another item');
  }
  await clear.call(controller, { target: 'document', documentID: '1-SOURCE', category: 'translation' });
  assert.equal(savedFonts, null, 'partial cleanup must keep font and PDF attachments');
  let callbacks = 0;
  const missing = { documentDir: () => '/missing', exists: async () => false };
  const clearMissing = context.LitMTrans.Storage.prototype.clearDocumentSubcategory;
  await clearMissing.call(missing, '1-SOURCE', 'all', async () => callbacks++);
  assert.equal(callbacks, 1, 'clear residual attachments even when a previous cleanup already removed the document directory');
  await clearMissing.call(missing, '1-SOURCE', 'translation', async () => callbacks++);
  assert.equal(callbacks, 1, 'partial cleanup must not trigger attachment removal');
}

  return {
    testDocumentCleanupRemovesGeneratedPDFsAndFontOnly,
    testKeywordLineBreaks,
    testLayoutDOIWrapBoundaries,
    testLayoutPDFAttachmentReplacementKeepsLatest,
    testInheritedBodyAlignmentSnapshot,
    testDualColumnBodyFontCandidateProtection,
    testOffsetSingleColumnBodyProfile,
    testOffsetBodyUnifiedFitPromotion,
    testOffsetBodyToolbarFont,
    testPublishedTranslationClearsWorkbenchFontOverride,
    testLayoutFontMemoryFollowsRulesVersion,
    testSingleLineTextInkAbstractRegionBoundary,
    testManualBodyFontRemainsUnconstrained,
    testBoundedBodyLeadingRelease,
    testProseStartingLeadingBoundaries,
    testPaddlePageFurnitureFrameCoordinates,
    testBodyLeadingCollisionRollback,
    testFinalBodyFontInheritanceCollisionRollback,
    testFinalTextClearanceBoundaries,
    testAbstractRecognitionAndBodyProtection,
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
    testLayoutRetriesMissingBlocksAfterRepairOnce,
    testLayoutAcceptsNonemptyAnswersWithoutQualityRetries,
    testLayoutFullContextIgnoresChunkLimits,
    testLayoutTargetedRetryKeepsPrimaryPrefix,
    testLayoutFirstRetryContextPolicy,
    testLayoutFormatRetryIsSurgicalAndBounded,
    testCompleteReferenceCorpus,
    testLayoutReaderIsAvailableBeforeParsing,
    testCompletedLayoutCreatesPDFItemAttachments,
    testWebMachineRetranslationIncrementsPDFRevision,
    testLayoutBodyLeadingIsSlightlyRelaxed,
    testLayoutCapacityUsesTranslatedText,
    testLayoutCollisionGeometryUsesSourcePdfCoordinates,
    testLayoutComposesAtSourcePdfDimensions,
    testBundledSourceHanSerif,
    testLayoutMultiPassTargetedRetryWithErrorFeedback,
    testLayoutFitParityForTitlesAndGlyphCollision,
  };
};
