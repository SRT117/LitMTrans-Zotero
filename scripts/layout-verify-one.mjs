#!/usr/bin/env node
// Single-fixture layout-parity verifier (invoked by layout-verify-all.mjs).
// Renders the current engine HTML, then in ONE browser page:
//   1. force gallop OFF, run fill, snapshot styles + audit  -> baseline
//   2. force gallop ON,  run fill, snapshot styles + audit  -> optimized
// and reports the per-node style diff + whether the read-only audit verdict
// matches. Layout parity is load-independent, so many of these run in parallel.

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
const desktop = path.join(process.env.USERPROFILE || "", "Desktop");
const PYTHON_ROOT = path.join(desktop, "Literature analysis and reading workbench");

function parseArgs(argv) {
  const o = { fixture: "", translationCache: "", tag: "fx", output: "" };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--fixture") o.fixture = path.resolve(argv[++i]);
    else if (v === "--translation-cache") o.translationCache = path.resolve(argv[++i]);
    else if (v === "--tag") o.tag = argv[++i];
    else if (v === "--output") o.output = path.resolve(argv[++i]);
  }
  return o;
}

async function renderPython(opts, outputPath) {
  const python = path.join(PYTHON_ROOT, ".venv", "Scripts", "python.exe");
  assert.ok(fs.existsSync(python), `venv missing: ${python}`);
  await execFileAsync(python, [
    path.join(root, "scripts", "layout-parity-python.py"),
    "--python-root", PYTHON_ROOT,
    "--fixture", opts.fixture,
    "--output", outputPath,
    ...(opts.translationCache ? ["--translation-cache", opts.translationCache] : []),
  ], { cwd: PYTHON_ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const fixtureURL = pathToFileURL(opts.fixture + path.sep).href;
  const html = fs.readFileSync(outputPath, "utf8");
  fs.writeFileSync(outputPath, html
    .replaceAll(fixtureURL, "/fixture/")
    .replace(/file:\/\/\/[^"'()]*SourceHanSerifCN-Regular\.ttf/gi, "/repo/assets/fonts/SourceHanSerifCN-Regular.ttf"), "utf8");
}

function mimeType(f) {
  const e = path.extname(f).toLowerCase();
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" })[e] || "application/octet-stream";
}
function safeResolved(base, rel) {
  const r = path.resolve(base, rel); const p = path.resolve(base) + path.sep;
  return r === path.resolve(base) || r.startsWith(p) ? r : null;
}
async function startServer(opts, pythonHTML) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    let f = null;
    if (pathname === "/python.html") f = pythonHTML;
    else if (pathname.startsWith("/repo/")) f = safeResolved(root, pathname.slice(6));
    else if (pathname.startsWith("/fixture/")) f = safeResolved(opts.fixture, pathname.slice(9));
    if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "Content-Type": mimeType(f), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function runCLI(session, ...args) {
  const npxCLI = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  const { stdout } = await execFileAsync(process.execPath, [npxCLI, "--yes", "--package", "@playwright/cli", "playwright-cli", `-s=${session}`, ...args],
    { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout;
}
function extractMarkedJSON(output, marker) {
  const mi = output.indexOf(marker); assert.ok(mi >= 0, `marker ${marker} missing`);
  const start = output.indexOf("{", mi + marker.length);
  let depth = 0, q = false, esc = false;
  for (let i = start; i < output.length; i++) {
    const c = output[i];
    if (q) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') q = false; continue; }
    if (c === '"') q = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return JSON.parse(output.slice(start, i + 1));
  }
  throw new Error("truncated");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.output, { recursive: true });
  const pythonHTML = path.join(opts.output, "python.html");
  await renderPython(opts, pythonHTML);
  const { server, origin } = await startServer(opts, pythonHTML);
  const session = `layout-verify-${opts.tag}-${process.pid}`;
  try {
    await runCLI(session, "open", `${origin}/python.html`);
    await runCLI(session, "resize", "1600", "1200");
    const snapEval = `() => [...document.querySelectorAll('.layout-flow-stream, .layout-block')].map(n => n.style.fontSize + '|' + n.style.lineHeight)`;
    const auditEval = `() => (window.__mineruAuditLayoutOnly ? window.__mineruAuditLayoutOnly() : {valid:null})`;
    // Wait ready, then OFF pass (baseline), then ON pass (optimized), same page.
    const code = `async (page) => { await page.waitForFunction(() => document.body && document.body.dataset.layoutFitState === 'ready', null, { timeout: 240000 }); await page.evaluate(() => { window.__gallopDisabled = true; window.__mineruRunLayoutFill && window.__mineruRunLayoutFill(); }); const off = await page.evaluate(${snapEval}); const auditOff = await page.evaluate(${auditEval}); await page.evaluate(() => { window.__gallopDisabled = false; window.__mineruRunLayoutFill && window.__mineruRunLayoutFill(); }); const on = await page.evaluate(${snapEval}); const auditOn = await page.evaluate(${auditEval}); const meta = await page.evaluate(() => ({ pages: document.querySelectorAll('.layout-page-wrap').length })); return { VERIFY: { off, on, auditOff, auditOn, pages: meta.pages } }; }`;
    const output = await runCLI(session, "run-code", code);
    const v = extractMarkedJSON(output, '"VERIFY":');
    const off = v.off, on = v.on;
    let fontDiffs = 0, lineDiffs = 0, maxLineDelta = 0, mismatches = 0;
    for (let i = 0; i < Math.min(off.length, on.length); i++) {
      if (off[i] === on[i]) continue;
      mismatches++;
      const [fo, lo] = off[i].split("|"); const [fn2, ln] = on[i].split("|");
      if (fo !== fn2) fontDiffs++;
      if (lo !== ln) { lineDiffs++; const d = Math.abs((parseFloat(ln) || 0) - (parseFloat(lo) || 0)); if (d > maxLineDelta) maxLineDelta = d; }
    }
    const result = {
      tag: opts.tag, pages: v.pages, nodes: off.length, mismatches, fontDiffs, lineDiffs,
      maxLineDelta: Number(maxLineDelta.toFixed(3)),
      auditValidOff: v.auditOff && v.auditOff.valid, auditValidOn: v.auditOn && v.auditOn.valid,
      sameAudit: JSON.stringify(v.auditOff && v.auditOff.firstCollision) === JSON.stringify(v.auditOn && v.auditOn.firstCollision),
    };
    fs.writeFileSync(path.join(opts.output, "verify.json"), JSON.stringify({ result, auditOff: v.auditOff, auditOn: v.auditOn }, null, 2), "utf8");
    console.log("VERIFY_RESULT " + JSON.stringify(result));
  } finally {
    await runCLI(session, "close").catch(() => {});
    await new Promise(r => server.close(r));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
