# Paddle 行信息补充

PaddleOCR-VL 继续负责内容、公式和块 ID。`src/paddle-lines.js` 只为排版补充行位置，不拆分原始 `lines`，不改写解析文件和翻译缓存。MinerU 保持原有处理路径。

## 数据路径

1. 用 Zotero 自带 PDF.js 提取文字片段，在 Paddle 的文字块内按基线组行。片段只归属一个块，左右栏不合并。
2. 先按整篇 PDF 判断文字层：忽略页面顶部和底部各 8% 的边缘文字，存在至少一页具有 60 个正文字符和两行文字时，不自动调用 OCR。个别块匹配不足不触发 OCR；整篇均缺少可用文字层时，才为缺失的较长正文或参考文献块调用文字 OCR。每批最多 20 页，关闭旋转和展平，保留原页映射。
3. 以正文文字建立行基线，将孤立公式符号附到附近的行。保留整行公式及末行年份，不把积分上下限当成新行。
4. 运行时应用行数、行框、缩进、字号和行距依据。符号释义表的语义识别及跨栏译文拆分不由该补充数据决定。

短标签缺失不会单独触发云端 OCR。有可用文字层的扫描页直接复用文字层。混合文档不自动调用 OCR；阅读工具栏提供“补充文字识别”，由用户主动为缺失的块补充行信息，保留已有解析和译文。

## 缓存与更新

文档目录新增 `line-geometry.v1.json`、`paddle-line-task.json` 和 `compiled-model.paddle-lines.v1.json`。行缓存绑定 PDF 路径、大小、修改时间、解析修订和解析内容；显示缓存及浏览器排版快照同时绑定行信息指纹。原始编译缓存保留。

OCR 失败时使用已有行数据及原排版，任务取消时不发布结果。已提交任务可继续查询；重新解析或文件变化时拒绝发布过期结果。失败后的后续请求可以重试，已完成的行缓存不因 OCR 模型更新而失效。

`docs/parser-models.json` 的 `paddleOCR` 条目与 `paddle` 分别校验并更新，复用现有更新清单。内部首选项为 `paddleOCRModel`、`paddleOCRModelCatalogRevision`；默认 `PP-OCRv6`。只接受文字 OCR 模型名称及已支持的 API/结果协议，每个任务固定启动时的模型。协议不变时更新目录即可；协议变化需要新驱动。

## 验证

`tests/suites/12-paddle-lines.js` 覆盖公式上下限、整行公式、末行年份、左右栏归属、正常 PDF 匹配失败不调用 OCR、扫描件仅有原生页眉页脚、混合文档手动补充、模型固定、旧缓存保留、取消及解析修订竞态。`npm run validate` 包含该测试。

隔离 Zotero 10 可执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-dev-diagnostics.ps1 -Operation paddle-lines-probe -ZoteroMajor 10 -SourceAttachmentKey XMNRNTLL
```

加 `-PrintPDF` 可打开工作台并导出实际排版预览。诊断会检查原始解析、译文及旧编译缓存未被改写，并记录首次补充与缓存复用耗时。只在项目的隔离测试库运行。
