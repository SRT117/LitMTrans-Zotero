import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(root, "node_modules/zotero-plugin-scaffold/dist/cli.js");

export async function patchScaffold() {
  // 修补项目依赖 zotero-plugin-scaffold 的 CLI 入口，防止 updateNotifier 因未处理超时异常导致进程闪退
  if (!existsSync(cliPath)) {
    return;
  }
  const content = await readFile(cliPath, "utf8");
  const targetPattern = /function updateNotifier\([^)]*\)\s*\{[\s\S]*?\}\s*\}\s*\)\.catch\(\);?\s*\}/;
  if (targetPattern.test(content)) {
    const patched = content.replace(
      targetPattern,
      "function updateNotifier(name, version) {\n\t// Disabled by LitMTrans: avoid 30s npm registry timeout and unhandled rejection\n}"
    );
    await writeFile(cliPath, patched, "utf8");
    console.log("[patch-scaffold] 已为 zotero-plugin-scaffold 应用免超时崩溃补丁。");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await patchScaffold();
}
