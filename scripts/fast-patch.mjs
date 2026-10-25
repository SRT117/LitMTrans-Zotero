/**
 * fast-patch.mjs
 * 高速代码补丁执行器 (Fast Search & Replace Engine)
 * 
 * 功能：
 * 1. copy <spec1> [spec2]...: 将文件全量或指定的类/函数/行号区间复制到系统剪贴板
 *    - 全量复制: node scripts/fast-patch.mjs copy src/workbench.xhtml
 *    - 符号提取: node scripts/fast-patch.mjs copy src/workbench.js:openImagePreview,copyPreviewImage
 *    - 行号区间: node scripts/fast-patch.mjs copy src/workbench.js:2820-2840
 * 2. read <spec>: 终端查看小文件或指定的类/函数
 * 3. apply <patch-file>: 批量原子应用 @@ SEARCH / @@ REPLACE / @@ END 补丁块
 * 4. 抹平 CRLF/LF，避免 JS 的 $ 替换陷阱，未命中时打印未命中块供 AI 修正
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

// 抹平换行符为 \n
function normalizeNewlines(str) {
  return str.replace(/\r\n/g, '\n');
}

// 检查原文件是否主要是 CRLF
function detectCRLF(str) {
  const crlfCount = (str.match(/\r\n/g) || []).length;
  const lfCount = (str.match(/[^\r]\n/g) || []).length;
  return crlfCount > lfCount;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 解析路径规格：兼容 Windows 盘符 C:\...:fn1,fn2
function parseSpec(spec) {
  let colonIdx = -1;
  if (/^[a-zA-Z]:[/\\]/.test(spec)) {
    colonIdx = spec.indexOf(':', 2);
  } else {
    colonIdx = spec.indexOf(':');
  }

  if (colonIdx === -1) {
    return { filePath: spec, selectors: null };
  }

  const filePath = spec.slice(0, colonIdx);
  const selStr = spec.slice(colonIdx + 1).trim();
  const selectors = selStr ? selStr.split(',').map(s => s.trim()).filter(Boolean) : null;
  return { filePath, selectors };
}

// 智能定位类、函数、方法在文件中的起止行号 (1-based，兼容 JS/TS/Rust 等大括号语言及 Python 缩进语言)
function findSymbolBounds(lines, symbolName, scopeRange = null, isPython = false) {
  let searchStart = 0;
  let searchEnd = lines.length;
  if (scopeRange) {
    searchStart = Math.max(0, scopeRange.start - 1);
    searchEnd = Math.min(lines.length, scopeRange.end);
  }

  if (symbolName.includes('.')) {
    const dotIdx = symbolName.indexOf('.');
    const clsName = symbolName.slice(0, dotIdx);
    const methodName = symbolName.slice(dotIdx + 1);
    const clsBounds = findSymbolBounds(lines, clsName, null, isPython);
    if (!clsBounds) return null;
    return findSymbolBounds(lines, methodName, { start: clsBounds.startLine, end: clsBounds.endLine }, isPython);
  }

  const esc = escapeRegex(symbolName);
  if (isPython) {
    const pyPattern = new RegExp('^(\\s*)(?:async\\s+)?(?:def|class)\\s+' + esc + '\\b');
    let startLine = -1;
    let baseIndent = 0;
    for (let i = searchStart; i < searchEnd; i++) {
      const m = lines[i].match(pyPattern);
      if (m) {
        startLine = i;
        baseIndent = m[1].replace(/\t/g, '    ').length;
        break;
      }
    }
    if (startLine === -1) return null;
    let endLine = startLine;
    for (let i = startLine + 1; i < searchEnd; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = rawLine.match(/^\s*/)[0].replace(/\t/g, '    ').length;
      if (indent <= baseIndent && !trimmed.startsWith(')') && !trimmed.startsWith(']') && !trimmed.startsWith('}')) {
        break;
      }
      endLine = i;
    }
    return { startLine: startLine + 1, endLine: endLine + 1 };
  }

  const patterns = [
    new RegExp('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*' + esc + '\\s*\\('),
    new RegExp('^\\s*(?:export\\s+)?class\\s+' + esc + '(?:\\s+extends\\s+[A-Za-z0-9_$.]+)?\\s*\\{'),
    new RegExp('^\\s*(?:export\\s+)?(?:const|let|var)\\s+' + esc + '\\s*='),
    new RegExp('^\\s*(?:static\\s+)?(?:async\\s+)?\\*?\\s*' + esc + '\\s*\\([^)]*\\)\\s*\\{'),
    new RegExp('^\\s*' + esc + '\\s*:\\s*(?:async\\s+)?(?:function|\\([^)]*\\)\\s*=>)'),
    new RegExp('^\\s*' + esc + '\\s*\\([^)]*\\)\\s*\\{')
  ];

  let startLine = -1;
  for (let i = searchStart; i < searchEnd; i++) {
    const line = lines[i];
    for (const p of patterns) {
      if (p.test(line)) {
        startLine = i;
        break;
      }
    }
    if (startLine !== -1) break;
  }

  if (startLine === -1) return null;

  // 括号深度平衡扫描
  let depth = 0;
  let foundFirstBrace = false;
  let inSingle = false, inDouble = false, inTemplate = false;
  let inLineComment = false, inBlockComment = false;
  let endLine = startLine;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      const next = line[j + 1];

      if (inLineComment) continue;
      if (inBlockComment) {
        if (c === '*' && next === '/') {
          inBlockComment = false;
          j++;
        }
        continue;
      }
      if (inSingle) {
        if (c === '\\') { j++; continue; }
        if (c === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (c === '\\') { j++; continue; }
        if (c === '"') inDouble = false;
        continue;
      }
      if (inTemplate) {
        if (c === '\\') { j++; continue; }
        if (c === '`') inTemplate = false;
        continue;
      }

      if (c === '/' && next === '/') {
        inLineComment = true;
        break;
      }
      if (c === '/' && next === '*') {
        inBlockComment = true;
        j++;
        continue;
      }
      if (c === "'") { inSingle = true; continue; }
      if (c === '"') { inDouble = true; continue; }
      if (c === '`') { inTemplate = true; continue; }

      if (c === '{') {
        depth++;
        foundFirstBrace = true;
      } else if (c === '}') {
        depth--;
        if (foundFirstBrace && depth === 0) {
          endLine = i;
          return { startLine: startLine + 1, endLine: endLine + 1 };
        }
      }
    }
    inLineComment = false;
  }

  return { startLine: startLine + 1, endLine: lines.length };
}

