import { copyFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["node_modules/mermaid/dist/mermaid.min.js", "assets/vendor/mermaid/mermaid.min.js"],
  ["node_modules/mermaid/LICENSE", "assets/vendor/mermaid/LICENSE"]
];

for (const [sourceRelative, targetRelative] of files) {
  const source = resolve(root, sourceRelative);
  const target = resolve(root, targetRelative);
  try { await access(source, constants.R_OK); }
  catch { throw new Error(`缺少 Mermaid 依赖文件：${sourceRelative}。请先运行 npm install。`); }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
