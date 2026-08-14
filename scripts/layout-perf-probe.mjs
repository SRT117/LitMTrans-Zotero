#!/usr/bin/env node
// Standalone cold/warm timing probe for the Python (legacy) layout engine.
// Reuses the parity harness's Python render bridge + local HTTP origin +
// playwright-cli driver, but measures WHERE cold-start time goes instead of
// comparing geometry. Answers the load-bearing question before any new engine
// is designed: is the solver the bottleneck, or fonts+MathJax?

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const desktop = path.join(process.env.USERPROFILE || path.dirname(path.dirname(root)), "Desktop");
const DEFAULT_PYTHON_ROOT = path.join(desktop, "Literature analysis and reading workbench");

function parseArgs(argv) {
  const options = {
    fixture: path.join(desktop, "临时解析文件", "Shock-Hugoniot-compression-curve-for-water"),
    translationCache: "",
    pythonRoot: DEFAULT_PYTHON_ROOT,
    output: path.join(root, "output", "layout-perf"),
    warmRuns: 3,
    skipRender: false,
    instrument: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--fixture") options.fixture = argv[++i];
    else if (v === "--translation-cache") options.translationCache = argv[++i];
    else if (v === "--python-root") options.pythonRoot = argv[++i];
    else if (v === "--output") options.output = argv[++i];
    else if (v === "--warm-runs") options.warmRuns = Number(argv[++i]);
    else if (v === "--skip-render") options.skipRender = true;
    else if (v === "--no-instrument") options.instrument = false;
    else throw new Error(`Unknown argument: ${v}`);
  }
  options.fixture = path.resolve(options.fixture);
  if (options.translationCache) options.translationCache = path.resolve(options.translationCache);
  options.pythonRoot = path.resolve(options.pythonRoot);
  options.output = path.resolve(options.output);
  return options;
}

