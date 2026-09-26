"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const runtimeFiles = [
  "manifest.json", "src/bootstrap.js", "src/prefs.js", "src/controller.js", "src/pipeline.js",
  "src/workbench.xhtml", "src/workbench.js", "src/workbench.css",
  "src/preferences.xhtml", "src/preferences.js", "src/preferences.css",
  "src/settings-view-model.js",
  "src/ported-core.js", "src/utils.js", "src/storage.js", "src/secrets.js", "src/http.js",
  "src/markdown.js", "src/mindmap.js", "src/flowchart.js", "src/mineru.js", "src/llm.js", "src/edge-local-translation.js", "src/web-machine-translation.js", "src/translation.js", "src/layout.js",
  "src/chat.js", "src/icon-reader.js",
  "src/agent/contracts.js", "src/agent/capability-policy.js", "src/agent/task-manager.js",
  "src/agent/background-ai.js", "src/agent/external-approval.js",
  "src/agent/zotero-write-coordinator.js", "src/agent/mcp/http-request-reader.js",
  "src/agent/item-formatter.js", "src/agent/collection-formatter.js", "src/agent/annotation-formatter.js",
  "src/agent/library-service.js", "src/agent/artifact-service.js", "src/agent/research-service.js",
  "src/agent/corpus-index.js", "src/agent/export-service.js", "src/agent/facade.js",
  "src/agent/citation-service.js", "src/agent/import-service.js",
  "src/agent/literature/paper-card.js", "src/agent/literature/paper-card-index.js",
  "src/agent/literature/candidate-store.js", "src/agent/literature/provider-base.js",
  "src/agent/literature/openalex-provider.js", "src/agent/literature/semantic-scholar-provider.js",
  "src/agent/literature/crossref-provider.js", "src/agent/literature/arxiv-provider.js",
  "src/agent/literature/europepmc-provider.js", "src/agent/literature/ranking.js",
  "src/agent/literature/literature-graph.js", "src/agent/literature/discovery-service.js",
  "src/agent/acquisition/platform-descriptor.js", "src/agent/acquisition/runtime-adapters.js",
  "src/agent/acquisition/runtime-manifest.js", "src/agent/acquisition/managed-runtime.js",
  "src/agent/acquisition/pdf-validator.js", "src/agent/acquisition/existing-attachment-provider.js",
  "src/agent/acquisition/direct-oa-provider.js", "src/agent/acquisition/scansci-mcp-client.js",
  "src/agent/acquisition/scansci-institution.js", "src/agent/acquisition/scansci-provider.js",
  "src/agent/acquisition/acquisition-service.js", "src/agent/review-workspace.js",
  "src/agent/bootstrap-instruction.js",
  "src/agent/mcp/tools.js", "src/agent/mcp/protocol.js", "src/agent/mcp/client-config.js", "src/agent/mcp/server.js",
  "assets/icon.ico", "assets/icon-reader.svg",
  "assets/docs/token-guide.pdf",
  "assets/vendor/pako/pako_inflate.min.js", "assets/vendor/pako/LICENSE.txt", "assets/vendor/pdf-lib/pdf-lib.min.js",
  "assets/vendor/licenses/zotero-mcp-MIT.txt",
  "assets/vendor/licenses/npm/pako@2.1.0/LICENSE", "assets/vendor/licenses/npm/pako@2.1.0/LICENSE-ZLIB.txt",
  "assets/vendor/licenses/KaTeX-Fonts-OFL-1.1.txt",
  "assets/vendor/pdf-lib/LICENSE.md", "assets/vendor/katex/LICENSE.txt", "assets/vendor/mermaid/mermaid.min.js", "assets/vendor/mermaid/LICENSE",
  "docs/licensing/third-party-inventory.md", "docs/licensing/acquisition-runtime.md", "docs/licensing/caj-backend.md",
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

