#!/usr/bin/env node
// Parallel layout-parity verifier across every ready fixture. For each fixture
// it renders the CURRENT engine, captures the gallop-ON final style snapshot and
// the read-only audit, then renders with gallop forced OFF (pure baseline) for a
// second snapshot, and diffs the two. Layout parity is load-independent, so this
// fans out across fixtures; timing is measured separately (paired, serial).
//
// Usage: node scripts/layout-verify-all.mjs [--jobs N]

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const desktop = path.join(process.env.USERPROFILE || "", "Desktop");
const FIX = path.join(desktop, "临时解析文件");

const FIXTURES = [
  { tag: "shock", dir: "Shock-Hugoniot-compression-curve-for-water", cache: "layout_translation_blocks.zh.local-machine.json" },
  { tag: "ai", dir: "人工智能", cache: "layout_translation_blocks.zh.free-machine.json" },
  { tag: "math", dir: "数学", cache: "layout_translation_blocks.zh.free-machine.json" },
  { tag: "gongshi", dir: "正式发表版-2026.4.1", cache: "layout_translation_blocks.zh.free-machine.json" },
  { tag: "deepseek", dir: "deepseek", cache: "layout_translation_blocks.zh.local-machine.json" },
];

function parseArgs(argv) {
  let jobs = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--jobs") jobs = Number(argv[++i]);
  }
  return { jobs };
}

// Run one fixture: render once, then in-page capture gallop-ON snapshot+audit
// and gallop-OFF snapshot, diff them. Uses the shared verify helper baked here
// so each fixture is one isolated node process (own port, own browser session).
async function verifyOne(fx) {
  const outDir = path.join(root, "output", "layout-verify", fx.tag);
  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    path.join(scriptDir, "layout-verify-one.mjs"),
    "--fixture", path.join(FIX, fx.dir),
    "--translation-cache", path.join(FIX, fx.dir, fx.cache),
    "--tag", fx.tag,
    "--output", outDir,
  ];
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const m = stdout.match(/VERIFY_RESULT (\{.*\})/s);
    const result = m ? JSON.parse(m[1]) : { tag: fx.tag, error: "no result marker", stdout: stdout.slice(-500) };
    result.wallMs = Date.now() - started;
    return result;
  } catch (err) {
    return { tag: fx.tag, error: String(err.message || err).slice(0, 400), wallMs: Date.now() - started };
  }
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function main() {
  const { jobs } = parseArgs(process.argv.slice(2));
  console.log(`Verifying ${FIXTURES.length} fixtures with concurrency ${jobs}...`);
  const results = await runPool(FIXTURES, verifyOne, jobs);
  console.log("\n=== LAYOUT PARITY / AUDIT SUMMARY ===");
  for (const r of results) {
    if (r.error) { console.log(`  [${r.tag}] ERROR: ${r.error}`); continue; }
    console.log(`  [${r.tag}] pages=${r.pages} nodes=${r.nodes} mismatches=${r.mismatches} (fontΔ=${r.fontDiffs} lineΔ=${r.lineDiffs}, maxLineΔ=${r.maxLineDelta}) auditOn=${r.auditValidOn} auditOff=${r.auditValidOff} sameAudit=${r.sameAudit} wall=${r.wallMs}ms`);
  }
  fs.writeFileSync(path.join(root, "output", "layout-verify", "summary.json"), JSON.stringify(results, null, 2), "utf8");
  console.log(`\nDetails: ${path.join(root, "output", "layout-verify", "summary.json")}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