async function renderPython(options, outputPath) {
  if (options.skipRender && fs.existsSync(outputPath)) return;
  const python = path.join(options.pythonRoot, ".venv", "Scripts", "python.exe");
  assert.ok(fs.existsSync(python), `Python venv not found: ${python}`);
  const result = await execFileAsync(python, [
    path.join(root, "scripts", "layout-parity-python.py"),
    "--python-root", options.pythonRoot,
    "--fixture", options.fixture,
    "--output", outputPath,
    ...(options.translationCache ? ["--translation-cache", options.translationCache] : []),
  ], { cwd: options.pythonRoot, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  const fixtureURL = pathToFileURL(options.fixture + path.sep).href;
  const html = fs.readFileSync(outputPath, "utf8");
  fs.writeFileSync(outputPath, html
    .replaceAll(fixtureURL, "/fixture/")
    .replace(/file:\/\/\/[^"'()]*SourceHanSerifCN-Regular\.ttf/gi, "/repo/assets/fonts/SourceHanSerifCN-Regular.ttf"), "utf8");
}

function mimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  })[ext] || "application/octet-stream";
}

function safeResolved(base, relative) {
  const resolved = path.resolve(base, relative);
  const prefix = path.resolve(base) + path.sep;
  return resolved === path.resolve(base) || resolved.startsWith(prefix) ? resolved : null;
}

async function startServer(options, pythonHTML) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    let filename = null;
    if (pathname === "/python.html") filename = pythonHTML;
    else if (pathname.startsWith("/repo/")) filename = safeResolved(root, pathname.slice("/repo/".length));
    else if (pathname.startsWith("/fixture/")) filename = safeResolved(options.fixture, pathname.slice("/fixture/".length));
    if (!filename || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeType(filename), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(filename).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runCLI(session, ...args) {
  const npxCLI = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  const { stdout, stderr } = await execFileAsync(process.execPath, [npxCLI,
    "--yes", "--package", "@playwright/cli", "playwright-cli", `-s=${session}`, ...args,
  ], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (stderr && !/Assertion failed/.test(stderr)) process.stderr.write(stderr);
  return stdout;
}

function extractMarkedJSON(output, marker) {
  const markerIndex = output.indexOf(marker);
  assert.ok(markerIndex >= 0, `Marker missing: ${marker}\n${output.slice(0, 2000)}`);
  const start = output.indexOf("{", markerIndex + marker.length);
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < output.length; i++) {
    const c = output[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(output.slice(start, i + 1));
  }
  throw new Error(`Truncated JSON for ${marker}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.output, { recursive: true });
  const pythonHTML = path.join(options.output, "python.html");
  console.log(`[render] ${options.fixture}`);
  await renderPython(options, pythonHTML);
  const { server, origin } = await startServer(options, pythonHTML);
  const session = `layout-perf-${process.pid}`;
  try {
    await runCLI(session, "open", `${origin}/python.html`);
    await runCLI(session, "resize", "1600", "1200");
    // Force a TRUE cold solve: clear the persisted fit cache so restoreFitCache()
    // misses on reload and the full fonts+MathJax+solve chain runs. Then measure
    // wall time from reload to layoutFitState=ready, and warm solver re-runs to
    // isolate pure solver cost (fonts+math already resident).
    // playwright-cli's Windows arg parser mangles multi-line run-code callbacks,
    // so this callback stays on one physical line (see layout-parity-test.mjs).
    const coldEval = `() => { const nav = performance.getEntriesByType('navigation')[0] || {}; const paints = performance.getEntriesByType('paint') || []; const fcp = paints.find(p => p.name === 'first-contentful-paint'); return { pages: document.querySelectorAll('.layout-page-wrap').length, flowStreams: document.querySelectorAll('.layout-flow-stream').length, bodyStreams: document.querySelectorAll('.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]').length, allText: document.querySelectorAll('.layout-flow-stream[data-flow-kind="text"], .layout-flow-stream[data-flow-kind="ref_text"]').length, cachedOnCold: document.body.dataset.layoutFitCached === '1', navToLoadEndMs: Math.round(nav.loadEventEnd || 0), domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0), firstContentfulPaintMs: Math.round(fcp ? fcp.startTime : 0) }; }`;
    const warmEval = `async (arg) => { const runs = arg.runs; window.__layoutPerfEnabled = arg.instrument; const times = []; const phases = []; const counters = []; for (let i = 0; i < runs; i++) { window.__layoutPerfCounters = {}; const s = performance.now(); window.__mineruRunLayoutFill && window.__mineruRunLayoutFill(); const e = performance.now(); times.push(e - s); phases.push(Object.assign({}, window.__layoutPhaseTimes || {})); counters.push(Object.assign({}, window.__layoutPerfCounters || {})); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); } return { times, phases, counters }; }`;
    // Paired A/B in ONE page: interleave gallop-on and gallop-off solves so
    // machine-load drift (observed ~2x between processes) hits both equally.
    // Requires a build whose gate honours window.__gallopDisabled.
    const abEval = `async (arg) => { window.__layoutPerfEnabled = false; const on = []; const off = []; for (let i = 0; i < arg.runs; i++) { window.__gallopDisabled = true; let s = performance.now(); window.__mineruRunLayoutFill && window.__mineruRunLayoutFill(); off.push(performance.now() - s); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); window.__gallopDisabled = false; s = performance.now(); window.__mineruRunLayoutFill && window.__mineruRunLayoutFill(); on.push(performance.now() - s); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); } const med = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; return { gallopOffMs: off.map(Math.round), gallopOnMs: on.map(Math.round), gallopOffMedian: Math.round(med(off)), gallopOnMedian: Math.round(med(on)) }; }`;
    const snapEval = `() => [...document.querySelectorAll('.layout-flow-stream, .layout-block')].map(n => n.style.fontSize + '|' + n.style.lineHeight)`;
    const auditEval = `() => (window.__mineruAuditLayoutOnly ? window.__mineruAuditLayoutOnly() : { valid: null })`;
    const code = `async (page) => { await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} }); const coldStart = Date.now(); await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => document.body && document.body.dataset.layoutFitState === 'ready', null, { timeout: 240000 }); const coldWallMs = Date.now() - coldStart; const cold = await page.evaluate(${coldEval}); const warm = await page.evaluate(${warmEval}, { runs: ${options.warmRuns}, instrument: ${options.instrument} }); const ab = await page.evaluate(${abEval}, { runs: ${options.warmRuns} }); const snapshot = await page.evaluate(${snapEval}); const audit = await page.evaluate(${auditEval}); return { PERF_COLD: Object.assign({}, cold, { coldWallMs }), PERF_WARM: warm, PERF_AB: ab, PERF_SNAPSHOT: { styles: snapshot }, PERF_AUDIT: audit }; }`;
    const output = await runCLI(session, "run-code", code);
    const cold = extractMarkedJSON(output, '"PERF_COLD":');
    const warmObj = extractMarkedJSON(output, '"PERF_WARM":');
    const warm = warmObj.times || [];
    const phases = warmObj.phases || [];
    const sorted = [...warm].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    // Median each phase across warm runs.
    const phaseKeys = [...new Set(phases.flatMap(p => Object.keys(p)))];
    const phaseMedian = {};
    for (const key of phaseKeys) {
      const vals = phases.map(p => p[key] || 0).sort((a, b) => a - b);
      phaseMedian[key] = Math.round(vals[Math.floor(vals.length / 2)] || 0);
    }
    const counters = warmObj.counters || [];
    const lastCounters = counters[counters.length - 1] || {};
    // Final-style snapshot: every node's fontSize/lineHeight in DOM order, so a
    // baseline-vs-optimized run can be diffed for byte-level layout parity.
    const snapObj = extractMarkedJSON(output, '"PERF_SNAPSHOT":');
    fs.writeFileSync(path.join(options.output, "style-snapshot.json"), JSON.stringify(snapObj.styles || []), "utf8");
    const audit = extractMarkedJSON(output, '"PERF_AUDIT":');
    const ab = extractMarkedJSON(output, '"PERF_AB":');
    const report = {
      fixture: options.fixture,
      ...cold,
      warmSolverRunsMs: warm.map(x => Math.round(x)),
      warmSolverMedianMs: Math.round(median),
      phaseBreakdownMs: phaseMedian,
      counters: lastCounters,
      audit,
      ab,
      abSpeedup: ab && ab.gallopOnMedian ? Number((ab.gallopOffMedian / ab.gallopOnMedian).toFixed(2)) : null,
    };
    console.log("PERF_REPORT " + JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(options.output, "perf-report.json"), JSON.stringify(report, null, 2), "utf8");
  } finally {
    await runCLI(session, "close").catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => { console.error(err?.stack || err); process.exitCode = 1; });
