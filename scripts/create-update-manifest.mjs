import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function value(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return process.argv[index + 1];
}

const repository = value("repository");
const tag = value("tag");
const xpiPath = value("xpi");
const outputPath = value("out");
if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("--repository must be owner/repository");
if (!tag.trim()) throw new Error("--tag must not be empty");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const zotero = manifest.applications?.zotero;
if (!zotero?.id || !zotero.strict_min_version || !zotero.strict_max_version) {
  throw new Error("manifest applications.zotero is incomplete");
}
const xpi = await readFile(xpiPath);
const update = {
  addons: {
    [zotero.id]: {
      updates: [{
        version: manifest.version,
        update_link: `https://github.com/${repository}/releases/download/${tag}/${path.basename(xpiPath)}`,
        update_hash: `sha256:${createHash("sha256").update(xpi).digest("hex")}`,
        applications: {
          zotero: {
            strict_min_version: zotero.strict_min_version,
            strict_max_version: zotero.strict_max_version
          }
        }
      }]
    }
  }
};
await writeFile(outputPath, `${JSON.stringify(update, null, 2)}\n`, "utf8");
console.log(`Created ${outputPath} for ${zotero.id} ${manifest.version}.`);
