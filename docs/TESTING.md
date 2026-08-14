# 测试

## 源码检查

```bash
npm ci
npm run validate
npm run build
```

这些命令会编译 TypeScript，检查 JavaScript、XHTML 和插件元数据，运行离线 fixture 测试，并扫描不应发布的文件、个人路径和疑似密钥。

Windows 上可以直接启动三个兼容版本：

```powershell
npm run dev:7
npm run dev:8
npm run dev:9
```

每个命令都会完成验证和构建，然后启动该版本独立的 Zotero 测试 profile，不会修改日常文献库。VS Code 的“运行任务”菜单也提供三个对应任务；Ctrl+Shift+B 默认启动 Zotero 9。

Zotero 7 和 8 的固定版本运行时保存在 `.zotero-dev/versions/`。首次缺失时脚本会从 Zotero 官方下载；如果旧版目录被自动更新为其他主版本，下一次启动会从本地 ZIP 自动恢复。三个版本的 profile 和数据目录分别保存在 `.zotero-dev/compat/<版本>/`，禁止应用更新且互不混用。切换版本前先关闭当前测试窗口。

## 发布前手工检查

Windows 兼容基线为 Zotero 7.0.32、8.0.4 和 9.0.6，三个版本分别使用独立的 profile 和数据目录。每个 Release 至少检查：

- 全新安装、禁用、启用和重启 Zotero；
- 设置保存、Key 清空和重新填写；
- PDF 解析、流式翻译和排版翻译；
- 要点提炼、思维导图、流程图和文献对话；
- PDF 选区、引用跳转、图片与公式提问；
- 译文 PDF、排版附件和对照附件；
- 任务取消、网络中断和重新打开后的状态恢复；
- 从上一发行版升级，确认设置、Key 和已有结果仍可使用。

macOS 和 Linux 尚未完成完整回归。收到这些平台的问题时，应记录操作系统、Zotero 版本、插件版本和具体失败功能，不要只根据 XPI 能安装就判断兼容。

测试旧版 Zotero 时必须另建 profile 和数据目录。不要用 Zotero 9 已经打开过的测试数据库直接降级。
