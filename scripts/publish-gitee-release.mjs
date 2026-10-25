import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function requiredArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return process.argv[index + 1];
}

const repository = requiredArg("repository");
const tag = requiredArg("tag");
const xpiPath = requiredArg("xpi");
const updateManifestPath = requiredArg("update-manifest");
const token = process.env.GITEE_ACCESS_TOKEN;
const apiBase = (process.env.GITEE_API_BASE || "https://gitee.com/api/v5").replace(/\/+$/, "");

if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("--repository must be owner/repository");
if (!tag.trim()) throw new Error("--tag must not be empty");
if (!token) throw new Error("GITEE_ACCESS_TOKEN is required");

const [owner, repo] = repository.split("/");
const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const headers = {
  Accept: "application/json",
  Authorization: `Bearer ${token}`
};

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    signal: AbortSignal.timeout(30000),
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!response.ok) {
    const error = new Error(`Gitee API ${response.status} ${options.method || "GET"} ${pathname}: ${body?.message || "request failed"}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function findRelease() {
  try {
    return await request(`${repoPath}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function createRelease() {
  const body = new URLSearchParams({
    tag_name: tag,
    name: `LitMTrans ${tag}`,
    body: `LitMTrans ${tag}`,
    target_commitish: "main",
    prerelease: "false"
  });
  return request(`${repoPath}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyDownload(url, expected) {
  const bytes = execFileSync("curl", ["--fail", "--silent", "--show-error", "--location",
    "--connect-timeout", "15", "--max-time", "120", url], { maxBuffer: 100 * 1024 * 1024 });
  if (digest(bytes) !== expected) throw new Error(`Download hash mismatch: ${url}`);
}

async function uploadAttachment(releaseId, filePath, attachmentName = path.basename(filePath)) {
  const bytes = await readFile(filePath);
  const hash = digest(bytes);
  let filename = attachmentName;
  const attachments = await request(`${repoPath}/releases/${releaseId}/attach_files`);
  let existing = attachments.find(item => item?.name === filename);
  if (existing) {
    try {
      verifyDownload(existing.browser_download_url, hash);
      return existing.browser_download_url;
    } catch (_) {
      // 同版本覆盖使用内容指纹文件名，保留旧清单仍在引用的附件。
      const extension = path.extname(filename);
      filename = `${path.basename(filename, extension)}-${hash.slice(0, 16)}${extension}`;
      existing = attachments.find(item => item?.name === filename);
    }
  }
  const downloadUrl = `https://gitee.com/${repository}/releases/download/${tag}/${filename}`;
  if (existing) {
    verifyDownload(downloadUrl, hash);
    return downloadUrl;
  }
  const url = `${apiBase}${repoPath}/releases/${releaseId}/attach_files`;
  try {
    execFileSync("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--connect-timeout", "15",
    "--max-time", "120",
    "-X", "POST",
    "--config", "-",
    "-F", `file=@${filePath};filename=${filename}`,
    url
    ], { input: `header = "Authorization: Bearer ${token}"\n`, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`Gitee attachment upload failed (curl exit ${error.status ?? "unknown"})`);
  }
  verifyDownload(downloadUrl, hash);
  return downloadUrl;
}

async function readRemoteFile() {
  try {
    return await request(`${repoPath}/contents/update.json?ref=main`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function publishUpdateManifest() {
  const current = await readRemoteFile();
  const content = (await readFile(updateManifestPath)).toString("base64");
  const body = {
    content,
    message: `chore: publish ${tag} update manifest`,
    branch: "main"
  };
  const method = current?.sha ? "PUT" : "POST";
  if (current?.sha) body.sha = current.sha;
  await request(`${repoPath}/contents/update.json`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const repositoryInfo = await request(repoPath);
if (repositoryInfo.private) throw new Error("Gitee repository must be public");

const release = await findRelease() || await createRelease();
if (!release?.id) throw new Error("Gitee release was created without an id");

const xpiHash = digest(await readFile(xpiPath));
const manifest = JSON.parse(await readFile(updateManifestPath, "utf8"));
const update = manifest.addons?.["litmtrans@srt117.github.io"]?.updates?.find(item => `v${item.version}` === tag);
if (!update || update.update_hash !== `sha256:${xpiHash}`) throw new Error("Manifest does not match XPI hash/version");
const xpiUrl = await uploadAttachment(release.id, xpiPath);
update.update_link = xpiUrl;
await writeFile(updateManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await uploadAttachment(release.id, updateManifestPath, "update.json");
await publishUpdateManifest();

console.log(JSON.stringify({
  repository,
  tag,
  releaseId: release.id,
  updateManifest: `https://gitee.com/${repository}/raw/main/update.json`,
  xpi: xpiUrl
}));
