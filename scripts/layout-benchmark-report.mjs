#!/usr/bin/env node

// Batch-run the existing real-engine parity harness.  Each child invocation
// produces the Python/Qt-derived HTML and the Zotero workbench HTML from the
// same MinerU model and translated-block cache, then records both timing and
// rendered-layout comparisons.  This script only writes under output/ and the
// system temp directory; it never changes a fixture or either application's
// persisted document cache.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const desktop = path.join(process.env.USERPROFILE || path.dirname(path.dirname(root)), "Desktop");
const DEFAULT_FIXTURE_ROOT = path.join(desktop, "临时解析文件");
const DEFAULT_PYTHON_ROOT = path.join(desktop, "LitMTrans");
const parityHarness = path.join(scriptDir, "layout-parity-test.mjs");

function parseArgs(argv) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const options = {
    fixtureRoot: DEFAULT_FIXTURE_ROOT,
    pythonRoot: DEFAULT_PYTHON_ROOT,
    output: path.join(root, "output", `layout-benchmark-${timestamp}`),
    limit: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture-root") options.fixtureRoot = argv[++index];
    else if (value === "--python-root") options.pythonRoot = argv[++index];
    else if (value === "--output") options.output = argv[++index];
    else if (value === "--limit") options.limit = Number(argv[++index] || 0);
    else if (value === "--help" || value === "-h") {
      console.log("node scripts/layout-benchmark-report.mjs [--fixture-root DIR] [--python-root DIR] [--output DIR] [--limit N]");
      process.exit(0);
    }
    else throw new Error(`Unknown argument: ${value}`);
  }
  options.fixtureRoot = path.resolve(options.fixtureRoot);
  options.pythonRoot = path.resolve(options.pythonRoot);
  options.output = path.resolve(options.output);
  if (!Number.isFinite(options.limit) || options.limit < 0) throw new Error("--limit must be a non-negative number");
  return options;
}

