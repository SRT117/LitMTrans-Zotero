import { build } from "vite";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "node_modules/.cache/litmtrans-local-ocr");
await build({
  root,
  base: "./",
  logLevel: "error",
  build: {
    outDir: output,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, "src/local-ocr-entry.mjs"),
      output: { format: "es", inlineDynamicImports: true, entryFileNames: "local-ocr.js" }
    }
  }
});
const destination = resolve(root, "assets/vendor/local-ocr");
await mkdir(destination, { recursive: true });
await copyFile(resolve(output, "local-ocr.js"), resolve(destination, "local-ocr.js"));
