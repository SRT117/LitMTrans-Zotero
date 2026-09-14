import fs from 'node:fs';
import path from 'node:path';

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      results.push(...walk(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.js', '.ts', '.xhtml', '.css'].includes(ext) && !entry.name.endsWith('ported-core.js') && !entry.name.endsWith('.d.ts')) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function extractSymbols(content) {
  const lines = content.split(/\r\n|\r|\n/);
  const classes = new Map(); // className -> { extends, line, methods: [] }
  const topFunctions = [];

  let currentClass = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // Match class declaration: [export] class Foo [extends Bar] {
    const classMatch = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$]+))?/);
    if (classMatch) {
      currentClass = classMatch[1];
      classes.set(currentClass, {
        extends: classMatch[2] || null,
        line: i + 1,
        methods: []
      });
      continue;
    }

    if (currentClass) {
      if (/^\}\s*;?$/.test(trimmed)) {
        currentClass = null;
        continue;
      }
      const methodMatch = trimmed.match(/^(?:static\s+)?(?:async\s+)?\*?([A-Za-z0-9_$]+)\s*\(([^)]*)\)(?::\s*[^;{]+)?\s*\{/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
        classes.get(currentClass).methods.push(methodMatch[1]);
        continue;
      }
    }

    // Top-level / inner named functions (JS & TS)
    const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(?:<[^>]+>)?\s*\(/);
    if (funcMatch) {
      topFunctions.push(funcMatch[1]);
      continue;
    }

    // Variable assigned functions
    const varFuncMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|[a-zA-Z0-9_$]+\s*=>)/);
    if (varFuncMatch) {
      topFunctions.push(varFuncMatch[1]);
      continue;
    }

    // Object methods / controller methods: foo(...) {
    const propFuncMatch = line.match(/^\s{2,4}(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)(?::\s*[^;{]+)?\s*\{\s*$/);
    if (propFuncMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(propFuncMatch[1])) {
      if (currentClass) {
        classes.get(currentClass).methods.push(propFuncMatch[1]);
      } else {
        topFunctions.push(propFuncMatch[1]);
      }
    }
  }

  return { classes, topFunctions };
}

function summarizeAssetFile(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const lineCount = content.split(/\r?\n/).length;

  if (ext === '.xhtml') {
    const lines = [];
    const allIds = [...content.matchAll(/id="([^"]+)"/g)].map(m => m[1]);

    // 1. 弹窗对话框
    const dialogs = [...content.matchAll(/<dialog\s+[^>]*id="([^"]+)"/g)].map(m => `#${m[1]}`);
    
    // 2. 顶栏按钮
    const topbarMatch = content.match(/<header\s+class="topbar"[\s\S]*?<\/header>/);
    const topbarButtons = topbarMatch ? [...topbarMatch[0].matchAll(/<button\s+[^>]*id="([^"]+)"(?:[^>]*title="([^"]*)")?/g)].map(m => `#${m[1]}${m[2] ? `(${m[2].slice(0, 8)})` : ''}`) : [];

    // 3. 阅读区工具栏
    const readerToolbarMatch = content.match(/<div\s+class="reader-toolbar"[\s\S]*?<\/div>\s*<div\s+id="reader-split"/);
    const readerControls = readerToolbarMatch ? [...readerToolbarMatch[0].matchAll(/<(?:button|input)\s+[^>]*id="([^"]+)"/g)].map(m => `#${m[1]}`) : [];

    // 4. 首选项设置项
    const prefControls = allIds.filter(id => id.startsWith('litmtrans-pref-'));

    lines.push(`- **UI 布局模板 (${lineCount} 行)**: 涵盖 ${allIds.length} 个控件/容器元素`);
    if (dialogs.length > 0) {
      lines.push(`  - **弹窗对话框**: \`${dialogs.join('`, `')}\``);
    }
    if (topbarButtons.length > 0) {
      lines.push(`  - **顶栏操作按钮**: \`${topbarButtons.slice(0, 8).join('`, `')}\``);
    }
    if (readerControls.length > 0) {
      lines.push(`  - **阅读工具控件**: \`${readerControls.slice(0, 10).join('`, `')}\``);
    }
    if (content.includes('id="chat-sidebar"')) {
      lines.push(`  - **对话侧栏**: \`#chat-sidebar\` (含会话列表、问答历史、消息输入框与发送按钮)`);
    }
    if (prefControls.length > 0) {
      lines.push(`  - **首选项表单项**: \`${prefControls.slice(0, 10).join('`, `')}\` ... (共 ${prefControls.length} 个配置项)`);
    }
    return lines.join('\n');
  }

  if (ext === '.css') {
    const classes = [...new Set([...content.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(m => m[1]))];
    const sampleClasses = classes.filter(c => !/^\d+/.test(c)).slice(0, 12).join(', ');
    const more = classes.length > 12 ? ` ... (共 ${classes.length} 个类)` : '';
    return `- **样式表 (${lineCount} 行)**: 核心样式类: \`${sampleClasses}\`${more}`;
  }

  return `- **静态资源 (${lineCount} 行)**`;
}

