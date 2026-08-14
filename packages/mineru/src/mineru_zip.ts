namespace LitMTransPort {
  export interface ZipEntryDescriptor { name: string; directory: boolean; compressedSize: number; uncompressedSize: number; }
  export interface PlannedZipEntry extends ZipEntryDescriptor { sourceName: string; relativePath: string; }
  export function planZipExtraction(entries: ZipEntryDescriptor[], options: { maxFiles?: number; maxUncompressedBytes?: number; windowsMaxPath?: number } = {}): PlannedZipEntry[] {
    const maxFiles = Math.max(1, Number(options.maxFiles || 20000));
    const maxBytes = Math.max(1, Number(options.maxUncompressedBytes || 4 * 1024 * 1024 * 1024));
    const files = entries.filter(entry => !entry.directory);
    if (files.length > maxFiles) throw new PortError("INVALID_ZIP", `ZIP文件数量超过限制: ${files.length}`);
    const total = files.reduce((sum, entry) => sum + Math.max(0, Number(entry.uncompressedSize || 0)), 0);
    if (total > maxBytes) throw new PortError("INVALID_ZIP", `ZIP解压后体积超过限制: ${total}`);
    const normalized = files.map(entry => ({ ...entry, sourceName: entry.name, relativePath: normalizeRelativePath(entry.name) }));
    const prefix = commonDirectoryPrefix(normalized.map(entry => entry.relativePath));
    const stripPrefix = prefix && normalized.every(entry => entry.relativePath.startsWith(prefix + "/")) ? prefix + "/" : "";
    const used = new Set<string>();
    return normalized.map(entry => {
      const relative = stripPrefix ? entry.relativePath.slice(stripPrefix.length) : entry.relativePath;
      const shortened = shortenWindowsPath(relative, Number(options.windowsMaxPath || 220));
      return { ...entry, relativePath: deduplicateRelativePath(shortened, used) };
    });
  }
  export function identifyMinerURoot(paths: string[]): string {
    const normalized = paths.map(path => normalizeRelativePath(path));
    const scores = new Map<string, number>();
    for (const path of normalized) {
      const parts = path.split("/");
      for (let depth = 0; depth < parts.length; depth++) {
        const dir = parts.slice(0, depth).join("/");
        const name = parts[parts.length - 1].toLowerCase();
        let score = scores.get(dir) || 0;
        if (name.endsWith(".md")) score += 10;
        if (/(?:model|content|middle|layout).*\.json$/.test(name)) score += 8;
        if (/images?\//i.test(path)) score += 2;
        scores.set(dir, score);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || "";
  }
}
