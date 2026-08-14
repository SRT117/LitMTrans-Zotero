"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const runtimeFiles = [
  "manifest.json", "src/bootstrap.js", "src/prefs.js", "src/controller.js", "src/pipeline.js",
  "src/workbench.xhtml", "src/workbench.js", "src/workbench.css",
  "src/preferences.xhtml", "src/preferences.js", "src/preferences.css",
  "src/ported-core.js", "src/utils.js", "src/storage.js", "src/secrets.js", "src/http.js",
  "src/markdown.js", "src/mindmap.js", "src/flowchart.js", "src/mineru.js", "src/llm.js", "src/edge-local-translation.js", "src/web-machine-translation.js", "src/translation.js", "src/layout.js",
  "src/chat.js", "src/icon-reader.js", "assets/icon.ico", "assets/icon-reader.svg",
  "assets/docs/token-guide.pdf",
  "assets/vendor/pako/pako_inflate.min.js", "assets/vendor/pdf-lib/pdf-lib.min.js",
  "assets/vendor/pdf-lib/LICENSE.md", "assets/vendor/katex/LICENSE.txt", "assets/vendor/mermaid/mermaid.min.js", "assets/vendor/mermaid/LICENSE",
  "locale/en-US/litmtrans.ftl", "locale/zh-CN/litmtrans.ftl",
  "THIRD_PARTY_NOTICES.md"
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe", ...options });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr || result.stdout || `${command} ${args.join(" ")} failed`);
  return result;
}

