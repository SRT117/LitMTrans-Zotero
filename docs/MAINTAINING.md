# 开源后的维护

LitMTrans 是个人项目，不需要承诺随叫随到。README 写清支持范围，Issue 能正常反馈，发布版能更新，就已经够用了。

## 首次公开与市场收录

- GitHub 公共仓库使用 `SRT117/LitMTrans-Zotero`，不要修改已经公开的插件 ID `litmtrans@srt117.github.io`。
- 首次推送前检查源码和完整 Git 历史，不得包含 API Key、论文、日志、Zotero profile 或构建产物。
- 推送 `v2.0.0` 标签后，发布工作流会创建 Draft Release；检查 XPI 和 `update.json` 后手动正式发布。
- 正式 Release 必须包含且只包含一个待安装的 `litmtrans-*.xpi`，草稿 Release 不会被 Zotero 或市场作为最新版本使用。
- 中文插件市场的新插件提交到 `syt2/zotero-addons-scraper`：新增无扩展名文件 `addons/SRT117@LitMTrans-Zotero`，内容为 `{"tags": ["ai", "reader"]}`。

## 平时要做的事

- 回复能够复现的问题；信息不足时，请对方补充 Zotero 版本、系统和操作步骤。
- 不要让用户在公开 Issue 中上传 API Key、论文全文或未经处理的日志。
- 修复影响启动、数据、Key 或自动更新的问题时，尽快发布补丁版本。
- 新功能按自己的时间安排。可以直接关闭不符合项目方向的请求，并简单说明原因。

## 每次发布

- 更新版本号和 `CHANGELOG.md`。
- 跑完自动测试和隔离 Zotero 手工检查。
- 先检查 Draft Release，再正式发布。
- 保留旧 Release，不要覆盖已经发布的 XPI。
- 发布后确认 `releases/latest/download/update.json` 可以公开访问。

## 偶尔检查

- 查看 Dependabot 或 `npm audit`，优先处理会进入 XPI 的依赖问题。
- Zotero 7、8、9、10 的兼容修复应分别复查；新的大版本进入 Beta 后，用独立 profile 测试，确认核心功能仍可用。发布清单不设置最高版本上限。
- 检查中文插件市场是否仍能读取最新版本和下载链接。
- 如果暂时没有时间维护，在 README 顶部说明，不必默默承担无限期支持。

## 不需要负责的事

MIT License 不要求免费提供技术支持，也不保证软件适合所有文献、模型服务或操作系统。维护者需要做的是不误导用户：已测试的平台就写已测试，没测过的就写尚未验证，发现涉及数据或密钥的严重问题时及时提醒用户。