// 提取指定文件中的目标内容（支持全量、函数级或行号级）
function extractTarget(spec) {
  const { filePath, selectors } = parseSpec(spec);
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`❌ 文件不存在: ${filePath} (${resolved})`);
    process.exit(1);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const relPath = path.relative(process.cwd(), resolved).replace(/\\/g, '/');

  // 若无选择器，全量提取
  if (!selectors || selectors.length === 0) {
    const lineCount = raw.split(/\r?\n/).length;
    return {
      text: `=== FILE: ${relPath} ===\n${raw}\n=== END FILE: ${relPath} ===`,
      bytes: Buffer.byteLength(raw, 'utf8'),
      lines: lineCount,
      summary: `${relPath} (全量 ${lineCount} 行)`
    };
  }

  // 针对行号或符号进行按需提取
  const lines = raw.split(/\r?\n/);
  const chunks = [];
  let totalLines = 0;
  let totalBytes = 0;
  const summaries = [];

  for (const selector of selectors) {
    let startLine = -1;
    let endLine = -1;
    let label = selector;

    // 行号范围匹配: 100-200
    const rangeMatch = selector.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      startLine = parseInt(rangeMatch[1], 10);
      endLine = parseInt(rangeMatch[2], 10);
      label = `Lines ${startLine}-${endLine}`;
    } else {
      // 符号定位
      const isPy = resolved.toLowerCase().endsWith('.py');
      const bounds = findSymbolBounds(lines, selector, null, isPy);
      if (!bounds) {
        console.warn(`⚠️ 未能在 ${relPath} 中定位到函数或类: [${selector}]`);
        continue;
      }
      startLine = bounds.startLine;
      endLine = bounds.endLine;
      label = `Symbol: ${selector} (L${startLine}-L${endLine})`;
    }

    if (startLine > endLine || startLine < 1 || startLine > lines.length) {
      console.warn(`⚠️ 目标行号超出范围: ${relPath} [${selector}]`);
      continue;
    }

    // 上下文扩展（前后各保留 3 行）
    const ctxBeforeStart = Math.max(1, startLine - 3);
    const ctxBeforeEnd = startLine - 1;
    const ctxAfterStart = endLine + 1;
    const ctxAfterEnd = Math.min(lines.length, endLine + 3);

    const chunkParts = [];
    chunkParts.push(`=== FILE: ${relPath} (${label}) ===`);

    if (ctxBeforeEnd >= ctxBeforeStart) {
      chunkParts.push(`// --- Context before (L${ctxBeforeStart}-L${ctxBeforeEnd}) ---`);
      chunkParts.push(lines.slice(ctxBeforeStart - 1, ctxBeforeEnd).join('\n'));
    }

    chunkParts.push(`// --- Target Code (L${startLine}-L${endLine}) ---`);
    chunkParts.push(lines.slice(startLine - 1, endLine).join('\n'));

    if (ctxAfterEnd >= ctxAfterStart) {
      chunkParts.push(`// --- Context after (L${ctxAfterStart}-L${ctxAfterEnd}) ---`);
      chunkParts.push(lines.slice(ctxAfterStart - 1, ctxAfterEnd).join('\n'));
    }

    chunkParts.push(`=== END ${label} ===`);

    const chunkText = chunkParts.join('\n');
    chunks.push(chunkText);
    totalLines += (endLine - startLine + 1);
    totalBytes += Buffer.byteLength(chunkText, 'utf8');
    summaries.push(label);
  }

  if (chunks.length === 0) {
    console.error(`❌ 未能在 ${relPath} 提取到任何有效符号，已中止`);
    process.exit(1);
  }

  return {
    text: chunks.join('\n\n'),
    bytes: totalBytes,
    lines: totalLines,
    summary: `${relPath} [${summaries.join(', ')}]`
  };
}

