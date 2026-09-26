# Agent、MCP 与文献获取状态

截至 2026-09-24。本分支处于 release-candidate 收尾：不再增加功能、不重构 CAJ、不改变 MCP 主协议。

## Current Status

- Agent/MCP、Literature、Acquisition 和目标化 Managed Runtime 已实现。
- ScanSci Institution Bridge 会先脱敏结果，再把 `success:false` 或 `error` 统一映射为 `status:"failed"`；登录和访问分别使用稳定错误码。
- Windows x64 的 Zotero clean-profile 获取闭环已 field-validated，包括托管运行时安装、PDF 校验与附件导入、正常关闭及重启复用。
- MIT 表示 LitMTrans 自有代码许可；第三方组件保留各自许可。清单见 [`docs/licensing/third-party-inventory.md`](licensing/third-party-inventory.md)，摘要见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

## Validated

- Windows x64：Python 3.13.15、ScanSci 1.17.0 / MCP 2.2.0；真实 PDF 获取并导入 Zotero，运行时与附件可复用。
- 官方 `@modelcontextprotocol/client@2.0.0`：隔离 Zotero endpoint 返回 107 个工具；资源读取和 elicitation/MRTR 审批通过；本地网络 stub 调用数为 0。
- Linux ARM64 A1：uv 0.12.18、Python 3.13.15、ScanSci `tools/list` 和 OA 获取通过；这不代表 Zotero Linux 宿主已验证。
- 2026-09-24 离线验收：运行时 10 suites / 155 tests、`npm run validate`、Windows XPI 构建及许可证打包检查通过。

## Platform Matrix

| 目标 | 核心/MCP/OA | 托管 ScanSci | 验证边界 |
| --- | --- | --- | --- |
| Windows x64 | 可用 | 可用 | Zotero clean-profile 获取、附件导入、关闭和重启复用已 field-validated |
| Linux ARM64 GNU | 适配器可用 | 适配器可用 | A1 runtime/ScanSci/OA 已验证；Zotero Linux 宿主未验证 |
| Windows ARM64、macOS arm64/x64、Linux x64 GNU | 适配器已实现 | 适配器已实现 | 尚未 field-validated |
| Linux musl、未知 ABI、32-bit | 核心可运行 | 不提供托管 runtime | 降级到已有附件/OA/Translator；未知 ABI 不推断为 GNU |

## Known Limitations

- 一次独立 ScanSci smoke 在调用 MCP/OA 工具前，代理 arXiv 预检 `ReadTimeout`、0 bytes；不计成功，也未重复运行。Windows clean-profile E2E 独立验证过真实获取成功。
- uv launcher 的 Astral-first/GitHub-fallback 顺序有 manifest/fixture 覆盖；A1 有安装成功记录，但当次 Python artifact 的实际请求 URL 未留存，故不声称已核实镜像重写行为。
- 无 Reader 的本地 PDF 页面渲染仍是 fallback；隔离 Zotero 曾报告 PDF.js 原型冻结或缺少 `pdftoppm`，此路径未宣称 production-ready。
- 不保证所有来源均可取得全文，也不自动生成免人工核验的最终综述。MinerU 深度解析配额与 CAJ 原件不属于已验证的获取闭环。

## Historical Milestones

- 2026-09-22：完成 AgentFacade、MCP modern/legacy 接口、审批、Literature/Review Workspace、Zotero 写入与客户端配置基础；官方 SDK smoke 通过。
- 2026-09-23：完成 Windows x64 managed runtime 与 ScanSci 获取闭环；Linux ARM64 完成 runtime/ScanSci/OA 验证。
- 2026-09-24：修复 Institution Bridge 失败状态映射；完成离线测试、静态验证及 XPI/许可证打包验收。
