namespace LitMTransPort {
  export function detectImageMimeType(bytes: Uint8Array, fallback = "image/png"): string {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
    if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 3)) === "GIF") return "image/gif";
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
    return fallback;
  }
  export function isProbablyImageModel(model: string): boolean { return /(?:image|imagen|dall-e|gpt-image|flux|stable-diffusion)/i.test(String(model || "")); }
}
