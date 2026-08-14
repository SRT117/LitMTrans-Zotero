namespace LitMTransPort {
  export function normalizeAssetKey(value: string): string {
    return String(value || "").normalize("NFC").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\//, "");
  }
  export function assetBasename(value: string): string { const normalized = normalizeAssetKey(value); return normalized.slice(normalized.lastIndexOf("/") + 1); }
  export function localMarkdownImageTargets(markdown: string): string[] {
    return [...new Set(markdownImageReferences(markdown).map(item => normalizeAssetKey(item.target)).filter(target => target && !/^(?:data|https?|resource|file|chrome):/i.test(target)))];
  }
  export function extensionFromTarget(target: string): string {
    const match = assetBasename(target).match(/(\.[A-Za-z0-9]{1,8})(?:[?#].*)?$/); return match ? match[1].toLowerCase() : "";
  }
  export function standardizeAssets(markdown: string, availablePaths: string[]): { markdown: string; imageMap: DocumentImage[]; missing: string[] } {
    const byKey = new Map<string, string>();
    for (const path of availablePaths) {
      const key = normalizeAssetKey(path); byKey.set(key.toLowerCase(), path); byKey.set(assetBasename(key).toLowerCase(), path);
    }
    const imageMap: DocumentImage[] = [], missing: string[] = [];
    const used = new Set<string>();
    const output = normalizeMarkdownImageTargets(markdown, target => {
      if (/^(?:data|https?|resource|file|chrome):/i.test(target)) return target;
      const normalized = normalizeAssetKey(target); const source = byKey.get(normalized.toLowerCase()) || byKey.get(assetBasename(normalized).toLowerCase()) || "";
      const extension = extensionFromTarget(source || normalized) || ".bin";
      const clean = deduplicateRelativePath(`images/${safe_document_stem(assetBasename(normalized).replace(/\.[^.]+$/, ""), "image", 72)}${extension}`, used);
      const warning = source ? "" : `解析结果中未找到图片：${target}`;
      imageMap.push({ id: `image-${String(imageMap.length + 1).padStart(4, "0")}`, originalTarget: normalized, cleanTarget: clean, page: null, bbox: null, mimeType: "", warning });
      if (warning) missing.push(normalized);
      return clean;
    });
    return { markdown: output, imageMap, missing };
  }
}