function auditNpmLicenses() {
  const npmLicenseRoot = path.join(root, "assets/vendor/licenses/npm");
  const packageRecords = Object.entries(packageLock.packages || {})
    .filter(([key, info]) => key.startsWith("node_modules/") && info.dev !== true);
  const packageDirs = new Set();
  const missingFiles = [];
  const legalName = /^(?:LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT)(?:[.-].*)?$/i;

  for (const [key] of packageRecords) {
    const packageRoot = path.join(root, key);
    const packageJSONPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packageJSONPath)) fail(`Production package is not installed for license audit: ${key}`);
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(packageJSONPath, "utf8")); }
    catch (error) { fail(`Invalid package metadata for license audit (${key}): ${error.message}`); }
    if (!metadata.name || !metadata.version) fail(`Production package has no name/version for license audit: ${key}`);

    const assetDirName = `${key.slice("node_modules/".length).replaceAll("/", "__")}@${metadata.version}`;
    packageDirs.add(assetDirName);
    const assetDir = path.join(npmLicenseRoot, assetDirName);
    if (!fs.existsSync(assetDir)) fail(`Missing npm license directory: ${assetDirName}`);

    const sourceLegalFiles = [];
    function visit(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (["node_modules", ".git"].includes(entry.name)) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (entry.isFile() && legalName.test(entry.name)) sourceLegalFiles.push(entry.name);
      }
    }
    visit(packageRoot);
    const retainedNames = new Set(fs.readdirSync(assetDir, { withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => entry.name));
    for (const name of new Set(sourceLegalFiles)) {
      if (!retainedNames.has(name)) missingFiles.push(`${assetDirName}/${name}`);
    }
  }

  const retainedDirs = fs.readdirSync(npmLicenseRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const orphanDirs = retainedDirs.filter(name => !packageDirs.has(name));
  if (orphanDirs.length) fail(`Unmatched npm license directories: ${orphanDirs.join(", ")}`);
  if (missingFiles.length) fail(`Production npm license files not retained: ${missingFiles.join(", ")}`);
  const retainedFiles = walk(npmLicenseRoot).length;
  console.log(`npm license audit passed: ${packageRecords.length} production records, ${retainedDirs.length} package directories, ${retainedFiles} files.`);
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
auditNpmLicenses();
if (manifest.manifest_version !== 2) fail("manifest_version must be 2");
if (!manifest.applications?.zotero?.id) fail("applications.zotero.id is required");
if (manifest.name !== "LitMTrans") fail("manifest name must be LitMTrans");
if (manifest.description !== "全文对照翻译、AI对话、思维导图、智能体MCP、Markdown转换、公式Latex提取") fail("manifest description is not the approved public copy");
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
if (!preferencesScript.includes('root.addEventListener("showing", () => {')
    || !preferencesScript.includes('this.flushAutoSave(true).then(() => this.load())')) {
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
  /export[-_ ]?(?:docx|word|html)|download[-_ ]?(?:docx|html)/i,
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
  // 根目录这些本地配置已由 .gitignore 和构建脚本排除。
  // 子目录中的同名文件仍然禁止进入源树，避免遗漏敏感文件。
  if (rel === ".env" || rel === ".env.local" || /^\.env\..+\.local$/i.test(rel)) return false;
  const forbiddenArchive = /\.(?:pdf|xpi|zip)$/i.test(rel) && rel !== "assets/docs/token-guide.pdf";
  return /(^|\/)\.env(?:\.|$)/i.test(rel) || forbiddenArchive || /(^|\/)(?:cookies?|tokens?|profile)(?:\/|$)/i.test(rel);
});
if (forbiddenFiles.length) fail(`Forbidden file type/path in source tree: ${forbiddenFiles.map(file => path.relative(root, file)).join(", ")}`);
for (const internalFile of ["AGENTS.md", "CLAUDE.md", "zotero_ai_three_views_codex_execution_spec_v4.md"]) {
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", internalFile], { cwd: root, stdio: "ignore" });
  if (tracked.status === 0) fail(`Internal development instructions must not be published: ${internalFile}`);
}
for (const file of allProjectFiles.filter(f => f.startsWith(path.join(root, "scripts")) && f.endsWith(".ps1"))) {
  const buf = fs.readFileSync(file);
  if (buf.length < 3 || buf[0] !== 0xef || buf[1] !== 0xbb || buf[2] !== 0xbf) {
    fail(`PowerShell script must have UTF-8 BOM for Windows PowerShell compatibility: ${path.relative(root, file)}`);
  }
}
const publishablePaths = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);
const auditText = publishablePaths
  .map(file => path.join(root, file))
  .filter(file => fs.existsSync(file) && fs.statSync(file).isFile())
  .filter(file => /\.(?:js|ts|json|md|xhtml|css|mjs|ps1|sh|txt|csv)$/.test(file))
  .filter(file => path.basename(file) !== "AGENTS.md")
  .filter(file => path.basename(file) !== "mcp计划.md")
  .filter(file => path.resolve(file) !== path.resolve(__filename))
  .map(file => fs.readFileSync(file, "utf8"))
  .join("\n");
for (const pattern of [
  /C:\\Users\\\d{3,}\\/i,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
  /(?:sk|AIza|ghp|xox[baprs])-[_A-Za-z0-9]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/
]) {
  if (pattern.test(auditText)) fail(`Potential personal path or embedded secret found: ${pattern}`);
}
const trackedPaths = run("git", ["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
const trackedSensitivePaths = trackedPaths.filter(file => {
  const normalized = file.replace(/\\/g, "/");
  const sampleEnv = /^\.env\.(?:example|template)$/i.test(normalized);
  return (!sampleEnv && /(^|\/)\.env(?:\.|$)/i.test(normalized))
    || /\.(?:p12|pfx|key|pem)$/i.test(normalized)
    || /(^|\/)(?:id_rsa|id_ed25519)$/i.test(normalized)
    || /(^|\/)(?:\.zotero-dev|profile|runtime\/acquisition)(?:\/|$)/i.test(normalized)
    || /^\/(?:cookies|sessions|session-storage|cookies\.json|session\.json|runtime-state\.json)(?:\/|$)/i.test(`/${normalized}`);
});
if (trackedSensitivePaths.length) fail(`Sensitive local file paths are tracked: ${trackedSensitivePaths.join(", ")}`);
for (const document of ["THIRD_PARTY_NOTICES.md", "docs/licensing/third-party-inventory.md"]) {
  const text = fs.readFileSync(path.join(root, document), "utf8");
  const localPaths = [...text.matchAll(/`((?:assets|native|docs)\/[A-Za-z0-9_./@+-]+)`/g)].map(match => match[1]);
  const missingPaths = [...new Set(localPaths)].filter(rel => !fs.existsSync(path.join(root, rel)));
  if (missingPaths.length) fail(`${document} references missing local files: ${missingPaths.join(", ")}`);
}

console.log("[8/8] Generated-core and package metadata consistency");
const compiled = fs.readFileSync(path.join(root, "src/ported-core.js"), "utf8");
if (!compiled.includes("root.PortedCore = LitMTransPort") || !compiled.includes("buildGeminiInteractionRequest") || !compiled.includes("readingModeContract")) {
  fail("compiled ported core is incomplete");
}
if (/isMachineTranslationProviderId/.test(compiled)) fail("removed machine-translation predicate remains in compiled core");
if (!packageLock.packages?.["node_modules/typescript"]) fail("package-lock does not pin TypeScript");
console.log("Validation passed.");