// 全量或精细打包并复制到系统剪贴板
function cmdCopy(specs) {
  if (!specs || specs.length === 0) {
    console.error('❌ 请指定至少一个要复制的目标 (如: src/workbench.js 或 src/workbench.js:openImagePreview)');
    process.exit(1);
  }

  const sections = [];
  let totalBytes = 0;
  let totalLines = 0;
  const targetSummaries = [];

  for (const spec of specs) {
    const res = extractTarget(spec);
    sections.push(res.text);
    totalBytes += res.bytes;
    totalLines += res.lines;
    targetSummaries.push(res.summary);
  }

  const payload = sections.join('\n\n');

  // 通过 PowerShell Set-Clipboard 写入 Windows 系统剪贴板
  const p = spawnSync('powershell', ['-NoProfile', '-Command', '$input | Set-Clipboard'], {
    input: payload,
    encoding: 'utf8'
  });

  if (p.status !== 0) {
    console.error('❌ 复制到剪贴板失败:', p.stderr);
    process.exit(1);
  }

  const kb = (totalBytes / 1024).toFixed(1);
  console.log(`📋 [CLIPBOARD SUCCESS] 已将以下目标复制到系统剪贴板 (共 ${totalLines} 行，${kb} KB)：`);
  targetSummaries.forEach(s => console.log(`   - ${s}`));
  console.log(`💡 提示: 用户只需在输入框按 Ctrl+V 并回车，AI 即可 100% 完整吞入，彻底告别臃肿与工具端截断！`);
}

