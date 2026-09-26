# 首次公开发布指南

这份清单用于把当前本地仓库发布为 `SRT117/LitMTrans-Zotero`，发布首个 `v2.0.0`，并申请加入 Zotero Add-on Market。插件 ID `litmtrans@srt117.github.io` 已经定稿，后续版本不要更换，否则已有用户无法收到更新。

Zotero 插件以 XPI 分发，不需要购买代码签名证书。项目使用 MIT License，随包第三方组件和字体的许可证已经收录在 `THIRD_PARTY_NOTICES.md` 及对应资源目录中。

## 1. 可选：补 README 截图

README 已预留三个隐藏的截图位置。没有截图也不会在 GitHub 页面显示占位提示。准备好图片后保存为：

```text
docs/images/overview.png
docs/images/translation.png
docs/images/research-tools.png
```

然后在 `README.md` 中找到相应注释，取消图片行的注释并提交。

## 2. 创建并推送 GitHub 仓库

在项目根目录运行：

```powershell
gh auth status
gh repo create SRT117/LitMTrans-Zotero --public --source=. --remote=origin --push
```

不要在 GitHub 网页上预先添加 README、`.gitignore` 或 License，避免产生无关的初始化提交。如果选择先在网页创建仓库，请创建完全空的公共仓库，然后运行：

```powershell
git remote add origin https://github.com/SRT117/LitMTrans-Zotero.git
git push -u origin main
```

推送后设置仓库简介与 Topics：

```powershell
gh repo edit SRT117/LitMTrans-Zotero `
  --description "全文对照翻译、AI对话、思维导图、智能体MCP、Markdown转换、公式Latex提取" `
  --add-topic zotero `
  --add-topic zotero-plugin `
  --add-topic translation `
  --add-topic pdf `
  --add-topic mind-map `
  --add-topic llm
```

在仓库的 **Settings** 中确认：

- **Issues** 已启用；
- **Security → Private vulnerability reporting** 已启用；
- 默认分支是 `main`。

## 3. 发布 v2.0.0

确认 GitHub 上的 `main` 已经包含准备发布的内容，然后创建并推送版本标签：

```powershell
git tag -a v2.0.0 -m "LitMTrans 2.0.0"
git push origin v2.0.0
```

标签会触发 GitHub Actions 中的 **Release Zotero add-on** 工作流。它会重新安装依赖、验证源码、构建 XPI、计算 SHA-256、生成 `update.json`，并创建 Draft Release。

等待工作流成功后，打开仓库的 **Releases**，检查草稿：

- 标题为 `LitMTrans v2.0.0`；
- 包含且只包含一个可安装 XPI：`litmtrans-2.0.0.xpi`；
- 包含 `update.json`；
- 不是 Pre-release；
- 自动生成的发行说明没有敏感信息或无关开发记录。

确认后点击 **Publish release**。不要在工作流失败时手工发布不完整的草稿，也不要把其他版本的 `update.json` 混入 Release。

发布后在未登录状态或隐私窗口检查：

```text
https://github.com/SRT117/LitMTrans-Zotero/releases/latest
https://github.com/SRT117/LitMTrans-Zotero/releases/latest/download/update.json
```

再下载 XPI，在隔离的 Zotero profile 中完成一次安装、重启和核心功能检查。自动更新的端到端升级链路可在本地直接运行 `npm run dev:upgrade`（或按快捷键 `Ctrl+Shift+O`）进行全流程实测验证。

## 4. 同步 Gitee 国内更新渠道

Gitee 公共仓库为 `https://gitee.com/SRT117/LitMTrans-Zotero`。在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加 Secret：`GITEE_ACCESS_TOKEN`。

正式发布 GitHub Release 后，`Publish Gitee update channel` 工作流会自动同步源码和 Tag、创建 Gitee Release、上传 XPI，并更新：

```text
https://gitee.com/SRT117/LitMTrans-Zotero/raw/main/update.json
```

发布后确认该地址返回 JSON，且 Gitee Release 中的 XPI 可以在未登录状态下载。插件会优先尝试 Gitee，GitHub 仍作为备用渠道。

## 5. 申请加入中文插件市场

`zotero-chinese/zotero-plugins` 已暂停接收新插件。新插件应提交到：

```text
https://github.com/syt2/zotero-addons-scraper
```

操作步骤：

1. Fork `syt2/zotero-addons-scraper`。
2. 在 Fork 的 `addons/` 目录选择 **Add file → Create new file**。
3. 文件名填写：

   ```text
   SRT117@LitMTrans-Zotero
   ```

4. 文件内容填写：

   ```json
   {"tags":["ai","reader"]}
   ```

5. 提交修改，并向 `syt2/zotero-addons-scraper` 的 `master` 分支创建 Pull Request。
6. PR 标题可使用 `Add SRT117/LitMTrans-Zotero`。

市场会读取公开仓库及 GitHub Release。提交 PR 前最好确认仓库为 Public、正式 Release 已发布、XPI 能公开下载，且 `manifest.json` 中的主页和更新地址有效；如果有一项还没准备好，也可以先开 PR 讨论。

## 6. 后续发版

每次发布都要：

1. 同步修改 `manifest.json`、`package.json` 和 `package-lock.json` 的版本号。
2. 更新 `CHANGELOG.md`。
3. 在 `src/release-notes.js` 中更新对应版本的工作台更新条目，确保离线也能展示本次变化。
4. 运行 `npm ci`、`npm run validate` 和 `npm run build:windows`。
5. 在隔离 Zotero profile 中完成必要的手工测试。
6. 提交并推送代码，再推送与版本一致的标签，例如 `v2.0.1`。
7. 检查 GitHub Actions 创建的 Draft Release，确认后再正式发布；发布后等待 Gitee 同步工作流完成。

保留旧 Release 和旧 XPI，不要覆盖已经发布的文件。发布后确认 `releases/latest/download/update.json` 指向最新正式版本。
