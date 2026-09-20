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

  return {
    testUtils,
    testMarkdown,
    testShortTemporaryDirectory,
  };
};