// 读取小文件或符号到 stdout（支持一次传入多个 spec）
function cmdRead(specs) {
  const list = Array.isArray(specs) ? specs : [specs];
  const outputs = list.filter(Boolean).map(spec => extractTarget(spec).text);
  process.stdout.write(outputs.join('\n\n') + '\n');
}

// 仅输出符号起止行号索引（毫秒级批量定位）
function cmdLocate(specs) {
  const list = Array.isArray(specs) ? specs : [specs];
  for (const spec of list.filter(Boolean)) {
    const { filePath, selectors } = parseSpec(spec);
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) {
      console.log(`❌ ${filePath}: 文件不存在`);
      continue;
    }
    const raw = fs.readFileSync(resolved, 'utf8');
    const relPath = path.relative(process.cwd(), resolved).replace(/\\/g, '/');
    const lines = raw.split(/\r?\n/);
    if (!selectors || selectors.length === 0) {
      console.log(`${relPath}: L1-L${lines.length} (${lines.length} lines)`);
      continue;
    }
    for (const sel of selectors) {
      const isPy = resolved.toLowerCase().endsWith('.py');
      const bounds = findSymbolBounds(lines, sel, null, isPy);
      if (bounds) {
        console.log(`${relPath} :: ${sel} -> L${bounds.startLine}-L${bounds.endLine} (${bounds.endLine - bounds.startLine + 1} lines)`);
      } else {
        console.log(`⚠️ ${relPath} :: ${sel} -> 未找到符号`);
      }
    }
  }
}

