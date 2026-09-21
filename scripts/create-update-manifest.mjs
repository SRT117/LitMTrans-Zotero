import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function value(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return process.argv[index + 1];
}

function optionalValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) return null;
  return process.argv[index + 1];
}

const ANNOUNCEMENT_LEVELS = new Set(["alert", "warning", "info"]);
const ANNOUNCEMENT_ACTION_TYPES = new Set(["update", "url", "dismiss"]);
const VERSION_PATTERN = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requiredAnnouncementText(item, field, index) {
  if (typeof item[field] !== "string" || !item[field].trim()) {
    throw new Error(`第 ${index + 1} 条公告的 ${field} 必须是非空字符串，已阻断发布`);
  }
  return item[field].trim();
}

function optionalAnnouncementText(item, field, index) {
  if (!hasOwn(item, field)) return null;
  if (typeof item[field] !== "string" || !item[field].trim()) {
    throw new Error(`第 ${index + 1} 条公告的 ${field} 必须是非空字符串，已阻断发布`);
  }
  return item[field].trim();
}

function validateHttpUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空 URL，已阻断发布`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    throw new Error(`${label} 不是合法 URL，已阻断发布`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`${label} 只允许使用 http/https，已阻断发布`);
  }
  return value.trim();
}

function compareVersionBounds(left, right) {
  const parse = value => {
    const [withoutBuild] = value.split("+");
    const [core, pre = ""] = withoutBuild.split("-", 2);
    return {
      core: core.split(".").map(Number),
      pre: pre ? pre.split(".") : []
    };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < length; i++) {
    const leftPart = a.core[i] || 0;
    const rightPart = b.core[i] || 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const preLength = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < preLength; i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const aNumber = /^\d+$/.test(a.pre[i]);
    const bNumber = /^\d+$/.test(b.pre[i]);
    if (aNumber && bNumber) return Number(a.pre[i]) < Number(b.pre[i]) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return 0;
}

function validateAnnouncement(item, index, ids) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`第 ${index + 1} 条公告必须是对象，已阻断发布`);
  }

  const id = requiredAnnouncementText(item, "id", index);
  requiredAnnouncementText(item, "title", index);
  requiredAnnouncementText(item, "message", index);
  if (ids.has(id)) {
    throw new Error(`第 ${index + 1} 条公告的 id (${id}) 重复，已阻断发布`);
  }
  ids.add(id);

  if (hasOwn(item, "level")) {
    const level = optionalAnnouncementText(item, "level", index);
    if (!ANNOUNCEMENT_LEVELS.has(level)) {
      throw new Error(`第 ${index + 1} 条公告的 level (${level}) 无效，已阻断发布`);
    }
  }

  const expireAt = optionalAnnouncementText(item, "expireAt", index);
  if (expireAt !== null && Number.isNaN(Date.parse(expireAt))) {
    throw new Error(`第 ${index + 1} 条公告的 expireAt (${expireAt}) 无法解析为有效日期，已阻断发布`);
  }

  const targetMinVersion = optionalAnnouncementText(item, "targetMinVersion", index);
  const targetMaxVersion = optionalAnnouncementText(item, "targetMaxVersion", index);
  for (const [field, version] of [["targetMinVersion", targetMinVersion], ["targetMaxVersion", targetMaxVersion]]) {
    if (version !== null && !VERSION_PATTERN.test(version)) {
      throw new Error(`第 ${index + 1} 条公告的 ${field} (${version}) 不是合法版本号，已阻断发布`);
    }
  }
  if (targetMinVersion && targetMaxVersion && compareVersionBounds(targetMinVersion, targetMaxVersion) > 0) {
    throw new Error(`第 ${index + 1} 条公告的 targetMinVersion 不能高于 targetMaxVersion，已阻断发布`);
  }

  if (!hasOwn(item, "action")) return id;
  const action = item.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error(`第 ${index + 1} 条公告的 action 必须是对象，已阻断发布`);
  }
  if (typeof action.type !== "string" || !ANNOUNCEMENT_ACTION_TYPES.has(action.type)) {
    throw new Error(`第 ${index + 1} 条公告的 action.type (${action.type}) 无效，已阻断发布`);
  }
  if (hasOwn(action, "text") && (typeof action.text !== "string" || !action.text.trim())) {
    throw new Error(`第 ${index + 1} 条公告的 action.text 必须是非空字符串，已阻断发布`);
  }
  if (action.type === "url") {
    validateHttpUrl(action.url, `第 ${index + 1} 条公告的 action.url`);
  } else if (hasOwn(action, "url")) {
    throw new Error(`第 ${index + 1} 条非 URL 公告不应包含 action.url，已阻断发布`);
  }
  return id;
}

const repository = value("repository");
const tag = value("tag");
const xpiPath = value("xpi");
const outputPath = value("out");
const announcementsArg = optionalValue("announcements");
if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("--repository must be owner/repository");
if (!tag.trim()) throw new Error("--tag must not be empty");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const zotero = manifest.applications?.zotero;
if (!zotero?.id || !zotero.strict_min_version || !zotero.strict_max_version) {
  throw new Error("manifest applications.zotero is incomplete");
}
const xpi = await readFile(xpiPath);

let announcements = [];
if (announcementsArg) {
  let raw = announcementsArg.trim();
  const isInlineJson = raw.startsWith("[") || raw.startsWith("{");
  if (!isInlineJson) {
    try {
      raw = await readFile(path.resolve(process.cwd(), announcementsArg), "utf8");
    } catch (readErr) {
      throw new Error(`指定的公告配置文件无法读取 (${announcementsArg}): ${readErr.message}`);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (jsonErr) {
    throw new Error(`公告内容必须是合法的 JSON 格式: ${jsonErr.message}`);
  }

  if (Array.isArray(parsed)) {
    announcements = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.announcements)) {
    announcements = parsed.announcements;
  } else if (parsed && typeof parsed === "object" && parsed.id && parsed.title && parsed.message) {
    announcements = [parsed];
  } else {
    throw new Error("公告配置必须是数组或包含 announcements 数组的对象，拒绝非法的输入结构");
  }

  const ids = new Set();
  announcements.forEach((item, index) => validateAnnouncement(item, index, ids));
}

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
  },
  announcements
};
await writeFile(outputPath, `${JSON.stringify(update, null, 2)}\n`, "utf8");
console.log(`Created ${outputPath} for ${zotero.id} ${manifest.version} with ${announcements.length} announcement(s).`);