function walk(directory, options = {}) {
  const result = [];
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["dist", "node_modules", ".git", ".zotero-dev", ".npm-cache", ".scaffold", ".validation-logs", "output", "tmp"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(full, options));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

console.log("[1/8] TypeScript compilation");
const localTscCli = path.join(root, "node_modules", "typescript", "bin", "tsc");
// Calling a .cmd shim directly through spawnSync fails with EINVAL on recent
// Node.js/Windows combinations. Invoke TypeScript's JavaScript CLI with the
// current Node executable so validation has the same behavior on every OS.
if (fs.existsSync(localTscCli)) run(process.execPath, [localTscCli, "-p", "tsconfig.core.json"]);
else run("tsc", ["-p", "tsconfig.core.json"]);

console.log("[2/8] JavaScript syntax");
for (const file of walk(root).filter(file => file.endsWith(".js"))) {
  run(process.execPath, ["--check", file]);
}

console.log("[3/8] Manifest, package and XHTML");
let manifest;
let packageJSON;
let packageLock;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  packageJSON = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
}
catch (error) { fail(`Invalid JSON metadata: ${error.message}`); }
if (manifest.manifest_version !== 2) fail("manifest_version must be 2");
if (!manifest.applications?.zotero?.id) fail("applications.zotero.id is required");
if (manifest.name !== "LitMTrans") fail("manifest name must be LitMTrans");
if (manifest.description !== "文献解析、全文翻译、思维导图与文献对话") fail("manifest description is not the approved public copy");
if (manifest.author !== "SRT117") fail("manifest author must be SRT117");
if (manifest.applications.zotero.id !== "litmtrans@srt117.github.io") fail("public add-on ID changed");
const releaseUpdateURL = process.env.LITMTRANS_RELEASE_UPDATE_URL || "";
const manifestUpdateURL = manifest.applications.zotero.update_url || "";
const githubUpdateURL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/update\.json$/;
if (!githubUpdateURL.test(manifestUpdateURL)) {
  fail("manifest update_url must point to GitHub Releases latest/download/update.json");
}
if (releaseUpdateURL && manifestUpdateURL !== releaseUpdateURL) {
  fail("release workflow did not inject the expected manifest update_url");
}
if (manifest.applications.zotero.strict_min_version !== "7.0" || manifest.applications.zotero.strict_max_version !== "*") {
  fail("public compatibility must allow Zotero 7 and later");
}
if (manifest.version !== packageJSON.version || manifest.version !== packageLock.version || manifest.version !== packageLock.packages?.[""]?.version) {
  fail("manifest/package/package-lock versions differ");
}
if (!packageJSON.devDependencies?.typescript) fail("TypeScript must be a declared development dependency");
const python = process.platform === "win32" ? "python" : "python3";
run(python, ["-c", [
  "import xml.etree.ElementTree as ET",
  "for p in ('src/workbench.xhtml','src/preferences.xhtml'): ET.parse(p)"
].join("\n")]);
const preferencesXHTML = fs.readFileSync(path.join(root, "src/preferences.xhtml"), "utf8");
const preferencesScript = fs.readFileSync(path.join(root, "src/preferences.js"), "utf8");
if (!preferencesXHTML.includes('id="litmtrans-preferences-root"')) {
  fail("preferences.xhtml must retain a stable pane root ID");
}
if (!preferencesScript.includes('event.target?.id !== "litmtrans-preferences-root"')
    || !preferencesScript.includes('document.addEventListener("load", initializeLitMTransPreferences, true)')) {
  fail("preferences.js must capture Zotero's dynamically inserted pane root load event");
}
if (!preferencesScript.includes('root.addEventListener("showing", () => void this.load())')) {
  fail("preferences.js must reload the canonical settings snapshot whenever the pane is shown");
}
if (/DOMContentLoaded|pageshow|window\.addEventListener\(["']load|onload=/.test(preferencesScript)) {
  fail("preferences.js must not initialize from preference-window lifecycle events");
}

console.log("[4/8] Runtime unit and fixture tests");
run(process.execPath, ["tests/run-tests.js"], { inherit: true });

console.log("[5/8] Runtime files, resources and bootstrap order");
const missing = runtimeFiles.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) fail(`Missing required files: ${missing.join(", ")}`);
const bootstrap = fs.readFileSync(path.join(root, "src/bootstrap.js"), "utf8");
const corePosition = bootstrap.indexOf('"src/ported-core.js"');
const utilsPosition = bootstrap.indexOf('"src/utils.js"');
if (corePosition < 0 || utilsPosition < 0 || corePosition > utilsPosition) fail("ported-core.js must load before utils.js");
const workbenchXHTML = fs.readFileSync(path.join(root, "src/workbench.xhtml"), "utf8");
if (!workbenchXHTML.includes("ported-core.js")) fail("workbench.xhtml must load ported-core.js before UI scripts");
const visibleCopy = [
  workbenchXHTML,
  preferencesXHTML,
  fs.readFileSync(path.join(root, "locale/zh-CN/litmtrans.ftl"), "utf8")
].join("\n");
if (/(?:Python工作台|通知显示|供应商卡片|插件桥接|文档工具适配器)/.test(visibleCopy)) {
  fail("Developer-facing terminology remains in visible product copy");
}
const chineseSpacingTerms = "LitMTrans|Zotero|PDF|API|AI|MinerU|Gemini|SiliconFlow|Markdown|TeX|Reader|Office|Prompt";
if (new RegExp(`[\\u3400-\\u9fff]\\s+(?:${chineseSpacingTerms})|(?:${chineseSpacingTerms})\\s+[\\u3400-\\u9fff]`).test(visibleCopy)) {
  fail("Chinese product copy contains spaces around an English product term");
}
const sourceComments = walk(path.join(root, "packages"))
  .concat(walk(path.join(root, "apps")))
  .filter(file => file.endsWith(".ts"))
  .map(file => fs.readFileSync(file, "utf8"))
  .join("\n");
if (/Ported from:|Ported capability group:|Migration status:|behavior-preserving static port/i.test(sourceComments)) {
  fail("Development-process provenance templates remain in TypeScript comments");
}

console.log("[6/8] Runtime contract assertions");
const runtimeText = walk(path.join(root, "src"))
  .filter(file => /\.(?:js|xhtml|css)$/.test(file))
  .map(file => fs.readFileSync(file, "utf8"))
  .join("\n");
for (const pattern of [
  /mtranserver|youdao_direct|sogou_free|export_fidelity\.lua|python-docx|pandoc/i,
  /export[-_ ]?(?:docx|word|html|markdown)|download[-_ ]?(?:docx|html|markdown)/i,
  /layoutShowParsedSource|show-parsed-source|layout-parsed-source-toggle/i,
  /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/i
]) {
  if (pattern.test(runtimeText)) fail(`Forbidden runtime reference found: ${pattern}`);
}
if (!runtimeText.includes("parsed-markdown") || !runtimeText.includes("zotero-reader")) {
  fail("stream/layout source contracts are missing");
}

console.log("[7/8] Security and source-package hygiene");
const allProjectFiles = walk(root);
const forbiddenFiles = allProjectFiles.filter(file => {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const forbiddenArchive = /\.(?:pdf|xpi|zip)$/i.test(rel) && rel !== "assets/docs/token-guide.pdf";
  return /(^|\/)\.env(?:\.|$)/i.test(rel) || forbiddenArchive || /(^|\/)(?:cookies?|tokens?|profile)(?:\/|$)/i.test(rel);
});
if (forbiddenFiles.length) fail(`Forbidden file type/path in source tree: ${forbiddenFiles.map(file => path.relative(root, file)).join(", ")}`);
for (const internalFile of ["AGENTS.md", "CLAUDE.md", "zotero_ai_three_views_codex_execution_spec_v4.md"]) {
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", internalFile], { cwd: root, stdio: "ignore" });
  if (tracked.status === 0) fail(`Internal development instructions must not be published: ${internalFile}`);
}
const auditText = allProjectFiles
  .filter(file => /\.(?:js|ts|json|md|xhtml|css|mjs|ps1|sh|txt|csv)$/.test(file))
  .filter(file => path.basename(file) !== "AGENTS.md")
  .map(file => fs.readFileSync(file, "utf8"))
  .join("\n");
for (const pattern of [
  /C:\\Users\\\d{3,}\\/i,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
  /(?:sk|AIza|ghp|xox[baprs])-[_A-Za-z0-9]{20,}/
]) {
  if (pattern.test(auditText)) fail(`Potential personal path or embedded secret found: ${pattern}`);
}

console.log("[8/8] Generated-core and package metadata consistency");
const compiled = fs.readFileSync(path.join(root, "src/ported-core.js"), "utf8");
if (!compiled.includes("root.PortedCore = LitMTransPort") || !compiled.includes("buildGeminiInteractionRequest") || !compiled.includes("readingModeContract")) {
  fail("compiled ported core is incomplete");
}
if (/isMachineTranslationProviderId/.test(compiled)) fail("removed machine-translation predicate remains in compiled core");
if (!packageLock.packages?.["node_modules/typescript"]) fail("package-lock does not pin TypeScript");
console.log("Validation passed.");
