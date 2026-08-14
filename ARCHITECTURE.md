# 代码结构

LitMTrans 把文档处理逻辑和 Zotero 界面代码分开。这样，大部分解析、翻译和缓存行为不启动 Zotero 也能测试。

```text
apps/zotero/、src/   Zotero 生命周期、设置、界面和 Reader 集成
          ↓
packages/            文档模型、翻译、排版、对话、MinerU 和模型调用
          ↓
运行时适配            文件、HTTP 和密钥存储
```

`packages/` 不应直接访问 Zotero、XUL、`window` 或 `document`。界面层只负责显示状态和转发操作，不应再实现一份解析、重试或缓存逻辑。

## 数据

`NormalizedDocument` 是解析、翻译、排版和对话共用的文档结构。它记录文档 ID、源文件指纹、页面、文本块、图片、公式和引用关系。原文变化后，旧译文仍保留在磁盘上，但不会被当作当前结果显示。

持久化内容位于 Zotero profile 的 `litmtrans/documents/<libraryID>-<attachmentKey>/`。解析和翻译先写暂存目录，完成后再替换正式结果；取消或失败不会覆盖上一份可用版本。

## 主要流程

- MinerU：上传附件、轮询任务、下载并校验 ZIP，然后整理页面和资源。
- 流式翻译：按 Markdown 结构分块，保留公式、图片和引用，再按原顺序合并。
- 排版翻译：使用稳定的 block ID 合并译文，根据原页面几何信息渲染；原始 PDF 始终交给 Zotero Reader。
- 文献对话：会话绑定文档和源指纹，引用保存页码、block ID 和相关图片或公式。

## 生命周期

插件启动时注册窗口、设置页、菜单和 Reader 入口；关闭或禁用时移除监听器、DOM 注入、observer、任务和全局引用。`src/ported-core.js` 是 `packages/` 的编译结果，必须在 `src/utils.js` 之前加载。
