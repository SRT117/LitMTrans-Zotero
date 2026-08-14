# 参与开发

Issue 和 Pull Request 都欢迎。提交前如果方便，可以先搜索是否已有相同问题；一次改动尽量聚焦，但不必为了拆分而拆分。

## 本地检查

```bash
npm ci
npm run validate
npm test
```

Windows 用户可以运行 `npm run dev`，在隔离的 Zotero profile 中加载当前源码。建议不要用日常文献库测试开发版。

涉及 Zotero UI、Reader、文件读写或外部服务的改动，如果测试过，欢迎在 PR 中写明 Zotero 版本、操作系统和功能；没有条件验证的场景直接说明即可。

请不要提交用户文献、Zotero profile、缓存、日志、API Key 或构建产物。新增随包字体或第三方库时，最好一并更新 `THIRD_PARTY_NOTICES.md` 和许可证文件。

小型文档修正不必运行完整测试；欢迎先提交不完整但可以讨论的方案。
