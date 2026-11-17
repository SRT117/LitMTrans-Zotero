# 参与开发

欢迎提交 Issue 和 Pull Request。提交前建议先检索是否已有同类问题或方案；单次改动尽量聚焦具体问题或功能。

## 本地检查与构建

```bash
npm ci
npm run validate
npm run test:runtime
npm run build
# Windows 打包 XPI
npm run build:windows
```

`npm run validate` 会执行 TypeScript 编译、JS 语法检查、XHTML/清单校验、npm 生产依赖许可证审计、全部离线运行时测试，以及敏感路径与疑似密钥扫描。

## Zotero 隔离测试环境（Windows）

请始终使用项目提供的隔离测试库，**切勿修改日常 Zotero 配置或文献库**：

- `npm run dev`（或 `dev:7` / `dev:8` / `dev:9` / `dev:10`）：快速同步源码并在对应版本的隔离测试库中启动 Zotero。
- `npm run dev:new-user`：以无 Key、无缓存的纯净新用户状态启动最新构建，关闭后自动清理临时数据并归档日志。
- `npm run dev:upgrade`：预装上一正式发行版并推送本地未发布构建，用于验证升级提示与老用户数据兼容性。

## 提交与数据安全规范

- 涉及 Zotero UI、Reader、文件读写或外部服务的改动，请在 PR 中写明验证过的 Zotero 版本、操作系统和具体功能；未验证的场景请如实说明。
- 严禁提交个人文献 PDF、Zotero Profile、缓存、日志、`.env`、API Key 或 `dist/` 构建产物。
- 新增随包字体、第三方库或运行时下载模型时，须同步更新 `THIRD_PARTY_NOTICES.md`、`docs/licensing/` 及 `assets/vendor/licenses/` 下的许可证文件。
- 涉及用户数据与本地缓存格式的改动，须保证老用户已有缓存与个人批注可无损兼容。

小型文档修正无需运行完整测试；欢迎先提交可讨论的草案方案。