function newestTranslationCache(directory) {
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^layout_translation_blocks\.zh(?:\..+)?\.json$/i.test(entry.name))
    .map(entry => {
      const filename = path.join(directory, entry.name);
      return { filename, mtimeMs: fs.statSync(filename).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filename || "";
}

function discoverFixtures(fixtureRoot) {
  assert.ok(fs.existsSync(fixtureRoot), `Fixture root does not exist: ${fixtureRoot}`);
  return fs.readdirSync(fixtureRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const fixture = path.join(fixtureRoot, entry.name);
      const markdown = path.join(fixture, "full.cleaned.md");
      const layout = path.join(fixture, "mineru_result", "layout.json");
      const model = path.join(fixture, "mineru_result", "merged_model.json");
      const translationCache = newestTranslationCache(fixture);
      const inputs = [markdown, layout, model, translationCache];
      return {
        name: entry.name,
        fixture,
        markdown,
        layout,
        model,
        translationCache,
        ready: inputs.every(filename => Boolean(filename) && fs.existsSync(filename)),
      };
    })
    .filter(entry => entry.ready)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function safeName(value) {
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim().slice(0, 110);
}

function asMs(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function effectStatus(summary) {
  if (!summary) return "未生成对照";
  if (summary.pythonPages !== summary.pluginPages || summary.unmatchedPython || summary.unmatchedPlugin) {
    return "结构不一致";
  }
  if (!summary.materialDifferences && !summary.textMaterialDifferences) return "布局一致";
  return `结构一致；需复核 ${summary.textMaterialDifferences} 处文本差异/${summary.materialDifferences} 处总差异`;
}

function readResult(documentOutput, fixture) {
  const report = JSON.parse(fs.readFileSync(path.join(documentOutput, "report.json"), "utf8"));
  const pythonTrace = JSON.parse(fs.readFileSync(path.join(documentOutput, "python-trace.json"), "utf8"));
  const pluginTrace = JSON.parse(fs.readFileSync(path.join(documentOutput, "plugin-trace.json"), "utf8"));
  const summary = report.comparison.summary;
  const pythonPerformance = pythonTrace.performance || {};
  const pluginPerformance = pluginTrace.performance || {};
  const pythonMs = asMs(pythonPerformance.phases?.runTotal);
  const pluginMs = asMs(pluginPerformance.phases?.runTotal ?? pluginPerformance.elapsedMs);
  return {
    status: "ok",
    document: fixture.name,
    fixture: fixture.fixture,
    cache: path.basename(fixture.translationCache),
    output: documentOutput,
    pages: summary.pythonPages,
    nodes: summary.pythonItems,
    pythonMs,
    pluginMs,
    speedup: pythonMs && pluginMs ? Math.round((pythonMs / pluginMs) * 100) / 100 : null,
    pythonFinalAuditMs: asMs(pythonPerformance.phases?.finalSafetyAudit),
    pluginFinalAuditMs: asMs(pluginPerformance.phases?.finalSafetyAudit),
    pythonRangeCalls: Number(pythonPerformance.counters?.textRectsCalls || 0),
    pluginRangeCalls: Number(pluginPerformance.counters?.textRectsCalls || 0),
    comparison: summary,
    effect: effectStatus(summary),
  };
}

function writeMarkdown(results, options) {
  const completed = results.filter(result => result.status === "ok");
  const pythonValues = completed.map(result => result.pythonMs).filter(Number.isFinite);
  const pluginValues = completed.map(result => result.pluginMs).filter(Number.isFinite);
  const average = values => values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : "—";
  const lines = [
    "# LitMTrans 双引擎排版速度与效果报告", "",
    `生成时间：${new Date().toLocaleString("zh-CN")}`, "",
    "计时范围：冷启动后的排版核心（不含翻译网络请求、PDF 导出和截图写盘）。Python 与插件使用同一份 MinerU 解析结果及排版译文缓存。报告保留截图和逐块几何对照；批量运行不导出 PDF，以免打印子系统故障中断其他文献。", "",
    `有效文献：${completed.length}/${results.length}；Python 核心平均：${average(pythonValues)} ms；插件核心平均：${average(pluginValues)} ms。`, "",
    "| 文献 | 页数 | 节点 | Python ms | 插件 ms | Python/插件 | Python 最终审计 ms | 插件最终审计 ms | 效果对照 |", "|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const result of results) {
    if (result.status !== "ok") {
      lines.push(`| ${result.document} | — | — | — | — | — | — | — | 失败：${String(result.error || "未知错误").replaceAll("|", "\\|")} |`);
      continue;
    }
    lines.push(`| ${result.document} | ${result.pages} | ${result.nodes} | ${result.pythonMs} | ${result.pluginMs} | ${result.speedup}× | ${result.pythonFinalAuditMs} | ${result.pluginFinalAuditMs} | ${result.effect} |`);
  }
  lines.push("", "## 效果判定说明", "",
    "“结构一致”表示页数、布局节点数及节点匹配均一致。仍有文本差异时，逐篇目录中的 `report.md`、`python.png`、`plugin.png`、`report.json` 可用于检查字号、行距、框位置与逐字碰撞。", "",
    "## 原始数据", "",
    "每篇文献的目录都保留 `python-trace.json`、`plugin-trace.json` 与 `report.json`；汇总结构化数据见 `summary.json`。", "");
  fs.writeFileSync(path.join(options.output, "report.md"), lines.join("\n"), "utf8");
}

async function benchmarkFixture(fixture, index, total, options) {
  const documentOutput = path.join(options.output, "documents", `${String(index + 1).padStart(2, "0")}-${safeName(fixture.name)}`);
  const artifactOutput = path.join(os.tmpdir(), "litmtrans-layout-benchmark", path.basename(options.output), `${String(index + 1).padStart(2, "0")}-${safeName(fixture.name)}`);
  fs.mkdirSync(documentOutput, { recursive: true });
  fs.mkdirSync(artifactOutput, { recursive: true });
  const args = [
    parityHarness,
    "--profile",
    "--fixture", fixture.fixture,
    "--translation-cache", fixture.translationCache,
    "--python-root", options.pythonRoot,
    "--output", documentOutput,
    "--artifact-output", artifactOutput,
    "--no-pdf",
  ];
  process.stdout.write(`\n[${index + 1}/${total}] ${fixture.name}\n`);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (stdout.trim()) process.stdout.write(`${stdout.trim()}\n`);
    if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`);
    return readResult(documentOutput, fixture);
  } catch (error) {
    return {
      status: "error",
      document: fixture.name,
      fixture: fixture.fixture,
      output: documentOutput,
      error: String(error?.stderr || error?.message || error).trim().slice(0, 1500),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = discoverFixtures(options.fixtureRoot);
  const selected = options.limit ? fixtures.slice(0, options.limit) : fixtures;
  assert.ok(selected.length, `No complete parsed-and-translated fixtures found under ${options.fixtureRoot}`);
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, "manifest.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    fixtureRoot: options.fixtureRoot,
    pythonRoot: options.pythonRoot,
    fixtures: selected.map(fixture => ({ name: fixture.name, fixture: fixture.fixture, translationCache: fixture.translationCache })),
  }, null, 2), "utf8");
  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    results.push(await benchmarkFixture(selected[index], index, selected.length, options));
    fs.writeFileSync(path.join(options.output, "summary.json"), JSON.stringify(results, null, 2), "utf8");
    writeMarkdown(results, options);
  }
  const failures = results.filter(result => result.status !== "ok");
  console.log(`\n报告：${path.join(options.output, "report.md")}`);
  if (failures.length) process.exitCode = 1;
}

await main();
