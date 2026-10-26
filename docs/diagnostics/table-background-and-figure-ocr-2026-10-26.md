# 表格底色与图片内文字实测

日期：2026-10-26。宿主：Windows 隔离 Zotero 10，`.zotero-dev/compat/10.0/profile`。不修改日常 Zotero 文库或配置。

## 案例与真实服务

生成两页受控 PDF，位于 `output/pdf/table-background-case/source.pdf`。第一页为无文字层的扫描页，包含内容相同的黄褐色、深蓝灰、白底表格；每表 5 行、3 列。第二页为嵌入位图的流程图和统计图，图注刻意不含图内标签。源 PDF、译文 PDF、对照 PDF 及渲染预览均保留在同一输出目录。

同一源 PDF 分别导入隔离库的两个新附件，通过现有 `pipeline.parse` 和 `pipeline.translateLayout` 运行真实解析、翻译，通过工作台打印快照生成 PDF。模型单次覆盖为 `gemini-3.5-flash-lite`，不改全局翻译提供商、模型首选项。

| 解析服务 | 模型 | 隔离文档 ID | 结果 |
| --- | --- | --- | --- |
| MinerU | `vlm`，OCR/table/formula 开启 | `1-CE8DLSVB` | 3 表均翻译并显示 |
| Paddle | `PaddleOCR-VL-1.6`，现有默认解析参数 | `1-JGYDXP99` | 3 表均翻译并显示 |

两份译文元数据的 provider 为 `gemini`、model 为 `gemini-3.5-flash-lite`、targetLanguage 为 `简体中文`，正文与表格均完成。输出为 `mineru-translation.pdf`、`mineru-comparison.pdf`、`paddle-translation.pdf`、`paddle-comparison.pdf`，均为原文两页对应的译文或逐页左右对照。

## 底色结果

用 PyMuPDF 渲染实际生成的 PDF，在原表内部采样，比较背景 RGB 中位值：

| 表格 | 源 PDF | MinerU + Gemini 译文 PDF | Paddle + Gemini 译文 PDF |
| --- | --- | --- | --- |
| 黄褐色 | `(175,150,96)` | `(175,150,96)` | `(175,150,96)` |
| 深蓝灰 | `(37,51,66)` | `(37,51,66)` | `(37,51,66)` |
| 白色 | `(251,251,251)` | `(251,251,251)` | `(251,251,251)` |

实际渲染检查确认三表均显示中文译文，深色表格使用浅色文字与边框，黄褐色表格没有白底覆盖。JSON 证据位于 `result.json` 和 `pdf-color-verification.json`。该案例验证整表主色，不证明逐格底纹或扫描纹理已恢复。

## 图片内文字：默认返回

- MinerU：第二页 `model.json` 的 `image` 和 `chart` 块 `content` 均为 `null`，布局中的图主体只有图片引用。统计图标题 `Treatment response` 被单独识别为图注，有坐标；流程图内部六个标签及统计图内部的轴标签等未返回为文字。不能把图注识别等同于图内完整 OCR。
- Paddle：原始返回 `model_settings.use_ocr_for_image_block=false`、`use_chart_recognition=false`。`image` 和 `chart` 的 `block_content` 均为空，保留整图框及图注。

检查包括原始服务结果，而不只检查插件投影后的阅读模型。用于复核的脱敏摘录为 `mineru-default-page2.json`、`paddle-default-page2.json`。

## Paddle 可选参数与文字 OCR

额外向现有 Paddle jobs API 提交同一 PDF，不覆盖上面的解析或翻译缓存：

1. `PaddleOCR-VL-1.6` 同时设置 `useOcrForImageBlock=true`、`useChartRecognition=true`。返回的设置确认两者生效。流程图 `block_content` 包含六个标签，包括 `IMAGE TEXT 7319`，但坐标仍只有整图框，没有逐行标签坐标。统计图返回 `Category | ACCURACY / Stable growth | 87% / Control | 61%`，把独立标注 `Stable growth` 当成分类，遗漏真实分类 `Treatment`；因此图表理解结果不能直接作为准确的图内逐字替换依据。
2. `PP-OCRv6` 使用现有文字 OCR 的参数，返回 `rec_texts`、`rec_polys`、`rec_scores`、`rec_boxes`。第二页共 21 行，流程图六个标签全部识别，并给出对应多边形。统计图读出 `Control`、`Treatment`、`ACCURACY`、`61%` 及刻度，漏掉相邻的 `87%` 和 `Stable growth`。不是完整识别所有图中文字。

证据为 `paddle-image-ocr-enabled-page2.json`、`paddle-ppocr6-page2.json`、`figure-ocr-verification.json`；定位预览为 `figure-ocr-line-boxes.png` / `.pdf`。摘录不包含访问令牌或带鉴权参数的资源 URL。

官方参数说明：[PaddleOCR-VL 文档](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.en.md)，其中 `use_ocr_for_image_block` 默认关闭；[官方 API SDK 文档](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/serving/paddleocr_official_api/python.en.md) 区分文档解析和文字 OCR 模型。上面的开启结果来自真实在线 API 测试。

## 下一步的实现边界

图片翻译可以优先复用现有 Paddle 文字 OCR 通道，按图框筛选逐行文字与多边形，再交给 Gemini 翻译，并在运行时做局部擦字和译文覆盖。整图分类和图形像素继续保留；识别缺失、空间不足或无法安全擦除时保留原图。图内译文应独立缓存，不改已有解析数据或原图片。此次没有实现图片翻译，也没有将额外 OCR 探测写入两篇文献的原始缓存。
