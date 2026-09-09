# 更新日志

## 未发布 (Unreleased)

### 新增与优化

- **模型多模态归类记忆周期收敛**：将 `nonMultimodalModelMarks` 首选项的记忆周期由 7 天缩短至 **2 天（48 小时）**，并在初始化加载与写入时自动剪裁过期项，敏捷适应 DeepSeek 等大模型快速迭代多模态能力的交接期。
- **新用户干净测试环境（`Ctrl+Shift+N`）**：提供 `scripts/start-new-user.ps1` 与 VS Code 任务 / `npm run dev:new-user`，以空白新用户配置加载最新插件，退出时自动归档运行/崩溃日志至 `.zotero-dev/logs/new-user/` 并彻底清空临时数据，不留本地开发垃圾。
- **老用户更新体验环境（`Ctrl+Shift+O`）**：提供 `scripts/start-upgrade-test.ps1`、轻量级本地更新服务器 `scripts/serve-upgrade-server.mjs` 与对应任务 / `npm run dev:upgrade`。数据完全持久化保存在 `.zotero-dev/upgrade-test/`，初始预装官方 Release 版本，启动时后台推送本地构建的新版 XPI 与 `update.json` 供开发者检验升级体验与数据兼容性；退出后自动无损重置插件至 Release 基线（数据完全保留）。

## 2.0.0

这是 LitMTrans 的首个公开版本。

### 新增

- 在 Zotero 标签页中打开文献翻译与阅读工作台。
- 支持流式阅读和保留页面结构的排版阅读。
- 支持 OpenAI 兼容接口、DeepSeek 和 Gemini。
- 支持 Google 和 Bing 联网翻译。
- 支持文献对话、选文引用、公式与图片提问，以及附加参考文件。
- 支持全文要点提炼、思维导图和研究流程图。
- 支持解析结果、译文、对话记录和未完成任务的本地恢复。
- 支持当前译文的 PDF 导出。
- 排版阅读可识别 MinerU 普通文本块中的多层目录，并保持标题、点线和页码对齐。
- 排版阅读对 `code`/`code_body` 使用等宽代码块渲染，保留原始缩进和换行。
- 超过 200 页的 PDF 会在本地拆分、依次提交 MinerU，再按原页码合并布局、正文和图片。
- 长排版文献会卸载远离视口的图片，并按页面缓存排版测量结果。

### 安全与可靠性

- API Key 保存在 Zotero 使用的本地登录存储中。
- 文献解析和翻译使用暂存目录，任务失败不会覆盖上一份可用结果。
- 压缩包解压包含路径穿越、重复文件名、Unicode和长路径检查。
- 原文发生变化后，旧译文会停止作为当前结果使用。
- 保留旧版设置、密钥和缓存的兼容迁移。

### 变更

- 支持 Zotero 7、8 和 9。
- PDF 阅读交给 Zotero 自带 Reader，不在插件内重复实现阅读器。
- 不提供批量解析、批量翻译、本地机器翻译模型或 DOCX、HTML、Markdown 导出。
- 产品名称为 LitMTrans；源码仓库名称为 LitMTrans-Zotero。

安装和验证时请使用独立的Zotero测试配置，并按相关说明完成检查。
