#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const desktop = path.join(process.env.USERPROFILE || path.dirname(path.dirname(root)), "Desktop");
const DEFAULT_FIXTURE = path.join(desktop, "临时解析文件", "Shock-Hugoniot-compression-curve-for-water");
const DEFAULT_PYTHON_ROOT = path.join(desktop, "Literature analysis and reading workbench");
const OUTPUT_ROOT = path.join(root, "output", "playwright", "layout-parity");
const FIT_NODES = ".layout-flow-stream, .layout-block";

function parseArgs(argv) {
  const options = {
    fixture: DEFAULT_FIXTURE,
    translationCache: "",
    pluginModel: "",
    pluginOnly: false,
    publishAfterInit: false,
    publishWhileHidden: false,
    pythonRoot: DEFAULT_PYTHON_ROOT,
    output: OUTPUT_ROOT,
    artifactOutput: path.join(path.dirname(root), "LitMTrans-layout-parity-artifacts"),
    keepBrowser: false,
    skipPythonRender: false,
    profile: false,
    profileLegacyFinalAudit: false,
    noPDF: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--fixture") options.fixture = argv[++index];
    else if (value === "--translation-cache") options.translationCache = argv[++index];
    else if (value === "--plugin-model") options.pluginModel = argv[++index];
    else if (value === "--plugin-only") options.pluginOnly = true;
    else if (value === "--publish-after-init") options.publishAfterInit = true;
    else if (value === "--publish-while-hidden") {
      options.publishAfterInit = true;
      options.publishWhileHidden = true;
    }
    else if (value === "--python-root") options.pythonRoot = argv[++index];
    else if (value === "--output") options.output = argv[++index];
    else if (value === "--artifact-output") options.artifactOutput = argv[++index];
    else if (value === "--keep-browser") options.keepBrowser = true;
    else if (value === "--skip-python-render") options.skipPythonRender = true;
    else if (value === "--profile") options.profile = true;
    else if (value === "--profile-legacy-final-audit") options.profileLegacyFinalAudit = true;
    else if (value === "--no-pdf") options.noPDF = true;
    else if (value === "--help" || value === "-h") {
      console.log("node scripts/layout-parity-test.mjs [--fixture DIR] [--translation-cache JSON] [--plugin-model JSON] [--plugin-only] [--publish-after-init|--publish-while-hidden] [--python-root DIR] [--output DIR] [--artifact-output DIR] [--keep-browser] [--skip-python-render] [--profile] [--profile-legacy-final-audit] [--no-pdf]");
      process.exit(0);
    }
    else throw new Error(`Unknown argument: ${value}`);
  }
  options.fixture = path.resolve(options.fixture);
  if (options.translationCache) options.translationCache = path.resolve(options.translationCache);
  if (options.pluginModel) options.pluginModel = path.resolve(options.pluginModel);
  options.pythonRoot = path.resolve(options.pythonRoot);
  options.output = path.resolve(options.output);
  options.artifactOutput = path.resolve(options.artifactOutput);
  return options;
}

function readJSON(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function cacheTranslations(cache) {
  if (!Array.isArray(cache?.translations)) return { ...(cache?.translations || {}) };
  return Object.fromEntries(cache.translations
    .filter(item => item && item.id)
    .map(item => [String(item.id), String(item.text || "")]));
}

function readTranslationCache(options) {
  const filename = options.translationCache || path.join(options.fixture, "layout_translation_blocks.zh.json");
  const cache = readJSON(filename);
  // Zotero persists the production translation map directly, while the
  // Python desktop project wraps the same map in a cache envelope.  Accept
  // both so one freshly generated Zotero translation can be measured by both
  // real layout engines without copying or rewriting user data.
  if (cache && !Array.isArray(cache) && !Object.hasOwn(cache, "translations")) {
    return { translations: cache, formula_replacements: {} };
  }
  return cache;
}

function buildAssetMap(fixture) {
  const records = readJSON(path.join(fixture, "image_map.json"));
  const output = {};
  for (const record of records) {
    const original = String(record.original_target || "").replaceAll("\\", "/");
    const clean = String(record.clean_target || "").replaceAll("\\", "/");
    if (original) output[original] = `mineru_result/${original}`;
    if (clean) output[clean] = clean;
    if (original) output[path.posix.basename(original)] = `mineru_result/${original}`;
    if (clean) output[path.posix.basename(clean)] = clean;
  }
  return output;
}

function buildPluginModel(options) {
  const fixture = options.fixture;
  if (options.pluginModel) {
    const payload = readJSON(options.pluginModel);
    const model = payload?.model || payload;
    assert.ok(Array.isArray(model?.pages), `Invalid compiled plugin model: ${options.pluginModel}`);
    const cache = options.translationCache
      ? readTranslationCache(options)
      : { translations: Object.fromEntries((model.pages || []).flatMap(page => page.blocks || [])
        .filter(block => block?.id && block?.translatedText)
        .map(block => [String(block.id), String(block.translatedText)])) };
    return Promise.resolve({
      model,
      translations: cacheTranslations(cache),
      engineTrace: { styles: model.styles || {}, bodyStreams: [], source: options.pluginModel },
    });
  }
  const layoutPath = path.join(fixture, "mineru_result", "layout.json");
  const modelPath = path.join(fixture, "mineru_result", "merged_model.json");
  const layoutPayload = readJSON(layoutPath);
  const modelPayload = readJSON(modelPath);
  const cache = readTranslationCache(options);
  const translations = cacheTranslations(cache);
  const formulaReplacements = cache.formula_replacements && !Array.isArray(cache.formula_replacements)
    ? cache.formula_replacements
    : {};
  const assetMap = buildAssetMap(fixture);
  const writes = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    fetch,
    crypto: { randomUUID: crypto.randomUUID },
    atob: value => Buffer.from(String(value), "base64").toString("binary"),
    btoa: value => Buffer.from(String(value), "binary").toString("base64"),
    PathUtils: {
      join: (...parts) => path.posix.join(...parts.map(part => String(part).replaceAll("\\", "/"))),
      parent: value => path.posix.dirname(String(value)),
      filename: value => path.posix.basename(String(value)),
    },
    Zotero: { locale: "zh-CN", debug() {}, logError(error) { throw error; } },
    Services: {}, Cc: {}, Ci: {}, IOUtils: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  const load = relative => vm.runInContext(
    fs.readFileSync(path.join(root, relative), "utf8"),
    context,
    { filename: path.join(root, relative) },
  );
  load("assets/vendor/katex/katex.min.js");
  load("src/ported-core.js");
  for (const relative of ["src/utils.js", "src/markdown.js", "src/mineru.js", "src/layout.js"]) load(relative);

  const documentID = "layout-parity-fixture";
  const storage = {
    path: (...parts) => path.posix.join("/data", ...parts),
    async readJSON(filename, fallback = null) {
      if (filename.endsWith("/layout.json")) return structuredClone(layoutPayload);
      if (filename.endsWith("/model.json")) return structuredClone(modelPayload);
      if (filename.endsWith("/asset-map.json")) return structuredClone(assetMap);
      return writes.has(filename) ? structuredClone(writes.get(filename)) : fallback;
    },
    async readText(filename, fallback = "") {
      return filename.endsWith("/layout.json") ? fs.readFileSync(layoutPath, "utf8") : fallback;
    },
    async writeJSON(filename, value) { writes.set(filename, structuredClone(value)); },
    resourceURL(_id, relative) {
      return `/fixture/${String(relative || "").replaceAll("\\", "/").replace(/^\/+/, "")}`;
    },
  };
  const service = new context.LitMTrans.LayoutTranslationService(storage, {
    getSettings: () => ({ targetLanguage: "简体中文" }),
  });
  return service.buildModel(documentID, translations, formulaReplacements).then(model => {
    const helpers = context.LitMTrans.LayoutHelpers;
    const bodyStreams = model.pages.flatMap(page => (page.restoration?.streams || [])
      .filter(stream => stream.styleKind === "body_text")
      .map(stream => ({
        page: page.index,
        bbox: stream.bbox,
        lineMetrics: helpers.streamLineMetrics(stream, page.restoration?.ocrBoxes || []),
      })));
    return {
      model,
      translations,
      engineTrace: { styles: model.styles, bodyStreams },
    };
  });
}

function safeInlineJSON(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function sourceOnlyModel(model) {
  const source = structuredClone(model);
  const scrub = value => {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "translatedText")) value.translatedText = "";
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(scrub);
      else if (child && typeof child === "object") scrub(child);
    }
  };
  scrub(source);
  return source;
}

