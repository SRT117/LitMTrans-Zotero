# Third-Party Notices

## Source Han Serif CN

The plugin bundles `SourceHanSerifCN-Regular.ttf` (Source Han Serif CN,
Version 2.003) for translated-document reading and retained-layout rendering.
It is supplied unmodified from the [Adobe Source Han Serif project]
(https://github.com/adobe-fonts/source-han-serif) under the SIL Open Font
License 1.1. The complete license is included at
`assets/fonts/LICENSE-SourceHanSerif.txt`.

## KaTeX

The plugin bundles KaTeX JavaScript, CSS, and fonts for offline mathematical rendering.

KaTeX is licensed under the MIT License:

> Copyright (c) 2013-2020 Khan Academy and other contributors

The complete MIT license is included at `assets/vendor/katex/LICENSE.txt`.

## Pako

The plugin bundles Pako 2.1.0 as a portable fallback for DEFLATE-compressed
MinerU result archives. Pako is licensed under the MIT License; the complete
license is included at `assets/vendor/pako/LICENSE.txt`.

## pdf-lib

The plugin bundles pdf-lib 1.17.1 to copy pages into local, temporary PDF
parts when a source exceeds MinerU's 200-page upload limit. pdf-lib is
licensed under the MIT License; the complete license is included at
`assets/vendor/pdf-lib/LICENSE.md`.

## caj2pdf-rs

The plugin bundles `native/caj2pdf/caj2pdf.wasm`, a WebAssembly conversion
module built from [caj2pdf-rs](https://github.com/duststarr/caj2pdf-rs), to
convert archived CNKI HN/C8 (JBIG-compressed scan) CAJ documents into PDF so
they can be opened in the workbench. The module runs inside the plugin on all
supported platforms and is licensed under GPL-2.0-or-later; the source of the
locally modified fork lives in `native/caj-backend/` and the complete license
is included at `native/caj2pdf/LICENSE`.

## Mermaid

The plugin bundles Mermaid 11.16.1 for local flowchart layout and SVG
rendering. Mermaid is licensed under the MIT License; the complete license is
included at `assets/vendor/mermaid/LICENSE`.

## External services and host

Zotero, MinerU, and user-configured model services are not bundled components. Their names, services, trademarks, and software remain subject to their owners' terms and licenses. The plugin does not distribute MinerU/model source code, model weights, online/local machine-translation code, or Word/DOCX/HTML/Markdown export toolchains.