// 解析 Patch 文本
function parsePatch(patchText) {
  const lines = patchText.split(/\r?\n/);
  const patches = []; // { file: string, blocks: [ { search: string, replace: string } ] }
  
  let currentFile = null;
  let currentBlocks = [];
  let state = 'IDLE'; // 'IDLE' | 'SEARCH' | 'REPLACE'
  let searchLines = [];
  let replaceLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 匹配文件名头部，例如:
    // FILE: src/foo/bar.js 或 *** FILE: src/foo/bar.js 或 ### File: src/foo/bar.js (兼容可能附带的括号注释)
    const fileMatch = line.match(/^(?:\*{3}\s*|###\s*)?FILE:\s*(.+)$/i);
    if (fileMatch && state === 'IDLE') {
      if (currentFile && currentBlocks.length > 0) {
        patches.push({ file: currentFile, blocks: currentBlocks });
      }
      // 过滤可能附带的 (Symbol: ...) 说明
      currentFile = fileMatch[1].replace(/\s*\(.*?\)\s*$/, '').trim();
      currentBlocks = [];
      continue;
    }

    if (/^@@[ \t]*SEARCH[ \t]*$/i.test(trimmed)) {
      state = 'SEARCH';
      searchLines = [];
      continue;
    }

    if (/^@@[ \t]*REPLACE[ \t]*$/i.test(trimmed)) {
      state = 'REPLACE';
      replaceLines = [];
      continue;
    }

    if (/^@@[ \t]*END[ \t]*$/i.test(trimmed)) {
      if (state === 'REPLACE') {
        currentBlocks.push({
          search: searchLines.join('\n'),
          replace: replaceLines.join('\n')
        });
        state = 'IDLE';
        searchLines = [];
        replaceLines = [];
      }
      continue;
    }

    if (state === 'SEARCH') {
      searchLines.push(line);
    } else if (state === 'REPLACE') {
      replaceLines.push(line);
    }
  }

  if (currentFile && currentBlocks.length > 0) {
    patches.push({ file: currentFile, blocks: currentBlocks });
  }

  return patches;
}

// 应用 Patch
function cmdApply(patchSource) {
  let patchContent = '';
  const patchFilePath = fs.existsSync(patchSource) ? path.resolve(patchSource) : null;
  if (patchFilePath) {
    patchContent = fs.readFileSync(patchFilePath, 'utf8');
  } else {
    patchContent = patchSource;
  }

  const patches = parsePatch(patchContent);
  if (patches.length === 0) {
    console.error('❌ 未在输入中解析出任何有效的补丁块 (FILE: ... @@ SEARCH ... @@ REPLACE ... @@ END)');
    process.exit(1);
  }

  const simulatedFiles = new Map(); // file -> newContent
  const fileOriginalIsCRLF = new Map();

  // 第一阶段：内存中顺序模拟与校验（全部通过才落盘）
  for (const patch of patches) {
    const resolvedPath = path.resolve(process.cwd(), patch.file);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`\n======================================================================`);
      console.error(`❌ 目标文件不存在: ${patch.file} (绝对路径: ${resolvedPath})`);
      console.error(`======================================================================\n`);
      process.exit(1);
    }

    if (!simulatedFiles.has(resolvedPath)) {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      fileOriginalIsCRLF.set(resolvedPath, detectCRLF(raw));
      simulatedFiles.set(resolvedPath, normalizeNewlines(raw));
    }

    let content = simulatedFiles.get(resolvedPath);

    for (let bIndex = 0; bIndex < patch.blocks.length; bIndex++) {
      const block = patch.blocks[bIndex];
      const searchNorm = normalizeNewlines(block.search);
      const replaceNorm = normalizeNewlines(block.replace);

      const firstIdx = content.indexOf(searchNorm);
      if (firstIdx === -1) {
        // 未命中：打印完整未命中块，供 AI 审查修正
        console.error(`\n======================================================================`);
        console.error(`❌ 补丁未命中: 文件 [${patch.file}] 第 ${bIndex + 1} 个 SEARCH 块未能匹配到目标内容`);
        console.error(`----------------------------------------------------------------------`);
        console.error(`未命中的 @@ SEARCH 块内容如下:`);
        console.error(`<<<`);
        console.error(block.search);
        console.error(`>>>`);
        console.error(`----------------------------------------------------------------------`);
        console.error(`💡 提示: 请检查上下文缩进、空行或该逻辑是否已被其他改动影响，提供包含更多前后代码的新 SEARCH 块。`);
        console.error(`======================================================================\n`);
        process.exit(1);
      }

      // 检查唯一性
      const lastIdx = content.lastIndexOf(searchNorm);
      if (firstIdx !== lastIdx) {
        console.error(`\n======================================================================`);
        console.error(`⚠️ 匹配不唯一: 文件 [${patch.file}] 第 ${bIndex + 1} 个 SEARCH 块匹配到了多次`);
        console.error(`----------------------------------------------------------------------`);
        console.error(block.search);
        console.error(`----------------------------------------------------------------------`);
        console.error(`💡 提示: 请在该 SEARCH 块的前后多加 2~3 行上下文以保证唯一性。`);
        console.error(`======================================================================\n`);
        process.exit(1);
      }

      // 内存替换（安全纯字面量切片）
      content = content.slice(0, firstIdx) + replaceNorm + content.slice(firstIdx + searchNorm.length);
      simulatedFiles.set(resolvedPath, content);
    }
  }

  // 第二阶段：原子落盘
  let totalFiles = 0;
  for (const [filePath, newContent] of simulatedFiles.entries()) {
    const isCRLF = fileOriginalIsCRLF.get(filePath);
    const finalContent = isCRLF ? newContent.replace(/\n/g, '\r\n') : newContent;
    fs.writeFileSync(filePath, finalContent, 'utf8');
    const rel = path.relative(process.cwd(), filePath);
    console.log(`✅ 已成功更新: ${rel}`);
    totalFiles++;
  }

  console.log(`\n🎉 全部完成: 共原子更新 ${totalFiles} 个文件。`);

  // 自动钩子：若存在 generate-repo-map.mjs 则秒级刷新架构树（耗时约 60ms）
  const mapScript = path.resolve(process.cwd(), 'scripts/generate-repo-map.mjs');
  if (fs.existsSync(mapScript)) {
    try {
      const res = spawnSync(process.execPath, [mapScript], { encoding: 'utf8' });
      if (res.status === 0) {
        console.log(`🔄 [AUTO MAP] 代码结构树 docs/repo-map.md 已自动同步为最新状态。`);
      }
    } catch {
      // 忽略辅助脚本错误
    }
  }

  // 自动垃圾清理：成功落盘后自动删除临时补丁文件，免去 AI 额外调用一次 rm 命令
  if (patchFilePath && path.extname(patchFilePath).toLowerCase() === '.patch') {
    try {
      fs.unlinkSync(patchFilePath);
      console.log(`🧹 [AUTO CLEANUP] 已自动清理临时补丁文件: ${path.basename(patchFilePath)}`);
    } catch {
      // 忽略清理失败
    }
  }
}

