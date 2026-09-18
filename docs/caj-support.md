# CAJ 支持范围与接入

当前支持标准 CAJ 内嵌 PDF、KDH、实际为 PDF 的 `.caj` 文件，以及知网早期 JBIG 位图压缩的 HN、C8 格式。TEB 会显示不支持提示，不生成附件。扩展名仅用于入口识别，转换分支以文件魔数为准。

- HN、C8 由随插件分发的 WebAssembly 转换模块（独立 Rust 组件，全平台可用）处理；其余格式由插件内 JavaScript 转换器处理，本地组件缺失时给出友好提示。
- 转换和 PDF 校验在独立后台线程执行；准备窗口显示当前阶段、已用时间及 HN/C8 的实际页面处理进度。多篇转换排队执行，每篇完成后释放线程和 WASM 内存。文字页共用一次加载的字体。
- 本地转换模块对 HN/C8 做容错：JBIG1 按 CAJViewer 的算术解码规则和 32 位行对齐解码，再归一化为 PDF 所需的 8 位行对齐；单色图像用顶端起始矩阵装配，避免正文上下颠倒。无渲染位图的页生成空白占位页以保持页数一致；多图层缺失布局信息时按垂直堆叠回退，保证转换不因个别异常页整体失败。
- 默认双击不拦截 Zotero 或其他插件；在“每次询问”中选择默认方式时，继续原始事件。
- 工作台使用原 CAJ 附件的文档 ID。转换结果位于 `<documents>/<libraryID>-<attachmentKey>/caj-source/source.pdf`，同目录的 `source.meta.json` 记录源文件身份、页数和阅读附件 ID。
- 存储数据管理器会将 `caj-source` 单独显示为“CAJ 转换与阅读缓存”，并展示格式、页数和占用空间。清空这一项或整篇文献缓存时，会同时移除 LitMTrans 自动创建的 Zotero 阅读附件。原 CAJ 附件和用户主动导出的 PDF 不受影响；仅清空 CAJ 转换缓存时保留翻译数据，清空整篇文献缓存则会删除解析、译文和对话记录。
- CAJ 缓存目录缺少普通解析用的 `document.json` 时，仍可依据 `<libraryID>-<attachmentKey>` 和 `source.meta.json` 参与占用统计、文献名称显示及失效文献清理。
- 缓存更新仅改写 `caj-source`，不删除或改写解析结果、译文和聊天记录。
- CAJ 转换缓存带独立版本号；转换器修复或升级后，旧的 `source.pdf` 会在下一次打开时自动重建，避免继续复用历史异常页面。
- 打开工作台时会为缓存 PDF 创建一个指向插件缓存的 Zotero 链接附件，标题带有“（LitMTrans）”。它只创建一次，不复制 HN 的大型 PDF；原 CAJ 保留，阅读和引用仍使用原 CAJ 的文档 ID。若 Zotero 版本没有链接附件 API，才退回导入副本。
- 右键“将 CAJ 转换为 PDF”仍创建可独立管理的正式 PDF 附件，并按源文件身份复用已有导出，避免重复添加。
- 内嵌阅读器通过 Zotero 原生 `openPreview` 和 `zotero://attachment/...` 文件路径加载缓存 PDF，不再跨进程传递整份字节流。CAJ 预览只读，文本选择、问答与引用定位沿用工作台接口。
- 标准 CAJ 的对象、对象流与交叉引用由已有 MIT 依赖 `pdf-lib` 处理；缺失页树根据 PDF 对象引用补全，并核对容器页数。CAJ 目录写入 PDF 大纲。
- KDH 解密后，从尾部选择具有 `startxref` 且指向交叉引用结构的最后一个 EOF；随后加载 PDF 检查页数，再写入缓存。

## 更新转换组件

在仓库根目录执行（需安装 Rust 及 `wasm32-unknown-unknown` target）：

```powershell
cargo build --manifest-path native/caj-backend/Cargo.toml -p litmtrans-wasm --target wasm32-unknown-unknown --release --locked
Copy-Item native/caj-backend/target/wasm32-unknown-unknown/release/litmtrans_wasm.wasm native/dist/caj2pdf/caj2pdf.wasm -Force
```

转换输出发生变化时同步递增 `src/controller.js` 的 `CAJ_CACHE_VERSION`。这只重建转换 PDF，保留已有解析、翻译和对话数据。