function pluginHostScript(model, translations, options) {
  const initialModel = options.publishAfterInit ? sourceOnlyModel(model) : model;
  const state = {
    item: {
      documentID: "layout-parity-fixture",
      title: "Shock Hugoniot compression curve for water",
      fileName: "Shock Hugoniot compression curve for water.pdf",
      attachmentID: 0,
    },
    capabilities: {
      hasParsed: true,
      canTranslate: false,
      canUseLayoutReader: true,
      canExportPDF: true,
    },
    settings: {
      layoutReadingMode: !options.publishWhileHidden,
      layoutDevelopmentMode: true,
      readerFontPt: 12,
      layoutReaderFonts: {},
      syncScroll: true,
      streamSyncScroll: true,
      targetLanguage: "简体中文",
      translationProvider: "openai",
      translationBaseURL: "",
      translationModel: "",
      translationMode: "full_context",
      translationReferencePaths: [],
      customTranslationInstruction: "",
      chatProvider: "openai",
      chatBaseURL: "",
      chatModel: "",
      chatUsesTranslationModel: true,
      chatRenderMarkdown: true,
      providerCards: [],
      keyPointsPrompt: "",
      keyPointsDefaultPrompt: "",
    },
    parsed: { markdown: "layout parity fixture", imageMap: [] },
    translation: { markdown: "" },
    layout: { model: initialModel, translations: options.publishAfterInit ? {} : translations, meta: { complete: true } },
    chat: { sessions: [], session: null },
    operations: [],
  };
  const publicationScript = options.publishAfterInit ? `
  window.addEventListener('load', function() {
    const finalModel = ${safeInlineJSON(model)};
    const finalTranslations = ${safeInlineJSON(translations)};
    const timer = setInterval(function() {
      const pane = document.querySelector('#translation-layout');
      if (!pane?.querySelector('.layout-page')) return;
      if (${options.publishWhileHidden ? "false" : "pane.classList.contains('layout-fit-pending')"}) return;
      clearInterval(timer);
      window.__LitMTrans_RECEIVE__?.({ type: 'event', payload: {
        type: 'layout-translation', translations: finalTranslations, model: finalModel,
        complete: true, translatedBlocks: Object.keys(finalTranslations).length,
        totalBlocks: Object.keys(finalTranslations).length
      }});
      const provisionalBody = pane.querySelector('.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]');
      window.__parityHiddenPublicationProbe = {
        pending: pane.classList.contains('layout-fit-pending'),
        hidden: pane.hidden || Boolean(pane.closest('[hidden]')),
        bodyFontPx: provisionalBody ? Number.parseFloat(getComputedStyle(provisionalBody).fontSize || '0') : 0,
        control: document.querySelector('#reader-font-input')?.value || ''
      };
      document.body.dataset.parityFinalPublished = '1';
      ${options.publishWhileHidden ? "setTimeout(function() { document.querySelector('#layout-mode-button')?.click(); }, 50);" : ""}
    }, 25);
  });` : "";
  return `<script>
  window.__LAYOUT_PARITY_STATE__ = ${safeInlineJSON(state)};
  window.__LitMTrans_HOST_CALL__ = function(method, rawPayload, requestID) {
    let payload = null;
    if (method === 'initialize' || method === 'refresh') payload = window.__LAYOUT_PARITY_STATE__;
    else if (method === 'viewport') payload = { width: innerWidth, height: innerHeight };
    else if (method === 'initialize-pdf-preview') payload = { available: false };
    else if (method === 'operation-state') payload = { operations: [] };
    else payload = null;
    setTimeout(function() {
      window.__LitMTrans_RECEIVE__?.({ type: 'response', requestID, ok: true, payload });
    }, 0);
  };
  ${publicationScript}
  </script>`;
}

function replaceProfiledEngineSection(source, expected, replacement) {
  assert.ok(source.includes(expected), `Cannot instrument copied plugin engine: ${expected.slice(0, 80)}`);
  return source.replace(expected, replacement);
}