export function generateRepoMap() {
  const rootDir = process.cwd();
  const srcFiles = walk(path.resolve(rootDir, 'src')).map(f => path.relative(rootDir, f).replace(/\\/g, '/')).sort();
  const pkgFiles = walk(path.resolve(rootDir, 'packages')).map(f => path.relative(rootDir, f).replace(/\\/g, '/')).sort();

  const out = [];
  out.push('# LitMTrans-Zotero 代码架构速查全景图 (Compact Repo Map)\n');
  out.push('> 紧凑型代码全景骨架（包含 .js / .ts / .xhtml / .css）。单次 view_file 即可完整吞入（<350行）。覆盖核心扩展层 (src/) 与独立算法包 (packages/)，支持秒级锁定逻辑与 UI 控件。\n');

  let totalClasses = 0;
  let totalMethods = 0;
  let totalFunctions = 0;

  function renderGroup(title, files) {
    out.push(`## ${title}\n`);
    for (const file of files) {
      const fullPath = path.resolve(rootDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const ext = path.extname(file).toLowerCase();

      if (ext === '.xhtml' || ext === '.css') {
        out.push(`### \`${file}\``);
        out.push(summarizeAssetFile(file, content));
        out.push('');
        continue;
      }

      const { classes, topFunctions } = extractSymbols(content);
      if (classes.size === 0 && topFunctions.length === 0) continue;

      const lineCount = content.split(/\r?\n/).length;
      out.push(`### \`${file}\` (${lineCount} 行)`);

      for (const [className, info] of classes.entries()) {
        totalClasses++;
        totalMethods += info.methods.length;
        const extStr = info.extends ? ` extends ${info.extends}` : '';
        const methodsStr = info.methods.length > 0 ? `: \`${info.methods.join('`, `')}\`` : '';
        out.push(`- **class \`${className}${extStr}\`** (L${info.line})${methodsStr}`);
      }

      if (topFunctions.length > 0) {
        totalFunctions += topFunctions.length;
        const uniqueFuncs = [...new Set(topFunctions)];
        out.push(`- **Functions**: \`${uniqueFuncs.join('`, `')}\``);
      }

      out.push('');
    }
  }

  renderGroup('核心扩展运行层 (src/)', srcFiles);
  renderGroup('独立算法与核心包 (packages/)', pkgFiles);

  out.push('---');
  out.push(`\n**符号统计**: 涵盖 ${totalClasses} 个核心类，${totalMethods} 个类方法，${totalFunctions} 个关键函数/模块方法。`);

  const mdPath = path.resolve(rootDir, 'docs/repo-map.md');
  fs.writeFileSync(mdPath, out.join('\n'), 'utf8');

  const finalLines = out.join('\n').split('\n').length;
  console.log(`✅ 成功更新紧凑版 docs/repo-map.md (共 ${finalLines} 行，覆盖 src 与 packages 全量代码及 UI 布局控件)`);
}

// CLI 或监听入口
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) {
  if (process.argv.includes('--watch')) {
    generateRepoMap();
    console.log('👀 [WATCH] 正在监听 src/ 与 packages/ 变动，实时自动重刷 docs/repo-map.md ...');
    let timer = null;
    const watchDirs = [path.resolve(process.cwd(), 'src'), path.resolve(process.cwd(), 'packages')];
    watchDirs.forEach(dir => {
      if (!fs.existsSync(dir)) return;
      fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename || !['.js', '.ts', '.xhtml', '.css'].some(ext => filename.endsWith(ext))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          console.log(`\n[${new Date().toLocaleTimeString()}] 检测到源码变动 (${filename})，实时更新结构树...`);
          generateRepoMap();
        }, 150);
      });
    });
  } else {
    generateRepoMap();
  }
}
