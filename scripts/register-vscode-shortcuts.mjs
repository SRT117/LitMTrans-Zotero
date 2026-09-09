import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');

// 1. 确保工作区 .vscode/settings.json 中启用快捷键生效开关
const vscodeDir = path.join(workspaceRoot, '.vscode');
const settingsPath = path.join(vscodeDir, 'settings.json');
if (!fs.existsSync(vscodeDir)) {
  fs.mkdirSync(vscodeDir, { recursive: true });
}

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    settings = {};
  }
}
settings['litmtrans.devShortcuts'] = true;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log(`[OK] 已确保工作区设置已激活快捷键开关: ${settingsPath}`);

// 2. 自动检测所有已知 VS Code 衍生 IDE（包括 Trae、VS Code、Cursor、Windsurf 等）
const targetTasks = [
  {
    key: 'ctrl+shift+n',
    command: 'workbench.action.tasks.runTask',
    args: 'Zotero: 新用户干净测试环境（Ctrl+Shift+N）',
    when: 'config.litmtrans.devShortcuts'
  },
  {
    key: 'ctrl+shift+o',
    command: 'workbench.action.tasks.runTask',
    args: 'Zotero: 老用户更新体验环境（Ctrl+Shift+O）',
    when: 'config.litmtrans.devShortcuts'
  }
];

const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library/Application Support') : path.join(process.env.HOME, '.config'));
const candidateIdes = ['Trae', 'Code', 'Cursor', 'Windsurf', 'VSCodium', 'Code - Insiders'];

let registeredCount = 0;
for (const ideName of candidateIdes) {
  const ideUserDir = path.join(appData, ideName, 'User');
  if (!fs.existsSync(ideUserDir)) {
    continue;
  }

  const keybindingsPath = path.join(ideUserDir, 'keybindings.json');
  let existing = [];
  if (fs.existsSync(keybindingsPath)) {
    try {
      const raw = fs.readFileSync(keybindingsPath, 'utf8').trim();
      if (raw) {
        existing = JSON.parse(raw);
        if (!Array.isArray(existing)) {
          existing = [];
        }
      }
    } catch {
      fs.copyFileSync(keybindingsPath, `${keybindingsPath}.bak`);
      existing = [];
    }
  }

  const filtered = existing.filter(item => {
    return !(
      item &&
      (item.args === 'Zotero: 新用户干净测试环境（Ctrl+Shift+N）' ||
        item.args === 'Zotero: 老用户更新体验环境（Ctrl+Shift+O）')
    );
  });

  const finalKeybindings = [...filtered, ...targetTasks];
  fs.writeFileSync(keybindingsPath, JSON.stringify(finalKeybindings, null, 2) + '\n', 'utf8');
  console.log(`[OK] 已成功注册快捷键至 ${ideName}: ${keybindingsPath}`);
  registeredCount++;
}

if (registeredCount === 0) {
  console.warn('[WARN] 未在当前系统中检测到已安装的 VS Code / Trae 用户配置目录。');
} else {
  console.log(`\n快捷键绑定成功（已同步至 ${registeredCount} 个 IDE）：`);
  console.log(`  - Ctrl+Shift+N -> Zotero: 新用户干净测试环境（仅在当前工程生效）`);
  console.log(`  - Ctrl+Shift+O -> Zotero: 老用户更新体验环境（仅在当前工程生效）`);
}
