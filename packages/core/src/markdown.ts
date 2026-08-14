namespace LitMTransPort {
  export interface MarkdownBlock { index: number; kind: string; text: string; start: number; end: number; }


  export function cleanMarkdownText(value: string): string {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
  }
  export function markdownBlocks(markdown: string): MarkdownBlock[] {
    const text = cleanMarkdownText(markdown);
    const blocks: MarkdownBlock[] = [];
    let start = 0, inFence = false, fence = "", current: string[] = [];
    const flush = (end: number) => {
      const value = current.join("\n").trimEnd();
      if (value.trim()) {
        let kind = "paragraph";
        if (/^```|^~~~/.test(value)) kind = "code";
        else if (/^#{1,6}\s/.test(value)) kind = "heading";
        else if (/^(?:\|.*\|\s*\n\|?\s*:?-{3,})/s.test(value)) kind = "table";
        else if (/^\s*[-*+]\s|^\s*\d+[.)]\s/.test(value)) kind = "list";
        else if (/^>/.test(value)) kind = "quote";
        else if (/^!\[[^\]]*\]\([^)]+\)/.test(value)) kind = "image";
        else if (/^\$\$[\s\S]*\$\$$/.test(value) || /^\\\[[\s\S]*\\\]$/.test(value)) kind = "formula";
        blocks.push({ index: blocks.length, kind, text: value, start, end });
      }
      current = [];
      start = end;
    };
    let offset = 0;
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*(```+|~~~+)/);
      if (match) {
        if (!inFence) { inFence = true; fence = match[1][0]; }
        else if (match[1][0] === fence) inFence = false;
      }
      if (!inFence && !line.trim() && current.length) flush(offset);
      else if (line.trim() || current.length || inFence) current.push(line);
      offset += line.length + 1;
    }
    flush(text.length);
    return blocks;
  }
  export function markdown_block_translation_text(block: string): string {
    const text = String(block || "");
    if (/^```|^~~~/.test(text.trim())) return "";
    if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(text.trim())) return "";
    return text
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .trim();
  }
  export function splitMarkdownByChars(markdown: string, maxChars: number): string[] {
    const limit = Math.max(1000, Math.trunc(maxChars || 135000));
    const blocks = markdownBlocks(markdown);
    const chunks: string[] = [];
    let current: string[] = [], length = 0;
    for (const block of blocks) {
      const addition = block.text.length + (current.length ? 2 : 0);
      if (current.length && length + addition > limit) {
        chunks.push(current.join("\n\n") + "\n"); current = []; length = 0;
      }
      if (block.text.length > limit && block.kind === "paragraph") {
        const sentences = block.text.split(/(?<=[.!?。！？])\s+/);
        for (const sentence of sentences) {
          if (current.length && length + sentence.length + 1 > limit) {
            chunks.push(current.join(" ") + "\n"); current = []; length = 0;
          }
          current.push(sentence); length += sentence.length + 1;
        }
      }
      else { current.push(block.text); length += addition; }
    }
    if (current.length) chunks.push(current.join("\n\n") + "\n");
    return chunks;
  }
  export function normalizeMarkdownImageTargets(markdown: string, resolve: (target: string) => string): string {
    return String(markdown || "").replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (_match, prefix, target, suffix) => `${prefix}${resolve(String(target).trim())}${suffix}`);
  }
  export function markerDetected(text: string, marker: string): boolean {
    const value = String(text || ""), expected = String(marker || "");
    if (!expected) return false;
    if (value.includes(expected)) return true;
    const digits = expected.replace(/\D/g, "");
    if (!digits) return false;
    return new RegExp(digits.split("").join("[\\s_\\-.,:;|/\\\\]*")).test(value);
  }
  export function stripCompletionMarker(text: string, marker: string): string {
    let value = String(text || "");
    const index = marker ? value.lastIndexOf(marker) : -1;
    if (index >= 0) value = value.slice(0, index);
    return value.replace(/(?:结束标记|截止标记|完成标记|end\s*marker|completion\s*token)\s*[:：]?\s*$/gim, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }
  export function formulaDelimiterBalance(text: string): { ok: boolean; inline: number; display: number; brackets: number } {
    const value = String(text || "").replace(/\\\$/g, "");
    const display = (value.match(/\$\$/g) || []).length;
    const withoutDisplay = value.replace(/\$\$/g, "");
    const inline = (withoutDisplay.match(/\$/g) || []).length;
    const brackets = (value.match(/\\\[/g) || []).length - (value.match(/\\\]/g) || []).length;
    return { ok: display % 2 === 0 && inline % 2 === 0 && brackets === 0, inline, display, brackets };
  }
}
