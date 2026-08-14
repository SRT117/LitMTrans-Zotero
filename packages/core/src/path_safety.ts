namespace LitMTransPort {
  const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

  export function safe_document_stem(value: string, fallback = "document", maxLength = 96): string {
    let text = String(value || "").normalize("NFC").replace(ILLEGAL, "_");
    text = text.replace(/[. ]+$/g, "").replace(/\s+/g, " ").trim();
    if (!text || WINDOWS_RESERVED.test(text)) text = `${fallback}_${shortHash(String(value || fallback))}`;
    const limit = Math.max(16, Math.trunc(maxLength || 96));
    if (Array.from(text).length > limit) {
      const suffix = `_${shortHash(text)}`;
      text = Array.from(text).slice(0, Math.max(1, limit - suffix.length)).join("") + suffix;
    }
    return text;
  }
  export function shortHash(value: string): string {
    let hash = 0x811c9dc5;
    for (const ch of String(value || "")) {
      hash ^= ch.codePointAt(0) || 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  export function normalizeRelativePath(value: string): string {
    const segments: string[] = [];
    for (const raw of String(value || "").normalize("NFC").replace(/\\/g, "/").split("/")) {
      const segment = raw.trim();
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!segments.length) throw new PortError("INVALID_ZIP", `ZIP条目越出目标目录: ${value}`);
        segments.pop();
        continue;
      }
      segments.push(safe_document_stem(segment, "entry", 120));
    }
    if (!segments.length) throw new PortError("INVALID_ZIP", `ZIP条目路径为空: ${value}`);
    return segments.join("/");
  }
  export function deduplicateRelativePath(path: string, used: Set<string>): string {
    const normalized = normalizeRelativePath(path);
    const key = normalized.toLocaleLowerCase();
    if (!used.has(key)) { used.add(key); return normalized; }
    const slash = normalized.lastIndexOf("/");
    const dir = slash >= 0 ? normalized.slice(0, slash + 1) : "";
    const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let index = 2; index < 100000; index++) {
      const candidate = `${dir}${stem} (${index})${ext}`;
      const candidateKey = candidate.toLocaleLowerCase();
      if (!used.has(candidateKey)) { used.add(candidateKey); return candidate; }
    }
    throw new PortError("INVALID_ZIP", `无法为重复文件名分配安全名称: ${path}`);
  }
  export function shortenWindowsPath(relativePath: string, maxLength = 220): string {
    const normalized = normalizeRelativePath(relativePath);
    if (normalized.length <= maxLength) return normalized;
    const parts = normalized.split("/");
    const file = parts.pop() || "file";
    const dot = file.lastIndexOf(".");
    const ext = dot > 0 ? file.slice(dot) : "";
    const base = dot > 0 ? file.slice(0, dot) : file;
    const hash = shortHash(normalized);
    const compactFile = `${safe_document_stem(base, "file", 48)}_${hash}${ext.slice(0, 16)}`;
    const tail = parts.slice(-2).map(part => safe_document_stem(part, "dir", 36));
    const compact = [...tail, compactFile].join("/");
    return compact.length <= maxLength ? compact : `${hash}/${compactFile}`;
  }
  export function commonDirectoryPrefix(paths: string[]): string {
    const split = paths.map(normalizeRelativePath).map(path => path.split("/"));
    if (!split.length) return "";
    const prefix: string[] = [];
    for (let i = 0; i < Math.min(...split.map(parts => parts.length)); i++) {
      const value = split[0][i];
      if (split.every(parts => parts[i] === value)) prefix.push(value); else break;
    }
    return prefix.join("/");
  }
}