function restoreLegacyFinalAuditInProfile(source) {
  const startMarker = "    // The legacy loop restarted from node zero after every backoff.";
  const endMarker = "\n  }\n\n  function refreshLayoutPageScales(pageWraps = null) {";
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end >= 0, "Cannot restore the legacy final audit in the disposable profile copy");
  const legacyLoop = String.raw`    for (let safety = 0; safety < 3000; safety += 1) {
      const candidates = nodes.filter((node) => !exhausted.has(node));
      if (!candidates.length) return;
      const finalProbe = beginBodyIterationProbe(candidates, 'final-safety-audit');
      const collision = textCollisionDetails(candidates, options);
      recordBodyIterationCollision(collision, finalProbe);
      if (!collision) return;
      const source = collision.source;
      let fontSize = layoutControlFontSize(source);
      let lineRatio = parseFloat(source.style.lineHeight || source.dataset.lineRatio || '1.1') || 1.1;
      const minFont = source.dataset.flowKind === 'ref_text' ? 4.8 : 4.8;
      const isBodyText = source.dataset.styleKind === 'body_text'
        && source.dataset.bodyInherited !== '1';
      const minLineRatio = isBodyText ? 1.02 : 0.98;
      const ownBox = elementBoxInPage(source);
      const firstLineTopCollision = !isBodyText
        && collision.rect
        && collision.rect.top < ownBox.top - 1;
      if (firstLineTopCollision && lineRatio < 1.85 - 0.001) {
        lineRatio = Math.min(1.85, lineRatio + 0.025);
      } else if (lineRatio > minLineRatio + 0.001) {
        lineRatio = Math.max(minLineRatio, lineRatio - 0.025);
      } else if (isBodyText) {
        exhausted.add(source);
        continue;
      } else if (fontSize > minFont + 0.001) {
        fontSize = Math.max(minFont, fontSize - 0.25);
      } else {
        exhausted.add(source);
        continue;
      }
      applyGroup([source], fontSize, lineRatio);
    }`;
  return `${source.slice(0, start)}${legacyLoop}${source.slice(end)}`;
}

function writeProfiledPluginEngine(outputPath, options) {
  // This creates a disposable copy under the parity output directory.  The
  // production workbench is never edited while collecting a profile.
  let source = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  if (options.profileLegacyFinalAudit) source = restoreLegacyFinalAuditInProfile(source);
  const profiler = String.raw`
  // Disposable parity-profiler hooks. This code exists only in
  // output/.../plugin-workbench.profile.js, never in src/workbench.js.
  let __layoutProfileCurrent = null;
  function __layoutProfileMeasure(label, work) {
    if (!__layoutProfileCurrent) return work();
    const startedAt = performance.now();
    try { return work(); }
    finally {
      const phases = __layoutProfileCurrent.phases;
      phases[label] = (phases[label] || 0) + (performance.now() - startedAt);
    }
  }
  function __layoutProfileLabel(selector) {
    const value = String(selector || "");
    if (value.includes("type-title")) return "titles";
    if (value.includes("body_text")) return "bodyGroup";
    if (value.includes("table_caption") || value.includes("footnote") || value.includes("chart_caption") || value.includes("image_caption") || value.includes("ref_text")) return "captionsRefs";
    if (value.includes("data-from-list") || value.includes("debug-text") || value.includes("type-text")) return "genericText";
    return "otherGroups";
  }
  window.__litmtransLayoutProfile = () => structuredClone(window.__litmtransLayoutProfileLast || { phases: {}, counters: {} });
`;
  source = replaceProfiledEngineSection(source, "  let activeFitPages = null;", `  let activeFitPages = null;${profiler}`);
  source = replaceProfiledEngineSection(source, "  function fitLayoutFormulas(pages) {", "  function __profileFitLayoutFormulas(pages) {");
  source = replaceProfiledEngineSection(source, "\n  function fitLayoutPages(pageNodes) {", `
  function fitLayoutFormulas(pages) {
    return __layoutProfileMeasure("formulas", () => __profileFitLayoutFormulas(pages));
  }

  function fitLayoutPages(pageNodes) {`);
  source = replaceProfiledEngineSection(source, "  function measureTextBand(el) {", "  function __profileMeasureTextBand(el) {");
  source = replaceProfiledEngineSection(source, "\n  // Layout fitting uses source PDF coordinates.", `
  function measureTextBand(el) {
    if (__layoutProfileCurrent) __layoutProfileCurrent.counters.measureTextBandCalls += 1;
    return __layoutProfileMeasure("measureTextBand", () => __profileMeasureTextBand(el));
  }

  // Layout fitting uses source PDF coordinates.`);
  source = replaceProfiledEngineSection(source, "  function textRectsInPage(el) {", "  function __profileTextRectsInPage(el) {");
  source = replaceProfiledEngineSection(source, "\n  function viewportRectInPage(page, rect) {", `
  function textRectsInPage(el) {
    if (__layoutProfileCurrent) __layoutProfileCurrent.counters.textRectsCalls += 1;
    return __layoutProfileMeasure("textRects", () => __profileTextRectsInPage(el));
  }

  function viewportRectInPage(page, rect) {`);
  source = replaceProfiledEngineSection(source, "  function textCollisionDetails(nodes, options = {}) {", "  function __profileTextCollisionDetails(nodes, options = {}) {");
  source = replaceProfiledEngineSection(source, "\n  function applyGroup(nodes, fontSize, lineRatio) {", `
  function textCollisionDetails(nodes, options = {}) {
    if (__layoutProfileCurrent) {
      __layoutProfileCurrent.counters.collisionProbes += 1;
      __layoutProfileCurrent.counters.collisionSourceNodes += nodes.length;
    }
    return __layoutProfileMeasure("collisionTotal", () => __profileTextCollisionDetails(nodes, options));
  }

  function applyGroup(nodes, fontSize, lineRatio) {`);
  source = replaceProfiledEngineSection(source, "  function tuneGroup(selector, options) {", "  function __profileTuneGroup(selector, options) {");
  source = replaceProfiledEngineSection(source, "  function tuneEach(selector, options) {", "  function __profileTuneEach(selector, options) {");
  source = replaceProfiledEngineSection(source, "\n  function titleFrameFill(node) {", `
  function tuneGroup(selector, options) {
    return __layoutProfileMeasure(__layoutProfileLabel(selector), () => __profileTuneGroup(selector, options));
  }
  function tuneEach(selector, options) {
    return __layoutProfileMeasure(__layoutProfileLabel(selector), () => __profileTuneEach(selector, options));
  }

  function titleFrameFill(node) {`);
  source = replaceProfiledEngineSection(source, "  function enforceFinalTextCollisionSafety() {", "  function __profileEnforceFinalTextCollisionSafety() {");
  source = replaceProfiledEngineSection(source, "\n  function refreshLayoutPageScales(pageWraps = null) {", `
  function enforceFinalTextCollisionSafety() {
    return __layoutProfileMeasure("finalSafetyAudit", () => __profileEnforceFinalTextCollisionSafety());
  }

  function refreshLayoutPageScales(pageWraps = null) {`);
  source = replaceProfiledEngineSection(source, "  function runLayoutParityEngine(pageWraps = null, persist = false) {", "  function __profileRunLayoutParityEngine(pageWraps = null, persist = false) {");
  source = replaceProfiledEngineSection(source, "\n  // Route the inspection hook through the same fitter", `
  function runLayoutParityEngine(pageWraps = null, persist = false) {
    const profile = {
      engine: "zotero-plugin-copy",
      startedAt: performance.now(),
      phases: {},
      counters: { textRectsCalls: 0, measureTextBandCalls: 0, collisionProbes: 0, collisionSourceNodes: 0 },
    };
    __layoutProfileCurrent = profile;
    try { return __layoutProfileMeasure("runTotal", () => __profileRunLayoutParityEngine(pageWraps, persist)); }
    finally {
      profile.elapsedMs = performance.now() - profile.startedAt;
      window.__litmtransLayoutProfileLast = profile;
      __layoutProfileCurrent = null;
    }
  }

  // Route the inspection hook through the same fitter`);
  fs.writeFileSync(outputPath, source, "utf8");
}

