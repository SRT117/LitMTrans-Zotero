# 参与开发

Issue 和 Pull Request 都欢迎。提交前请先搜索是否已有相同问题，并尽量让一次改动只解决一件事。

## 本地检查

```bash
npm ci
npm run validate
npm test
```

Windows 用户可以运行 `npm run dev`，在隔离的 Zotero profile 中加载当前源码。不要用日常文献库测试开发版。

涉及 Zotero UI、Reader、文件读写或外部服务的改动，请在 PR 中写明测试过的 Zotero 版本、操作系统和功能。没有条件验证的场景直接说明即可。

不要提交用户文献、Zotero profile、缓存、日志、API Key 或构建产物。新增随包字体或第三方库时，请一并更新 `THIRD_PARTY_NOTICES.md` 和许可证文件。
