import { readFile } from "node:fs/promises";
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
const apiBase = (process.env.GITEE_API_BASE || "https://api.gitee.com/api/v5").replace(/\/+$/, "");

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

async function removeExistingAttachment(releaseId, filename) {
  const attachments = await request(`${repoPath}/releases/${releaseId}/attach_files`);
  const matches = Array.isArray(attachments)
    ? attachments.filter(item => item?.name === filename && item?.id !== undefined)
    : [];
  for (const item of matches) {
    await request(`${repoPath}/releases/${releaseId}/attach_files/${item.id}`, { method: "DELETE" });
  }
}

async function uploadAttachment(releaseId, filePath) {
  const filename = path.basename(filePath);
  await removeExistingAttachment(releaseId, filename);
  const form = new FormData();
  form.append("file", new Blob([await readFile(filePath)]), filename);
  await request(`${repoPath}/releases/${releaseId}/attach_files`, {
    method: "POST",
    body: form
  });
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

await uploadAttachment(release.id, xpiPath);
await uploadAttachment(release.id, updateManifestPath);
await publishUpdateManifest();

console.log(JSON.stringify({
  repository,
  tag,
  releaseId: release.id,
  updateManifest: `https://gitee.com/${repository}/raw/main/update.json`,
  xpi: `https://gitee.com/${repository}/releases/download/${tag}/${path.basename(xpiPath)}`
}));