function writePluginHTML(outputPath, model, translations, options) {
  let html = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  html = html.replaceAll("chrome://litmtrans/content/", "/repo/");
  if (options.profile) html = html.replace('src="/repo/src/workbench.js"', 'src="/plugin-workbench.profile.js"');
  html = html.replace("</head>", `${pluginHostScript(model, translations, options)}\n</head>`);
  fs.writeFileSync(outputPath, html, "utf8");
}

async function renderPython(options, outputPath) {
  if (options.skipPythonRender && fs.existsSync(outputPath)) return;
  const python = path.join(options.pythonRoot, ".venv", "Scripts", "python.exe");
  assert.ok(fs.existsSync(python), `Python project virtual environment not found: ${python}`);
  const result = await execFileAsync(python, [
    path.join(root, "scripts", "layout-parity-python.py"),
    "--python-root", options.pythonRoot,
    "--fixture", options.fixture,
    "--output", outputPath,
    ...(options.translationCache ? ["--translation-cache", options.translationCache] : []),
  ], { cwd: options.pythonRoot, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  // The desktop renderer quite correctly emits file:/// image URLs for its
  // QWebEngine view.  This harness serves both engines over one local HTTP
  // origin, so translate only the fixture-root prefix for browser access.
  const fixtureURL = pathToFileURL(options.fixture + path.sep).href;
  let html = fs.readFileSync(outputPath, "utf8");
  if (options.profile) html = html.replace("<head>", "<head><script>window.__layoutPerfEnabled = true;</script>");
  fs.writeFileSync(outputPath, html
    .replaceAll(fixtureURL, "/fixture/")
    // The standalone Python preview normally loads this file from a file://
    // page. The parity harness serves the preview over HTTP, where Chromium
    // blocks that local font URL and silently falls back to Times New Roman.
    // Route it to the byte-identical plugin asset so both engines measure the
    // production Source Han Serif glyphs.
    .replace(/file:\/\/\/[^"'()]*SourceHanSerifCN-Regular\.ttf/gi, "/repo/assets/fonts/SourceHanSerifCN-Regular.ttf"), "utf8");
}

function mimeType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8", ".xhtml": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff",
  })[extension] || "application/octet-stream";
}

function safeResolved(base, relative) {
  const resolved = path.resolve(base, relative);
  const prefix = path.resolve(base) + path.sep;
  return resolved === path.resolve(base) || resolved.startsWith(prefix) ? resolved : null;
}

async function startServer(options, files) {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    let filename = null;
    if (pathname === "/plugin.html") filename = files.pluginHTML;
    else if (pathname === "/python.html") filename = files.pythonHTML;
    else if (pathname === "/plugin-workbench.profile.js") filename = files.profilePluginJS;
    else if (pathname === "/trace.js") filename = files.traceJS;
    else if (pathname.startsWith("/repo/")) filename = safeResolved(root, pathname.slice("/repo/".length));
    else if (pathname.startsWith("/fixture/")) filename = safeResolved(options.fixture, pathname.slice("/fixture/".length));
    if (!filename || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeType(filename),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(filename).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runCLI(session, ...args) {
  const npxCLI = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  assert.ok(fs.existsSync(npxCLI), `Cannot find npm's npx-cli.js beside ${process.execPath}`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [npxCLI,
    "--yes", "--package", "@playwright/cli", "playwright-cli", `-s=${session}`, ...args,
  ], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (stderr && !/Assertion failed/.test(stderr)) process.stderr.write(stderr);
  return stdout;
}

const browserTraceFunction = String.raw`() => {
  const nodeSelector = '.layout-flow-stream, .layout-block';
  const pageNodes = [...document.querySelectorAll('.layout-page')];
  const round = value => Math.round(Number(value || 0) * 1000) / 1000;
  const textRects = node => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        if (!textNode.textContent?.trim()) return NodeFilter.FILTER_REJECT;
        const parent = textNode.parentElement;
        if (parent?.closest('.mjx-assistive-mml, .katex-mathml, .layout-line-debug-box, .layout-collision-debug-layer')) return NodeFilter.FILTER_REJECT;
        if (parent?.closest('[aria-hidden="true"]') && !parent.closest('.katex-html')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const range = document.createRange();
    const rects = [];
    let textNode;
    while ((textNode = walker.nextNode())) {
      range.selectNodeContents(textNode);
      for (const rect of range.getClientRects()) {
        if (rect.width > .5 && rect.height > .5) rects.push(rect);
      }
    }
    range.detach?.();
    return rects;
  };
  const overlap = (a, b, tolerance) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
  const pages = pageNodes.map((page, pageOffset) => {
    const wrap = page.closest('.layout-page-wrap');
    const pageRect = page.getBoundingClientRect();
    const sourceWidth = Number(wrap?.dataset.sourceWidth || wrap?.dataset.pageWidth || page.dataset.sourceWidth || page.style.width.replace('px', '') || page.clientWidth || 1);
    const sourceHeight = Number(wrap?.dataset.sourceHeight || wrap?.dataset.pageHeight || page.dataset.sourceHeight || page.style.height.replace('px', '') || (sourceWidth * pageRect.height / Math.max(1, pageRect.width)));
    const scaleX = pageRect.width / Math.max(1, sourceWidth);
    const scaleY = pageRect.height / Math.max(1, sourceHeight);
    const nodes = [...page.querySelectorAll(':scope > .layout-flow-stream, :scope > .layout-block')];
    const items = nodes.map((node, ordinal) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const fontScale = Number(node.dataset.layoutFontScale || 1) || 1;
      const computedFont = parseFloat(style.fontSize) || 0;
      const glyphs = textRects(node);
      const sourceGlyphs = glyphs.map(glyph => ({
        left: round((glyph.left - pageRect.left) / scaleX),
        top: round((glyph.top - pageRect.top) / scaleY),
        right: round((glyph.right - pageRect.left) / scaleX),
        bottom: round((glyph.bottom - pageRect.top) / scaleY),
      }));
      return {
        // Python labels pages with a zero-based data-sync-page-index, while
        // the Zotero workbench uses a one-based data-page. DOM order is the
        // common production contract and is stable in both renderers.
        page: pageOffset + 1,
        ordinal,
        blockId: node.dataset.blockId || node.querySelector('[data-block-id]')?.dataset.blockId || '',
        classes: [...node.classList].filter(name => !['fit-limiter', 'fit-blocker', 'body-iteration-collision', 'layout-overflow'].includes(name)).sort(),
        flowKind: node.dataset.flowKind || '', styleKind: node.dataset.styleKind || '', blockKind: node.dataset.blockKind || '',
        originalLines: node.dataset.originalLines || '',
        text: String(node.textContent || '').replace(/\s+/g, ' ').trim(),
        frame: {
          left: round((rect.left - pageRect.left) / scaleX), top: round((rect.top - pageRect.top) / scaleY),
          right: round((rect.right - pageRect.left) / scaleX), bottom: round((rect.bottom - pageRect.top) / scaleY),
        },
        baseFontPx: round(parseFloat(node.dataset.baseFont || '0')),
        computedFontPx: round(computedFont), controlFontPx: round(computedFont / fontScale),
        inlineFont: node.style.fontSize || '', fontScale: round(fontScale),
        lineRatio: round(parseFloat(node.style.lineHeight || '') || (parseFloat(style.lineHeight) / Math.max(.001, computedFont))),
        clientWidth: round(node.clientWidth / fontScale), clientHeight: round(node.clientHeight / fontScale),
        scrollWidth: round(node.scrollWidth / fontScale), scrollHeight: round(node.scrollHeight / fontScale),
        overflowX: node.scrollWidth > node.clientWidth + 1, overflowY: node.scrollHeight > node.clientHeight + 1,
        glyphRects: sourceGlyphs,
        fitLabel: node.dataset.fitLabel || '', fitDebug: node.dataset.fitDebug || '',
        iterationLastRound: Number(node.dataset.bodyIterationLastRound || 0),
        collisionRound: Number(node.dataset.bodyIterationCollisionRound || 0),
        collisionPhase: node.dataset.bodyIterationCollisionPhase || '',
      };
    });
    const rawCollisions = [];
    const collisions = [];
    const opticalEdgeCollisions = [];
    for (let leftIndex = 0; leftIndex < items.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex++) {
        const left = items[leftIndex], right = items[rightIndex];
        if (!left.text || !right.text) continue;
        const glyphOverlaps = left.glyphRects.flatMap(a => right.glyphRects
          .filter(b => overlap(a, b, 1.5)).map(b => ({ a, b })));
        if (glyphOverlaps.length) {
          const record = { left: leftIndex, right: rightIndex, leftId: left.blockId, rightId: right.blockId };
          rawCollisions.push(record);
          const sharesHorizontalEdge = Math.abs(left.frame.bottom - right.frame.top) <= 1.5
            || Math.abs(right.frame.bottom - left.frame.top) <= 1.5;
          const shallowOpticalInk = sharesHorizontalEdge && glyphOverlaps.every(({ a, b }) =>
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 3);
          (shallowOpticalInk ? opticalEdgeCollisions : collisions).push(record);
        }
      }
    }
    return {
      page: pageOffset + 1, sourceWidth: round(sourceWidth), sourceHeight: round(sourceHeight),
      renderedWidth: round(pageRect.width), renderedHeight: round(pageRect.height), scaleX: round(scaleX), scaleY: round(scaleY),
      transform: page.style.transform || '', zoom: page.style.zoom || '', renderScaleMode: page.dataset.renderScaleMode || '',
      items, collisions, rawCollisions, opticalEdgeCollisions,
    };
  });
  return {
    url: location.href,
    title: document.title,
    readyState: document.body.dataset.layoutFitState || '',
    bodyClass: document.body.className,
    pageCount: pages.length,
    itemCount: pages.reduce((sum, page) => sum + page.items.length, 0),
    collisionCount: pages.reduce((sum, page) => sum + page.collisions.length, 0),
    rawCollisionCount: pages.reduce((sum, page) => sum + page.rawCollisions.length, 0),
    opticalEdgeCollisionCount: pages.reduce((sum, page) => sum + page.opticalEdgeCollisions.length, 0),
    controls: {
      readerFontInput: document.querySelector('#reader-font-input')?.value || '',
      userBodyFontPt: document.body.dataset.userBodyFontPt || '',
    },
    hiddenPublicationProbe: window.__parityHiddenPublicationProbe || null,
    pages,
  };
}`;

function extractMarkedJSON(output, marker) {
  const markerIndex = output.indexOf(marker);
  assert.ok(markerIndex >= 0, `Browser trace marker missing\n${output}`);
  const start = output.indexOf("{", markerIndex + marker.length);
  assert.ok(start >= 0, `Browser trace JSON missing\n${output}`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < output.length; index++) {
    const character = output[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return JSON.parse(output.slice(start, index + 1));
  }
  throw new Error(`Browser trace JSON was truncated\n${output.slice(markerIndex, markerIndex + 1000)}`);
}

async function captureEngine({ session, engine, url, navigation = "open", readyExpression, screenshot, pdf, noPDF = false }) {
  await runCLI(session, navigation, url);
  await runCLI(session, "resize", "1600", "1200");
  const traceURL = new URL("/trace.js", url).href;
  // playwright-cli's Windows argument parser is unreliable for multi-line
  // run-code callbacks, even though the same JavaScript is valid. Keep this
  // callback deliberately short and on one physical line.
  // Compare both engines at one source-page render scale. Their host shells
  // occupy different widths (standalone Python preview versus Zotero dual
  // pane), and letting that presentation width leak into the experiment would
  // compare font hinting at ~2.58x against ~0.95x instead of layout rules.
  const normalizeCode = engine === "python"
    ? `window.__layoutPerfCounters = {}; window.__mineruForcedPageMetrics = new Map([...document.querySelectorAll('.layout-page-wrap')].map((wrap, index) => [index, { renderedHeight: Number(wrap.dataset.pageHeight || 792) }])); window.__mineruRunLayoutFill?.();`
    : `localStorage.clear(); for (const wrap of document.querySelectorAll('.layout-page-wrap')) { const sourceWidth = Number(wrap.dataset.sourceWidth || 612); wrap.style.width = sourceWidth + 'px'; const layoutPage = wrap.querySelector('.layout-page'); for (const node of layoutPage?.querySelectorAll('.layout-flow-stream, .layout-block') || []) node.classList.add('layout-parity-source-scale'); layoutPage?._litmtransRefreshLayoutScale?.(false); layoutPage?.removeAttribute('data-layout-fit-key'); } return window.__mineruRunLayoutFill?.();`;
  const partialProbeCode = engine === "plugin"
    ? `const partialProbe = await page.evaluate(async () => { const selector = '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]'; const fonts = () => [...new Set([...document.querySelectorAll(selector)].map(node => Number.parseFloat(getComputedStyle(node).fontSize || '0').toFixed(2)))]; const target = [...document.querySelectorAll('#translation-layout .layout-page')].find(page => page.querySelector(selector)); const node = target?.querySelector(selector); const before = fonts(); if (!target || !node) return { before, after: before, uniform: before.length <= 1, pageCount: document.querySelectorAll('#translation-layout .layout-page').length }; node.classList.add('layout-partial-refit-probe'); target.removeAttribute('data-layout-fit-key'); await window.__mineruRunLayoutFill?.(); const after = fonts(); node.classList.remove('layout-partial-refit-probe'); target.removeAttribute('data-layout-fit-key'); await window.__mineruRunLayoutFill?.(); return { before, after, uniform: after.length <= 1, pageCount: document.querySelectorAll('#translation-layout .layout-page').length }; });`
    : `const partialProbe = null;`;
  const warmProbeCode = engine === "python"
    ? `const coldStyles = await page.evaluate(() => [...document.querySelectorAll('.layout-flow-stream, .layout-block')].map(node => ({ f: node.style.fontSize || '', l: node.style.lineHeight || '', o: node.dataset.originalLines || '' }))); await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => ${readyExpression}, null, { timeout: 120000 }); const warmProbe = await page.evaluate(cold => { const warm = [...document.querySelectorAll('.layout-flow-stream, .layout-block')].map(node => ({ f: node.style.fontSize || '', l: node.style.lineHeight || '', o: node.dataset.originalLines || '' })); return { cached: document.body.dataset.layoutFitCached === '1', ready: document.body.dataset.layoutFitState === 'ready', count: warm.length, identical: JSON.stringify(cold) === JSON.stringify(warm) }; }, coldStyles);`
    : `const warmProbe = null;`;
  const browserCode = `async (page) => { await page.waitForFunction(() => ${readyExpression}, null, { timeout: 120000 }); await page.evaluate(() => { ${normalizeCode} }); await page.waitForTimeout(1500); const layoutPerformance = await page.evaluate(() => window.__litmtransLayoutProfile?.() || { engine: 'python-desktop-copy', phases: window.__layoutPhaseTimes || {}, counters: window.__layoutPerfCounters || {} }); ${partialProbeCode} await page.addScriptTag({ url: ${JSON.stringify(traceURL)} }); const trace = await page.evaluate(() => window.__layoutParityTrace()); ${warmProbeCode} return { layoutParityTrace: trace, layoutPerformance, layoutPartialRefitProbe: partialProbe, layoutCacheWarmProbe: warmProbe }; }`;
  const output = await runCLI(session, "run-code", browserCode);
  const marker = '"layoutParityTrace":';
  const trace = extractMarkedJSON(output, marker);
  trace.performance = extractMarkedJSON(output, '"layoutPerformance":');
  if (engine === "plugin") {
    trace.partialRefitProbe = extractMarkedJSON(output, '"layoutPartialRefitProbe":');
    assert.equal(trace.partialRefitProbe.uniform, true,
      `Partial page invalidation produced mixed body fonts: ${JSON.stringify(trace.partialRefitProbe)}`);
  }
  if (engine === "python") {
    trace.cacheWarmProbe = extractMarkedJSON(output, '"layoutCacheWarmProbe":');
    assert.equal(trace.cacheWarmProbe.cached, true,
      `Python warm reload did not restore the completed cache: ${JSON.stringify(trace.cacheWarmProbe)}`);
    assert.equal(trace.cacheWarmProbe.identical, true,
      `Python warm cache changed fitted styles: ${JSON.stringify(trace.cacheWarmProbe)}`);
  }
  await runCLI(session, "run-code", "async (page) => { await page.evaluate(() => document.body.classList.remove('layout-debug')); await page.waitForTimeout(250); }");
  await runCLI(session, "screenshot", "--filename", screenshot, "--full-page");
  if (engine === "plugin") {
    // Browser `pdf` would otherwise print the Zotero host chrome and its
    // scroll viewport. Clone the already-fitted pages into a print-only root
    // so the artifact contains exactly the translated pages under test. Named
    // @page rules preserve mixed source sizes instead of forcing every paper
    // through a hard-coded US-Letter-like 612x792 frame.
    const printCode = `async (page) => { await page.evaluate(async () => { const printRoot = document.createElement('main'); printRoot.className = 'layout-parity-print-root'; const pageRules = []; [...document.querySelectorAll('#translation-layout .layout-page-wrap')].forEach((source, index) => { const wrap = source.cloneNode(true); for (const image of wrap.querySelectorAll('img[data-layout-image-src]')) { image.setAttribute('src', image.dataset.layoutImageSrc); image.classList.remove('layout-image-unloaded'); image.loading = 'eager'; } const width = Number(source.dataset.sourceWidth || source.dataset.pageWidth || 612); const height = Number(source.dataset.sourceHeight || source.dataset.pageHeight || 792); const pageName = 'layoutParityPage' + index; wrap.style.setProperty('--parity-page-width', width + 'px'); wrap.style.setProperty('--parity-page-height', height + 'px'); wrap.style.page = pageName; pageRules.push('@page ' + pageName + '{size:' + width + 'px ' + height + 'px;margin:0}'); printRoot.appendChild(wrap); }); document.body.replaceChildren(printRoot); const style = document.createElement('style'); style.textContent = pageRules.join('') + 'html,body{margin:0!important;padding:0!important;background:white!important}.layout-parity-print-root{width:auto!important}.layout-page-wrap{display:block!important;width:var(--parity-page-width)!important;height:var(--parity-page-height)!important;margin:0!important;content-visibility:visible!important;contain:none!important;break-after:page;page-break-after:always}.layout-page{width:var(--parity-page-width)!important;height:var(--parity-page-height)!important;zoom:1!important;transform:none!important;box-shadow:none!important}.layout-page-wrap:last-child{break-after:auto;page-break-after:auto}'; document.head.appendChild(style); await Promise.race([Promise.all([...document.images].map(image => image.decode ? image.decode().catch(() => {}) : Promise.resolve())), new Promise(resolve => setTimeout(resolve, 5000))]); }); await page.waitForTimeout(250); }`;
    await runCLI(session, "run-code", printCode);
  }
  if (noPDF) return trace;
  await runCLI(session, "pdf", "--filename", pdf);
  return trace;
}

function itemKind(item) {
  if (item.styleKind) return `stream:${item.styleKind}`;
  if (item.blockKind) return `block:${item.blockKind}`;
  const typed = item.classes.find(value => value.startsWith("type-"));
  return typed || item.classes.includes("layout-image") ? "image" : "unknown";
}

function frameDistance(left, right) {
  return Math.abs(left.left - right.left) + Math.abs(left.top - right.top)
    + Math.abs(left.right - right.right) + Math.abs(left.bottom - right.bottom);
}

function compareTraces(python, plugin) {
  const pythonItems = python.pages.flatMap(page => page.items);
  const pluginItems = plugin.pages.flatMap(page => page.items);
  const remaining = new Set(pluginItems.map((_, index) => index));
  const pairs = [];
  const unmatchedPython = [];
  for (const source of pythonItems) {
    let candidates = [...remaining].filter(index => pluginItems[index].page === source.page);
    if (source.blockId) {
      const exact = candidates.filter(index => pluginItems[index].blockId === source.blockId);
      if (exact.length) candidates = exact;
    }
    const ranked = candidates.map(index => {
      const target = pluginItems[index];
      const kindPenalty = itemKind(source) === itemKind(target) ? 0 : 120;
      const textPenalty = source.text === target.text ? 0 : (source.text && target.text && (source.text.includes(target.text) || target.text.includes(source.text)) ? 8 : 35);
      return { index, score: frameDistance(source.frame, target.frame) + kindPenalty + textPenalty };
    }).sort((a, b) => a.score - b.score);
    const best = ranked[0];
    if (!best || best.score > 180) {
      unmatchedPython.push(source);
      continue;
    }
    remaining.delete(best.index);
    const target = pluginItems[best.index];
    pairs.push({
      page: source.page, pythonOrdinal: source.ordinal, pluginOrdinal: target.ordinal,
      blockId: source.blockId || target.blockId, kind: `${itemKind(source)} -> ${itemKind(target)}`,
      matchScore: Math.round(best.score * 1000) / 1000,
      frameDelta: Math.round(frameDistance(source.frame, target.frame) * 1000) / 1000,
      fontDelta: Math.round((target.controlFontPx - source.controlFontPx) * 1000) / 1000,
      lineDelta: Math.round((target.lineRatio - source.lineRatio) * 1000) / 1000,
      python: source, plugin: target,
    });
  }
  const unmatchedPlugin = [...remaining].map(index => pluginItems[index]);
  const material = pairs.filter(pair => Math.abs(pair.fontDelta) > .26 || Math.abs(pair.lineDelta) > .031 || pair.frameDelta > 4);
  const largeFonts = pairs.filter(pair => Math.abs(pair.fontDelta) > 1);
  const textPairs = pairs.filter(pair => {
    const item = pair.plugin;
    const kind = String(item.blockKind || "").toLowerCase();
    return Boolean(item.text) && !item.classes.includes("layout-image")
      && !/^(?:image|image_body|chart|chart_body|table|table_body|interline_equation|equation|block_equation|inline_equation)$/.test(kind);
  });
  const textMaterial = textPairs.filter(pair =>
    Math.abs(pair.fontDelta) > .6 || Math.abs(pair.lineDelta) > .05 || pair.frameDelta > 2);
  const textLargeFonts = textPairs.filter(pair => Math.abs(pair.fontDelta) > 1);
  return {
    summary: {
      pythonPages: python.pageCount, pluginPages: plugin.pageCount,
      pythonItems: python.itemCount, pluginItems: plugin.itemCount,
      matched: pairs.length, unmatchedPython: unmatchedPython.length, unmatchedPlugin: unmatchedPlugin.length,
      materialDifferences: material.length, overOnePxFontDifferences: largeFonts.length,
      textPairs: textPairs.length, textMaterialDifferences: textMaterial.length,
      textOverOnePxFontDifferences: textLargeFonts.length,
      pythonCollisions: python.collisionCount, pluginCollisions: plugin.collisionCount,
      pythonRawCollisions: python.rawCollisionCount, pluginRawCollisions: plugin.rawCollisionCount,
      pythonOpticalEdgeCollisions: python.opticalEdgeCollisionCount,
      pluginOpticalEdgeCollisions: plugin.opticalEdgeCollisionCount,
    },
    largestFontDifferences: [...pairs].sort((a, b) => Math.abs(b.fontDelta) - Math.abs(a.fontDelta)).slice(0, 30),
    largestTextFontDifferences: [...textPairs].sort((a, b) => Math.abs(b.fontDelta) - Math.abs(a.fontDelta)).slice(0, 30),
    largestFrameDifferences: [...pairs].sort((a, b) => b.frameDelta - a.frameDelta).slice(0, 30),
    materialDifferences: material,
    textMaterialDifferences: textMaterial,
    unmatchedPython,
    unmatchedPlugin,
    pairs,
  };
}

function writeSummaryMarkdown(report, filename) {
  const summary = report.comparison.summary;
  const lines = [
    "# Layout parity report", "",
    `Generated: ${report.generatedAt}`, "",
    "| Metric | Python | Plugin |", "|---|---:|---:|",
    `| Pages | ${summary.pythonPages} | ${summary.pluginPages} |`,
    `| Layout nodes | ${summary.pythonItems} | ${summary.pluginItems} |`,
    `| Actionable glyph collisions | ${summary.pythonCollisions} | ${summary.pluginCollisions} |`,
    `| Raw Range-rect intersections | ${summary.pythonRawCollisions} | ${summary.pluginRawCollisions} |`,
    `| Allowed optical edge intersections | ${summary.pythonOpticalEdgeCollisions} | ${summary.pluginOpticalEdgeCollisions} |`,
    "",
    `Matched nodes: ${summary.matched}; unmatched Python: ${summary.unmatchedPython}; unmatched plugin: ${summary.unmatchedPlugin}.`,
    `Material style/frame differences: ${summary.materialDifferences}; font differences over 1 source px: ${summary.overOnePxFontDifferences}.`,
    `Text-only pairs: ${summary.textPairs}; material text differences: ${summary.textMaterialDifferences}; text font differences over 1 source px: ${summary.textOverOnePxFontDifferences}.`,
    "", "## Largest text font differences", "",
    "| Page | Block | Kind | Python px | Plugin px | Delta | Python line | Plugin line |",
    "|---:|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const pair of report.comparison.largestTextFontDifferences.slice(0, 20)) {
    lines.push(`| ${pair.page} | ${pair.blockId || `${pair.pythonOrdinal}/${pair.pluginOrdinal}`} | ${pair.kind} | ${pair.python.controlFontPx} | ${pair.plugin.controlFontPx} | ${pair.fontDelta} | ${pair.python.lineRatio} | ${pair.plugin.lineRatio} |`);
  }
  lines.push("", "Full per-block geometry, glyph rectangles, iteration metadata, and unmatched nodes are in `report.json`.", "");
  fs.writeFileSync(filename, lines.join("\n"), "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const requiredInputs = options.pluginOnly
    ? [options.pluginModel]
    : [
      path.join(options.fixture, "full.cleaned.md"),
      path.join(options.fixture, "mineru_result", "layout.json"),
      path.join(options.fixture, "mineru_result", "merged_model.json"),
      options.translationCache || path.join(options.fixture, "layout_translation_blocks.zh.json"),
    ];
  for (const required of requiredInputs) assert.ok(required && fs.existsSync(required), `Required parity input is missing: ${required}`);
  fs.mkdirSync(options.output, { recursive: true });
  fs.mkdirSync(options.artifactOutput, { recursive: true });
  const files = {
    pluginHTML: path.join(options.output, "plugin.html"),
    pythonHTML: path.join(options.output, "python.html"),
    traceJS: path.join(options.output, "trace.js"),
    profilePluginJS: path.join(options.output, "plugin-workbench.profile.js"),
  };
  fs.writeFileSync(files.traceJS, `window.__layoutParityTrace = ${browserTraceFunction};\n`, "utf8");
  if (!options.pluginOnly) {
    console.log("[1/5] Calling the original Python layout renderer...");
    await renderPython(options, files.pythonHTML);
  }
  console.log("[2/5] Building the Zotero plugin layout model from the identical source and translations...");
  const { model, translations, engineTrace } = await buildPluginModel(options);
  fs.writeFileSync(path.join(options.output, "plugin-model.json"), JSON.stringify(model, null, 2), "utf8");
  fs.writeFileSync(path.join(options.output, "plugin-engine.json"), JSON.stringify(engineTrace, null, 2), "utf8");
  if (options.profile) writeProfiledPluginEngine(files.profilePluginJS, options);
  writePluginHTML(files.pluginHTML, model, translations, options);
  const { server, origin } = await startServer(options, files);
  const session = `layout-parity-${process.pid}`;
  let pythonTrace;
  let pluginTrace;
  try {
    if (!options.pluginOnly) {
      console.log("[3/5] Running the Python HTML fitter in a real browser...");
      pythonTrace = await captureEngine({
        session, engine: "python", url: `${origin}/python.html`,
        readyExpression: "document.body.dataset.layoutFitState === 'ready' && !document.body.classList.contains('layout-fit-pending')",
        screenshot: path.join(options.output, "python.png"), pdf: path.join(options.artifactOutput, "python.pdf"),
        noPDF: options.noPDF,
      });
    }
    console.log("[4/5] Running the Zotero plugin fitter in the same browser and viewport...");
    pluginTrace = await captureEngine({
      session, engine: "plugin", url: `${origin}/plugin.html`, navigation: options.pluginOnly ? "open" : "goto",
      readyExpression: `${options.publishAfterInit ? "document.body.dataset.parityFinalPublished === '1' && " : ""}document.querySelector('#translation-layout .layout-page') && !document.querySelector('#translation-layout').classList.contains('layout-fit-pending')`,
      screenshot: path.join(options.output, "plugin.png"), pdf: path.join(options.artifactOutput, "plugin.pdf"),
      noPDF: options.noPDF,
    });
  }
  finally {
    if (!options.keepBrowser) await runCLI(session, "close").catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
  if (options.pluginOnly) {
    if (options.publishWhileHidden) {
      assert.equal(pluginTrace.hiddenPublicationProbe?.pending, true,
        `Hidden publication exposed its provisional layout: ${JSON.stringify(pluginTrace.hiddenPublicationProbe)}`);
      assert.equal(pluginTrace.hiddenPublicationProbe?.hidden, true,
        `Hidden-publication regression did not exercise a hidden pane: ${JSON.stringify(pluginTrace.hiddenPublicationProbe)}`);
    }
    fs.writeFileSync(path.join(options.output, "plugin-trace.json"), JSON.stringify(pluginTrace, null, 2), "utf8");
    console.log(JSON.stringify({
      pluginPages: pluginTrace.pageCount,
      pluginItems: pluginTrace.itemCount,
      hiddenPublicationProbe: pluginTrace.hiddenPublicationProbe,
      controls: pluginTrace.controls,
    }, null, 2));
    console.log(`Trace: ${path.join(options.output, "plugin-trace.json")}`);
    return;
  }
  console.log("[5/5] Comparing per-block styles, geometry, iteration state, and glyph collisions...");
  fs.writeFileSync(path.join(options.output, "python-trace.json"), JSON.stringify(pythonTrace, null, 2), "utf8");
  fs.writeFileSync(path.join(options.output, "plugin-trace.json"), JSON.stringify(pluginTrace, null, 2), "utf8");
  const comparison = compareTraces(pythonTrace, pluginTrace);
  const report = {
    generatedAt: new Date().toISOString(), fixture: options.fixture, pythonRoot: options.pythonRoot,
    artifactOutput: options.artifactOutput, comparison
  };
  fs.writeFileSync(path.join(options.output, "report.json"), JSON.stringify(report, null, 2), "utf8");
  writeSummaryMarkdown(report, path.join(options.output, "report.md"));
  console.log(JSON.stringify(comparison.summary, null, 2));
  console.log(`Report: ${path.join(options.output, "report.md")}`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
