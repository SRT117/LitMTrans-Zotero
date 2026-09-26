# Third-Party Notices

LitMTrans's own source is licensed under MIT; that license does not replace the
licenses of bundled components. The detailed pinned inventory and distribution
boundaries are in `docs/licensing/third-party-inventory.md`.

## Bundled fonts and JavaScript

- Source Han Serif CN 2.003 is distributed unmodified under SIL OFL 1.1. Its
  complete license is `assets/fonts/LICENSE-SourceHanSerif.txt`.
- KaTeX 0.16.47 JavaScript/CSS is MIT (`assets/vendor/katex/LICENSE.txt`). Its
  bundled fonts are under SIL OFL 1.1 (`assets/vendor/licenses/KaTeX-Fonts-OFL-1.1.txt`);
  the copyright attribution is retained there.
- Mermaid 11.16.1, Pako 2.1.0, and pdf-lib 1.17.1 are bundled for offline
  rendering, decompression, and PDF page handling. Pako's MIT and Zlib notices
  are both retained. Direct and transitive npm package notices are preserved
  under `assets/vendor/licenses/npm/`, keyed by package and locked version.
- Selected portable modules from `cookjohn/zotero-mcp` are adapted under MIT.
  Original attribution and the complete MIT text are in
  `assets/vendor/licenses/zotero-mcp-MIT.txt`; adapted files and the available
  provenance boundary are listed in the inventory.

## CAJ WebAssembly

The independent `caj2pdf-rs` CAJ converter is distributed as WebAssembly under
GPL-2.0-or-later. Its source, fixed upstream commit, build instructions, and
license are retained in `native/caj-backend/` and `native/dist/caj2pdf/`.
The binary includes a JBIG1 decoder derived from code distributed under the
FreeType Project License (FTL); the full GPL and FTL text and attribution are
included in both CAJ license files. Notices for the locked Cargo dependency
graph are under `assets/vendor/licenses/rust/`. CAJ is an independent component;
this notice does not make a legal determination about combined-work licensing.

## Dynamically downloaded runtime

The optional acquisition runtime is not bundled in the XPI. Its pinned Python,
uv, pip, ScanSci, and dependency-installation boundaries are described in
`docs/licensing/acquisition-runtime.md`. Runtime files are fetched from their
upstream sources into the user's Zotero Profile; they are not copied into this
repository or re-hosted by LitMTrans.

Zotero, MinerU, configured model services, and the projects listed as
`DESIGN_REFERENCE_ONLY` in the inventory are external services or references,
not bundled components.
