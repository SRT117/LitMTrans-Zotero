namespace LitMTransPort {
  export const SUPPORTED_INPUT_EXTENSIONS = Object.freeze([
    ".pdf", ".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp",
    ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".html", ".htm",
    ".md", ".markdown", ".txt"
  ]);
  export const DIRECT_TEXT_INPUT_EXTENSIONS = Object.freeze([".md", ".markdown", ".txt", ".html", ".htm"]);


  export function inputExtension(path: string): string {
    const clean = String(path || "").replace(/[?#].*$/, "").replace(/\\/g, "/");
    const name = clean.slice(clean.lastIndexOf("/") + 1);
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index).toLowerCase() : "";
  }
  export function is_supported_input_file(path: string): boolean {
    return SUPPORTED_INPUT_EXTENSIONS.includes(inputExtension(path));
  }
  export function is_direct_text_input_file(path: string): boolean {
    return DIRECT_TEXT_INPUT_EXTENSIONS.includes(inputExtension(path));
  }
  export function inputKind(path: string): "pdf" | "image" | "office" | "html" | "markdown" | "text" | "unsupported" {
    const ext = inputExtension(path);
    if (ext === ".pdf") return "pdf";
    if ([".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp"].includes(ext)) return "image";
    if ([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"].includes(ext)) return "office";
    if ([".html", ".htm"].includes(ext)) return "html";
    if ([".md", ".markdown"].includes(ext)) return "markdown";
    if (ext === ".txt") return "text";
    return "unsupported";
  }
}
