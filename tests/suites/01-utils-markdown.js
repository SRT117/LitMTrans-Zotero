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

async function testUtils() {
  assert.equal(U.isMinerUTokenCredentialError('HTTP 401: {"msgCode":"A0211","msg":"user token expired"}'), true);
  assert.equal(U.isMinerUTokenCredentialError({ status: 401, message: "Unauthorized" }), true);
  assert.equal(U.isMinerUTokenCredentialError("MinerU token无效，请重新配置"), true);
  assert.equal(U.isMinerUTokenCredentialError("HTTP 429: Too Many Requests"), false);
  prefValues.set("extensions.ai-literature-translator.provider", "deepseek");
  U.migrateLegacyPreferences();
  assert.equal(
    prefValues.get("extensions.litmtrans.provider"),
    "deepseek",
    "legacy preferences must migrate without deleting the old branch"
  );
  prefValues.set("extensions.ai-literature-translator.provider", "gemini");
  U.migrateLegacyPreferences();
  assert.equal(
    prefValues.get("extensions.litmtrans.provider"),
    "deepseek",
    "the one-time migration must not overwrite a current LitMTrans setting"
  );
  prefValues.delete("extensions.ai-literature-translator.provider");
  prefValues.delete("extensions.litmtrans.provider");
  prefValues.delete("extensions.litmtrans.migration.legacyPreferencesV1");

  // 旧版本默认 API 只迁移一次，更新后默认进入官方网页模式。
  prefValues.set("extensions.litmtrans.chatEngine", "api");
  U.migrateChatEngineWebDefault();
  assert.equal(
    prefValues.get("extensions.litmtrans.chatEngine"),
    "deepseek_web",
    "old chat engine default must migrate to DeepSeek web mode"
  );
  assert.equal(prefValues.get("extensions.litmtrans.migration.chatEngineWebDefaultV1"), true);
  prefValues.set("extensions.litmtrans.chatEngine", "api");
  U.migrateChatEngineWebDefault();
  assert.equal(
    prefValues.get("extensions.litmtrans.chatEngine"),
    "api",
    "a later explicit API choice must remain stable after the one-time migration"
  );
  prefValues.delete("extensions.litmtrans.chatEngine");
  prefValues.delete("extensions.litmtrans.migration.chatEngineWebDefaultV1");

  // 老用户历史受污染的chatUsesTranslationModel修复测试
  prefValues.set("extensions.litmtrans.chatUsesTranslationModel", false);
  prefValues.set("extensions.litmtrans.translationProvider", "gemini");
  prefValues.set("extensions.litmtrans.translationModel", "gemini-3.5-flash-lite");
  prefValues.set("extensions.litmtrans.chatProvider", "gemini");
  prefValues.set("extensions.litmtrans.chatModel", "gemini-3.5-flash-lite");
  U.repairSharedChatModelPreference();
  assert.equal(
    prefValues.get("extensions.litmtrans.chatUsesTranslationModel"),
    true,
    "equivalent translation and chat models must be safely restored to shared mode"
  );
  prefValues.delete("extensions.litmtrans.migration.sharedChatModelRepairV1");

  // 独立配置不同对话模型的用户不可被误篡改
  prefValues.set("extensions.litmtrans.chatUsesTranslationModel", false);
  prefValues.set("extensions.litmtrans.chatEngine", "api");
  prefValues.set("extensions.litmtrans.translationProvider", "deepseek");
  prefValues.set("extensions.litmtrans.translationModel", "deepseek-chat");
  prefValues.set("extensions.litmtrans.chatProvider", "openai");
  prefValues.set("extensions.litmtrans.chatModel", "gpt-4o");
  U.repairSharedChatModelPreference();
  assert.equal(
    prefValues.get("extensions.litmtrans.chatUsesTranslationModel"),
    false,
    "distinct dedicated chat models must strictly retain their independent false state"
  );
  prefValues.delete("extensions.litmtrans.migration.sharedChatModelRepairV1");

  // 边界用例1：模型名称相同但BaseURL不同（如翻译为自定义代理，聊天为默认URL），必须严格保持false
  prefValues.set("extensions.litmtrans.chatUsesTranslationModel", false);
  prefValues.set("extensions.litmtrans.translationProvider", "openai");
  prefValues.set("extensions.litmtrans.translationModel", "gpt-4o");
  prefValues.set("extensions.litmtrans.translationBaseURL", "https://proxy.example.com/v1");
  prefValues.set("extensions.litmtrans.chatProvider", "openai");
  prefValues.set("extensions.litmtrans.chatModel", "gpt-4o");
  prefValues.set("extensions.litmtrans.chatBaseURL", "");
  U.repairSharedChatModelPreference();
  assert.equal(
    prefValues.get("extensions.litmtrans.chatUsesTranslationModel"),
    false,
    "distinct BaseURL must strictly retain independent false state"
  );
  prefValues.delete("extensions.litmtrans.migration.sharedChatModelRepairV1");

  // 边界用例2：处于deepseek_web模式，但chatProvider不同且chatModel为空，绝不可误认为未配置而覆写
  prefValues.set("extensions.litmtrans.chatUsesTranslationModel", false);
  prefValues.set("extensions.litmtrans.chatEngine", "deepseek_web");
  prefValues.set("extensions.litmtrans.translationProvider", "gemini");
  prefValues.set("extensions.litmtrans.translationModel", "gemini-3.5-flash-lite");
  prefValues.set("extensions.litmtrans.chatProvider", "openai");
  prefValues.set("extensions.litmtrans.chatModel", "");
  U.repairSharedChatModelPreference();
  assert.equal(
    prefValues.get("extensions.litmtrans.chatUsesTranslationModel"),
    false,
    "deepseek_web with different chatProvider and empty model must not be overwritten"
  );

  prefValues.delete("extensions.litmtrans.chatUsesTranslationModel");
  prefValues.delete("extensions.litmtrans.chatEngine");
  prefValues.delete("extensions.litmtrans.translationProvider");
  prefValues.delete("extensions.litmtrans.translationModel");
  prefValues.delete("extensions.litmtrans.translationBaseURL");
  prefValues.delete("extensions.litmtrans.chatProvider");
  prefValues.delete("extensions.litmtrans.chatModel");
  prefValues.delete("extensions.litmtrans.chatBaseURL");
  prefValues.delete("extensions.litmtrans.migration.sharedChatModelRepairV1");
  assert.equal(U.normalizeBaseURL("https://openrouter.ai/api", "openrouter"), "https://openrouter.ai/api/v1");
  assert.equal(U.normalizeBaseURL("https://api.deepseek.com/chat/completions", "deepseek"), "https://api.deepseek.com");
  assert.equal(U.providerSpec("oneapi").defaultBaseURL, "");
  assert.equal(U.providerSpec("openai_compatible").name, "OpenAI 兼容接口");
  assert.equal(
    U.normalizeBaseURL("https://gateway.example/chat/completions", "openai_compatible"),
    "https://gateway.example/v1"
  );
  assert.equal(U.endpointURL("https://api.siliconflow.cn/v1", "models", "siliconflow"), "https://api.siliconflow.cn/v1/models?sub_type=chat");
  assert.equal(U.endpointURL("https://api.siliconflow.cn/v1", "chat/completions", "siliconflow"), "https://api.siliconflow.cn/v1/chat/completions");
  assert.equal(U.extension("paper.PDF"), ".pdf");
  assert(!U.safeStem("../bad:name", 80).includes("/"));
  const figureOneKey = U.imageAnchorKey("resource://litmtrans-data/doc/images/figure-1.png");
  const figureEightKey = U.imageAnchorKey("resource://litmtrans-data/doc/images/figure-8.png");
  const figureNineKey = U.imageAnchorKey("resource://litmtrans-data/doc/images/figure-9.png");
  assert.notEqual(figureOneKey, figureEightKey, "different image resources must never share a scroll anchor key");
  assert.deepEqual(
    [...U.sharedImageAnchorKeys(
      [figureOneKey, figureEightKey],
      [figureNineKey, figureOneKey]
    )],
    [figureOneKey],
    "scroll sync must match the same image resource even when pane image order differs"
  );
  assert.deepEqual(
    [...U.sharedImageAnchorKeys([figureOneKey], [figureEightKey])],
    [],
    "different figures at the same ordinal position must not be paired"
  );
  assert.deepEqual(
    [...U.sharedImageAnchorKeys(
      [figureOneKey, figureOneKey],
      [figureOneKey, figureOneKey]
    )],
    [],
    "repeated use of one image resource must be excluded when its occurrence cannot be paired unambiguously"
  );
  assert.equal(U.redactLocalPaths("来源: C:\\Users\\Alice\\paper.pdf"), "来源: [本地路径已隐藏]");
  assert.equal(U.redactLocalPaths("文件路径: \\\\server\\private\\notes.txt"), "文件路径: [本地路径已隐藏]");
  assert.equal(
    context.LitMTransPort.removeLocalAbsolutePaths("$$\\n\\begin{array}{l}a\\\\ = b\\end{array}\\n$$"),
    "$$\\n\\begin{array}{l}a\\\\ = b\\end{array}\\n$$",
    "TeX row breaks must not be mistaken for UNC paths"
  );
  assert.equal(
    context.LitMTransPort.removeLocalAbsolutePaths("来源: C:\\Users\\Alice\\paper.pdf；共享：\\\\server\\private\\notes.txt"),
    "来源: [本地路径已隐藏]",
    "Windows drive and UNC paths must remain redacted"
  );
  assert.equal(
    context.LitMTransPort.removeLocalAbsolutePaths("在线查看: http:\\\\doi.org\\10.1063/1.1421630"),
    "在线查看: http:\\\\doi.org\\10.1063/1.1421630",
    "OCR-damaged citation URLs must not be mistaken for UNC paths"
  );
  assert.equal(
    context.LitMTransPort.removeLocalAbsolutePaths("目录: https:\\doi.org\\10.1063/1.1421630"),
    "目录: https:\\doi.org\\10.1063/1.1421630",
    "single-backslash OCR citation URLs must not be redacted"
  );
  assert(U.markerDetected("done LitMTrans_TRANSLATION_END_123_456", "LitMTrans_TRANSLATION_END_123_456"));
  assert.equal(U.providerSpec("siliconflow").name, "硅基流动 (SiliconFlow)");
  const pastedName = U.pastedImageName(new Date(2026, 7, 4, 10, 34, 55, 123), 2, "image/png");
  assert.equal(pastedName, "粘贴图片-20260804-103455-123-02.png");
  assert(U.isIdentifiedPastedImageName(pastedName));
  assert.equal(U.chatImageExtension("image/jpeg"), ".jpg");
  assert.equal(await U.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await U.sha256Bytes(new Uint8Array([0x61, 0x62, 0x63])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(ChatInternals.decodeImageDataURL("data:image/bmp;base64,Qk0=").mimeType, "image/bmp");
  assert.equal(ChatInternals.decodeImageDataURL("data:image/jp2;base64,anAy").mimeType, "image/jp2");
  assert.equal(ChatInternals.decodeImageDataURL("data:image/svg+xml;base64,PHN2Zz4=").mimeType, "image/svg+xml");
  assert.equal(LLMInternals.decodeImageDataURL("data:image/bmp;base64,Qk0=").mimeType, "image/bmp");
  assert.equal(LLMInternals.detectImageMimeType(new Uint8Array([0x42, 0x4d])), "image/bmp");
  assert.equal(LLMInternals.detectImageMimeType(new TextEncoder().encode("<svg></svg>")), "image/svg+xml");
}

function testMarkdown() {
  const unsafe = M.renderMarkdown("<script>alert(1)</script>");
  assert(!unsafe.includes("<script>"));
  assert(unsafe.includes("&lt;script&gt;"));

  const renderPaddle = (text, options = {}) => M.renderMarkdown(text, { ...options, parseProvider: "paddle" });
  const paddleFigure = '<div style="text-align: center;">\n\n![IMAGE_001](images/a.png)\n\n</div>\n\n<div style="text-align: center;">FIG. 3. Caption with $x+y$.</div>\n\nBody text.';
  const paddleHTML = renderPaddle(M.injectSyncAnchors(paddleFigure), {
    resolveImage: () => "resource://litmtrans-data/doc/images/a.png"
  });
  assert(!paddleHTML.includes("&lt;div") && !paddleHTML.includes("&lt;/div"), "Paddle centering wrappers must not appear as reader text");
  assert(paddleHTML.includes("<img") && paddleHTML.includes("FIG. 3. Caption") && paddleHTML.includes("litmtrans-math-inline") && paddleHTML.includes("Body text."));
  assert(paddleHTML.includes('id="doc-block-0005"'), "existing source block anchors must survive display adaptation");
  const centerTag = '<div style="text-align: center;">';
  assert(renderPaddle('```html\n' + centerTag + '\n</div>\n```').includes("&lt;div"), "fenced HTML examples must stay literal");
  assert(renderPaddle('`' + centerTag + '`').includes("&lt;div"), "inline HTML examples must stay literal");
  assert(renderPaddle('```html\n' + centerTag).includes("&lt;div"), "incomplete code fences must stay literal during streaming");
  assert(!renderPaddle(centerTag + '\n\nCaption').includes("&lt;div"), "an unfinished centered block must render during streaming");
  assert(renderPaddle('<div onclick="alert(1)">Text</div>').includes("&lt;div"), "other HTML must retain the existing escaping policy");
  const nestedHTML = renderPaddle(centerTag + '\n<div class="unknown">Text</div>\n</div>');
  assert(nestedHTML.includes('&lt;div class=') && nestedHTML.match(/&lt;\/div&gt;/g)?.length === 1, "unknown nested divs must retain their own closing tags");

  const defaultHTML = M.renderMarkdown(paddleFigure);
  assert(defaultHTML.includes('&lt;div style='), "default rendering must retain the original HTML escaping behavior");
  assert.equal(M.renderMarkdown(paddleFigure, { parseProvider: "mineru" }), defaultHTML, "MinerU must bypass Paddle adaptation");
  assert.equal(M.renderMarkdown(paddleFigure, { parseProvider: "unknown" }), defaultHTML, "unknown providers must bypass Paddle adaptation");

  const math = M.renderMarkdown("Equation \\(\\frac{a}{b}\\) remains.");
  assert(math.includes("litmtrans-frac"));
  const paddedDollarMath = M.renderMarkdown("At $R / R _ { 0 } = 6 , 1 0 $ the after flow dominates.");
  assert(paddedDollarMath.includes("litmtrans-math-inline"),
    "MinerU-style TeX with a space before its closing dollar delimiter must render");
  const paddedDollarProse = M.renderMarkdown("The literal marker is $price $ only.");
  assert(paddedDollarProse.includes("$price $"),
    "ordinary dollar-delimited prose must not be promoted to mathematics");
  const comparisonMath = M.renderTeX("R/R_0 &gt; 12");
  assert(comparisonMath.endsWith("R/R<sub>0</sub> &gt; 12</span>"),
    "HTML comparison entities inside TeX must be decoded before rendering");
  const repairedChatMath = M.normalizeBareTeXFragments("The fitted value is s_{\\text{wp}}.");
  assert(repairedChatMath.includes("\\(s_{\\text{wp}}\\)"), "bare TeX subscripts in AI replies must gain inline delimiters");
  const commandScriptChatMath = M.normalizeBareTeXFragments("The fitted value is u_\\text{wp}.");
  assert(commandScriptChatMath.includes("\\(u_\\text{wp}\\)"), "bare TeX scripts followed directly by a command must gain inline delimiters");
  const imageInsideBold = "**![IMAGE_004](images/image_004.jpg) (FIG. 3)**";
  const repairedImageInsideBold = M.normalizeBareTeXFragments(imageInsideBold);
  assert.equal(repairedImageInsideBold, imageInsideBold, "MinerU IMAGE_004 ids inside Markdown images must not be rewritten as bare TeX subscripts");
  assert(!M.renderMarkdown(repairedImageInsideBold).includes("@@LitMTrans"), "nested Markdown formatting must never leak internal renderer placeholders");
  assert.equal(
    M.normalizeEscapedTeXDelimiters("Gateway returned \\\\(u_{\\\\mathrm{sw}}\\\\)."),
    "Gateway returned \\(u_{\\mathrm{sw}}\\).",
    "doubly escaped complete TeX expressions must be decoded before rendering"
  );
  assert.equal(
    M.normalizeTranslatedInlineHTML("Values \\\\(\\\\mu > 0\\\\) and \\\\(\\\\rho_{0}\\\\); C:\\\\Temp remains."),
    "Values \\(\\mu > 0\\) and \\(\\rho_{0}\\); C:\\\\Temp remains.",
    "translation normalization must decode standalone TeX commands only inside complete formulas"
  );
  assert.equal(
    M.normalizeBareTeXFragments("Already rendered: \\(s_{\\text{wp}}\\)."),
    "Already rendered: \\(s_{\\text{wp}}\\).",
    "existing TeX delimiters must remain unchanged"
  );
  const displayMath = M.renderMarkdown("$$\n\\frac{a}{b}\n$$");
  assert(displayMath.includes("litmtrans-math-display"), "multi-line display mathematics must be rendered as one formula block");
  assert(displayMath.includes("litmtrans-frac"));
  const arrayMath = M.renderMarkdown("$$\n\\begin{array}{l}a\\\\b\\end{array}\n$$");
  assert(arrayMath.includes("litmtrans-matrix"), "array alignment declarations must not prevent formula rendering");
  assert.equal(M.mathIntegrityIssue("A \\(x+y\\)", "B \\(x+y\\)"), "");
  assert(M.mathIntegrityIssue("A \\(x+y\\)", "B \\(x-y\\)"));
  assert.equal(
    M.repairEquationReferenceTranslation("", "See Eq. \\~2! and Eqs. \\~3! and \\~4!."),
    "See Eq. (2) and Eqs. (3) and (4).",
    "MinerU-garbled source equation references must be safe to render"
  );

  const remoteImage = M.renderMarkdown("![x](https://example.com/a.png)");
  assert(!remoteImage.includes("<img"));
  const localImage = M.renderMarkdown("![x](images/a.png)", { resolveImage: () => "resource://litmtrans-data/doc/images/a.png" });
  assert(localImage.includes("<img"));
  assert(localImage.includes(" />"), "XHTML workbench requires self-closing image tags");
  assert(localImage.includes('loading="lazy"'), "markdown images should remain lazy by default");
  assert(!localImage.includes('style="width:'), "images without a layout width must retain their natural display width");
  const sizedLocalImage = M.renderMarkdown("![x](images/a.png)", {
    resolveImage: () => "resource://litmtrans-data/doc/images/a.png",
    resolveImageWidth: () => 42.5
  });
  assert(sizedLocalImage.includes('style="width:42.5%"'), "a valid layout image width must remain bounded and rendered");
  const eagerImage = M.renderMarkdown("![x](images/a.png)", {
    resolveImage: () => "resource://litmtrans-data/doc/images/a.png",
    imageLoading: "eager"
  });
  assert(eagerImage.includes('loading="eager"'), "stream readers must eagerly load images before measuring sync anchors");
  assert(M.renderMarkdown("line one\nline two").includes("<br />"));
  assert.equal(
    M.toXHTMLFragment('<p>line<br>next<img src="image.png"></p>'),
    '<p>line<br />next<img src="image.png" /></p>',
    "HTML-parser output must be normalized before assigning it to XHTML innerHTML"
  );
  const anchored = M.injectSyncAnchors("# Title\n\nFirst paragraph.\n\nSecond paragraph.");
  assert(anchored.includes('id="doc-block-0001"'));
  assert(anchored.includes('id="doc-block-0003"'));
  const anchoredHTML = M.renderMarkdown(anchored);
  assert(anchoredHTML.includes('class="litmtrans-anchor litmtrans-sync-anchor"'), "reader block anchors must survive Markdown rendering");

  const source = "# A\n\n" + "Paragraph. ".repeat(200) + "\n\n# B\n\n" + "Second. ".repeat(200);
  const chunks = M.splitForTranslation(source, 800);
  assert(chunks.length > 1);
  assert.equal(chunks.join(""), source);

  const formulaSource = "前文\n$$\nx + y = z\n$$\n后文";
  const formulaBlocks = M.markdownBlocks(formulaSource);
  assert.equal(formulaBlocks.length, 2, "display-math blocks must remain intact through adjacent prose");
  assert(formulaBlocks[0].includes("$$\nx + y = z\n$$\n"));
}

function testShortTemporaryDirectory() {
  const storage = new context.LitMTrans.Storage();
  const temporary = storage.temporaryDir("parse");
  assert(temporary.includes("\\litmtrans-tmp\\parse-") || temporary.includes("/litmtrans-tmp/parse-"));
  assert(temporary.length < 80, "MinerU temporary extraction path must remain short");
}

function testFullwidthMathRendering() {
  const previous = context.katex;
  context.katex = require("katex");
  try {
    const broken = "缩比不小于 \\(1/12\\））\\(^{62}\\)";
    const correct = "缩比不小于 \\(1/12\\)）\\(^{62}\\)";
    assert.equal(M.renderInline(broken), M.renderInline(correct));
    assert.equal(M.renderInline("\\（x+1\\）"), M.renderInline("\\(x+1\\)"));
    assert.equal(M.renderInline("\\［x+2\\］"), M.renderInline("\\[x+2\\]"));
    assert.equal(M.renderTeX("\\frac{a｝{b}"), M.renderTeX("\\frac{a}{b}"));
    const valid = "\\text{中文（说明）}";
    assert.equal(M.renderTeX(valid), context.katex.renderToString(valid, {
      displayMode: false, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml"
    }));
    assert(M.renderTeX("\\frac{｛x｝").includes('class="katex-error"'));
    const code = M.renderInline("`\\(1/12\\）` 中文（括号）");
    assert(code.includes("<code>\\(1/12\\）</code>"));
    assert(code.includes("中文（括号）"));
    assert(!M.renderInline("\\(\\frac{a\\）").includes('class="katex"'));
  }
  finally { context.katex = previous; }
}

async function testFullwidthMathCacheRepair() {
  const previous = context.katex;
  vm.runInContext(fs.readFileSync(path.join(root, "assets/vendor/katex/katex.min.js"), "utf8"), context);
  try {
    const broken = "缩比 \\(1/12\\））\\(^{62}\\)";
    const correct = "缩比 \\(1/12\\)）\\(^{62}\\)";
    const protectedText = "正文（说明）\n```tex\n" + broken + "\n```\n`" + broken + "`";
    assert.equal(M.repairFullwidthMathSyntax(protectedText), protectedText);
    assert.equal(M.repairFullwidthMathSyntax("```tex\n" + broken), "```tex\n" + broken);
    assert.equal(M.repairFullwidthMathSyntax("\\(\\text{中文（说明）}\\)"), "\\(\\text{中文（说明）}\\)");
    assert.equal(M.repairFullwidthMathSyntax("\\(\\frac{a\\）"), "\\(\\frac{a\\）");
    assert.equal(M.repairFullwidthMathSyntax("\\(\\frac｛a｝｛b｝\\)"), "\\(\\frac｛a｝｛b｝\\)");
    assert.equal(M.repairFullwidthMathSyntax("\\(\\frac{a｝{b}\\)"), "\\(\\frac{a}{b}\\)");
    const storage = new MemoryStorage();
    const readJSON = storage.readJSON.bind(storage);
    storage.readJSON = async (file, fallback) => storage.text.has(file)
      ? JSON.parse(storage.text.get(file)) : readJSON(file, fallback);
    let sequence = 0;
    let writes = 0;
    storage.temporaryDir = () => storage.path("repair-tmp", String(++sequence));
    storage.writeTextAtomically = async (...args) => {
      writes++;
      return context.LitMTrans.Storage.prototype.writeTextAtomically.apply(storage, args);
    };
    const llm = { getSettings: () => ({ targetLanguage: "简体中文" }) };
    const layout = new LayoutTranslationService(storage, llm);
    const paths = layout.paths("repair", "简体中文");
    const meta = { identity: "old", complete: true, sourceFingerprint: "source" };
    await storage.writeJSON(paths.translations, { block: broken, other: "中文（不变）" });
    await storage.writeJSON(paths.meta, meta);
    const loaded = await layout.loadTranslations("repair");
    assert.equal(loaded.translations.block, correct);
    assert.equal((await storage.readJSON(paths.translations)).block, correct);
    assert.deepEqual(loaded.meta, meta);
    assert.equal((await layout.loadTranslations("repair")).translations.other, "中文（不变）");
    assert.equal(writes, 1);
    const rows = layout.parseTranslationResponse(JSON.stringify({ translations: [{ id: "block", text: broken }] }), [{ id: "block", text: correct }]);
    assert.equal(rows.translations.block, correct);
    const stream = new TranslationService(storage, llm);
    const streamPaths = stream.paths("repair", "简体中文");
    await storage.writeText(streamPaths.final, broken);
    await storage.writeJSON(streamPaths.meta, meta);
    assert.equal((await stream.load("repair")).markdown, correct);
    assert.equal(await storage.readText(streamPaths.final), correct);
    await stream.load("repair");
    assert.equal(writes, 2);
    const controller = Object.create(context.LitMTrans.Controller.prototype);
    controller.parser = { loadParsed: async () => null };
    controller.translation = stream;
    assert.equal(await controller.streamMarkdownForExport("repair", "translation"), correct);
    await stream.publishFinal(streamPaths, broken, meta);
    assert.equal(await storage.readText(streamPaths.final), correct);
    assert(!(await storage.list(storage.path("repair-tmp"))).length);
    await storage.writeText(streamPaths.final, broken);
    const publish = storage.publishFilesAtomically;
    storage.publishFilesAtomically = async () => { throw new Error("publish failed"); };
    await assert.rejects(() => stream.load("repair"), /publish failed/);
    assert.equal(await storage.readText(streamPaths.final), broken);
    assert(!(await storage.list(storage.path("repair-tmp"))).length);
    storage.publishFilesAtomically = publish;
  }
  finally { context.katex = previous; }
}

  return {
    testUtils,
    testMarkdown,
    testShortTemporaryDirectory,
    testFullwidthMathRendering,
    testFullwidthMathCacheRepair,
  };
};