// 快速输出任意代码文件的全部类/函数/方法行号大纲（无需预生成 repo-map，兼容 JS/TS/Python）
function cmdOutline(files) {
  for (const filePath of files.filter(Boolean)) {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) {
      console.log(`❌ ${filePath}: 文件不存在`);
      continue;
    }
    const raw = fs.readFileSync(resolved, 'utf8');
    const relPath = path.relative(process.cwd(), resolved).replace(/\\/g, '/');
    const lines = raw.split(/\r?\n/);
    const isPy = resolved.toLowerCase().endsWith('.py');
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
      if (isPy) {
        const m = line.match(/^(\s*)(?:async\s+)?(class|def)\s+([A-Za-z0-9_]+)\b/);
        if (m) items.push(`${m[1] ? '  ' : ''}${m[2]} ${m[3]}:L${i + 1}`);
      } else {
        const cls = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/);
        if (cls) { items.push(`class ${cls[1]}:L${i + 1}`); continue; }
        const fn = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(/);
        if (fn) { items.push(`fn ${fn[1]}:L${i + 1}`); continue; }
        const vfn = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/);
        if (vfn) { items.push(`fn ${vfn[1]}:L${i + 1}`); continue; }
        const mth = line.match(/^\s{2,6}(?:static\s+)?(?:async\s+)?\*?([A-Za-z0-9_$]+)\s*\([^;]*\)\s*\{\s*$/);
        if (mth && !['if', 'for', 'while', 'switch', 'catch'].includes(mth[1])) {
          items.push(`  method ${mth[1]}:L${i + 1}`);
        }
      }
    }
    console.log(`=== ${relPath} (${lines.length} lines) ===`);
    console.log(items.join(', '));
  }
}

// CLI 入口
const args = process.argv.slice(2);
const command = args[0];

if (command === 'copy' && args.length > 1) {
  cmdCopy(args.slice(1));
} else if (command === 'read' && args.length > 1) {
  cmdRead(args.slice(1));
} else if (command === 'locate' && args.length > 1) {
  cmdLocate(args.slice(1));
} else if (command === 'outline' && args.length > 1) {
  cmdOutline(args.slice(1));
} else if (command === 'apply' && args[1]) {
  cmdApply(args[1]);
} else {
  console.log(`用法:`);
  console.log(`  node scripts/fast-patch.mjs read <spec1> [spec2]...   # 批量读取指定文件或函数/类实现到终端（无需用户粘贴）`);
  console.log(`  node scripts/fast-patch.mjs locate <spec1> [spec2]... # 批量查询指定函数/类的精确起止行号 (Lstart-Lend)`);
  console.log(`  node scripts/fast-patch.mjs apply <patch_file>        # 原子应用补丁文件`);
  console.log(`  node scripts/fast-patch.mjs copy <spec1> [spec2]...   # 复制到剪贴板`);
  process.exit(1);
}
