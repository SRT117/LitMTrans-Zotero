"use strict";

// 离线核对原文与译文公式，只输出报告，不修改文献缓存。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const katex = require("katex");
const { createTestContext } = require("../tests/harness");
const env = createTestContext();
env.context.katex = katex;
const M = env.M;
const service = new env.LayoutTranslationService(new env.MemoryStorage(), {});
const root = path.resolve(__dirname, "..");
const input = path.resolve(process.argv[2] || path.join(root, ".zotero-dev/compat/10.0/profile/litmtrans/documents"));
const output = path.resolve(process.argv[3] || path.join(root, "output/formula-escape-audit/report.json"));
const hashes = new Map();
function read(file) {
  const bytes = fs.readFileSync(file);
  hashes.set(file, crypto.createHash("sha256").update(bytes).digest("hex"));
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}
function body(token) {
  if (/^(?:\\\(|\\\[|\$\$)/.test(token)) return token.slice(2, -2);
  return token.startsWith("$") ? token.slice(1, -1) : token;
}
function signature(value) {
  // 保留命令边界及文字参数内的空格，避免把不同公式合并为同一个键。
  const tokens = value.match(/\\[A-Za-z]+|\\[\s\S]|[^\s]/g) || [];
  if (/\\(?:text\w*|mbox|hbox|operatorname)\b/.test(value)) return null;
  return JSON.stringify(tokens);
}
function valid(value) {
  try { katex.renderToString(value, { throwOnError: true, strict: "ignore", trust: false }); return true; }
  catch (_) { return false; }
}
function protectedFormula(value) { return /\\(?:begin|end)\b|\\\\/.test(value); }
function propose(token, sources) {
  const original = body(token);
  if (!/(?<!\\)\\{2}[A-Za-z]/.test(original)) return { status: "unchanged" };
  if (/\\(?:begin|end)\b/.test(original)) return { status: "environment" };
  const candidate = original.replace(/(?<!\\)\\{2}(?=[A-Za-z])/g, "\\");
  const key = signature(candidate);
  if (!key) return { status: "text-argument" };
  const matches = sources.filter(source => !protectedFormula(body(source)) && signature(body(source)) === key);
  if (!matches.length) return { status: "no-source-match", candidate };
  if (matches.length !== 1) return { status: "ambiguous-source", candidate };
  if (!valid(body(matches[0])) || !valid(candidate)) return { status: "parse-error", candidate };
  return { status: "matched", candidate, source: matches[0], key };
}
function linebreaks(token) {
  return (M.renderTeX(token, false).match(/class="mspace newline"/g) || []).length;
}
const totals = { directories: 0, parsedDocuments: 0, translatedDocuments: 0, translationFiles: 0,
  textBlocks: 0, sourceFormulas: 0, translatedFormulas: 0, protectedSourceFormulas: 0,
  suspicious: 0, accepted: 0, removedLinebreaks: 0, staleFiles: 0, orphanBlocks: 0,
  injected: 0, recovered: 0, unchangedControls: 0, renderingMatches: 0 };
const injectionSkipped = {};
const documents = [];
for (const entry of fs.readdirSync(input, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  totals.directories++;
  const dir = path.join(input, entry.name), layoutFile = path.join(dir, "layout.json");
  if (!fs.existsSync(layoutFile)) continue;
  totals.parsedDocuments++;
  const report = { documentID: entry.name, files: [], candidates: [], skipped: {}, errors: [] };
  documents.push(report);
  try {
    const layout = read(layoutFile);
    if (fs.existsSync(path.join(dir, "document.json"))) report.title = read(path.join(dir, "document.json")).sourceFileName;
    const records = service.extractRecordsFromLayout({ pages: layout.pdf_info || layout.pages }, entry.name);
    const sourceMap = new Map(records.map(record => [record.id, M.extractMathTokens(record.text)]));
    for (const sources of sourceMap.values()) {
      totals.sourceFormulas += sources.length;
      for (const source of sources) {
        if (protectedFormula(body(source))) totals.protectedSourceFormulas++;
        assert.notEqual(propose(source, sources).status, "matched", "normal source must stay unchanged");
        totals.unchangedControls++;
        if (protectedFormula(body(source)) || !signature(body(source)) || !valid(body(source))) continue;
        const corrupted = body(source).replace(/\\(?=[A-Za-z])/g, "\\\\");
        if (corrupted === body(source)) continue;
        totals.injected++;
        const result = propose(`\\(${corrupted}\\)`, sources);
        if (result.status === "matched") totals.recovered++;
        else injectionSkipped[result.status] = (injectionSkipped[result.status] || 0) + 1;
      }
    }
    const translationDir = path.join(dir, "layout-translation");
    const files = fs.existsSync(translationDir)
      ? fs.readdirSync(translationDir).filter(name => /^translations\..+\.json$/.test(name)) : [];
    if (files.length) totals.translatedDocuments++;
    for (const file of files) {
      const translations = read(path.join(translationDir, file));
      totals.translationFiles++;
      const metaFile = path.join(translationDir, file.replace(/^translations\./, "meta."));
      const meta = fs.existsSync(metaFile) ? read(metaFile) : null;
      const fingerprint = env.U.hashString(fs.readFileSync(layoutFile, "utf8"));
      const stale = Boolean(meta?.sourceFingerprint && meta.sourceFingerprint !== fingerprint);
      report.files.push({ file, blocks: Object.keys(translations).length, stale });
      if (stale) totals.staleFiles++;
      for (const [id, text] of Object.entries(translations)) {
        if (typeof text !== "string") continue;
        totals.textBlocks++;
        const sources = sourceMap.get(id);
        if (!sources) totals.orphanBlocks++;
        const tokens = M.extractMathTokens(M.normalizeEscapedTeXDelimiters(text));
        totals.translatedFormulas += tokens.length;
        const plans = tokens.map(token => propose(token, sources || []));
        for (const [index, plan] of plans.entries()) {
          if (plan.status === "unchanged") continue;
          totals.suspicious++;
          if (stale) plan.status = "stale-source";
          else if (!sources) plan.status = "missing-block";
          else if (plan.status === "matched" && tokens.filter((token, i) =>
            (plans[i].key || signature(body(token))) === plan.key).length !== 1) plan.status = "ambiguous-target";
          if (plan.status !== "matched") {
            report.skipped[plan.status] = (report.skipped[plan.status] || 0) + 1;
          } else {
            totals.accepted++;
            const before = linebreaks(tokens[index]), after = linebreaks(`\\(${plan.candidate}\\)`);
            assert(after <= before, "candidate must not add formula line breaks");
            const rendered = value => katex.renderToString(value, { throwOnError: true, strict: "ignore", trust: false })
              .replace(/<annotation encoding="application\/x-tex">[\s\S]*?<\/annotation>/g, "");
            assert.equal(rendered(plan.candidate), rendered(body(plan.source)), "candidate must render exactly like its source");
            totals.renderingMatches++;
            totals.removedLinebreaks += before - after;
          }
          report.candidates.push({ file, id, formulaIndex: index + 1, ...plan, original: tokens[index] });
        }
      }
    }
  } catch (error) { report.errors.push(error.message); }
}
const guards = [
  String.raw`\begin{matrix}a\\b\end{matrix}`,
  String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`,
  String.raw`a\\\mathsf{Al}`,
  String.raw`\text{a b}`
];
for (const formula of guards) {
  const token = `\\(${formula}\\)`;
  assert.notEqual(propose(token, [token]).status, "matched", "legal formulas must stay unchanged");
}
const negativeGuards = [
  [String.raw`\(\\mathsf{B}\)`, [String.raw`\(\mathsf{A}\)`]],
  [String.raw`\(\\mathsf{Al}_3\)`, [String.raw`\(\mathsf{Al}_2\)`]],
  [String.raw`\(\\mathsf{Al}\)`, [String.raw`\(\mathsf{Al}\)`, String.raw`\(\mathsf{Al}\)`]],
  [String.raw`\(\\mathsf{Al}\)`, []]
];
for (const [token, sources] of negativeGuards) assert.notEqual(propose(token, sources).status, "matched");
for (const [file, expected] of hashes) assert.equal(
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), expected, "input changed during audit");
const report = { input, createdAt: new Date().toISOString(), mode: "read-only",
  policy: "same block; unique source and target; command-token comparison; skip environments, source row breaks, text arguments and stale generations",
  totals, injectionSkipped, guardCases: guards.length + negativeGuards.length, unchangedInputFiles: hashes.size, documents };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ totals, injectionSkipped, guardCases: report.guardCases, unchangedInputFiles: hashes.size,
  errors: documents.filter(doc => doc.errors.length).map(doc => ({ id: doc.documentID, errors: doc.errors })), output }, null, 2));
