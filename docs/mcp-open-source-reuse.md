# Agent/MCP 开源复用审计

本轮审计基于当前 `feat/agent-mcp` 工作区和本机参考仓库。目标是复用成熟的 Zotero 通用基础能力，同时保留 LitMTrans 已经验证的 2026-07-28 modern protocol、2025 legacy compatibility、MRTR、AgentFacade、Artifact、Background AI、Batch、Corpus 和 DiagramCache。

本机参考 clone 的 remote 为 `https://github.com/cookjohn/zotero-mcp.git`，审阅时 HEAD 为 `81d0777b49ded0959d197c7610d8b6e5f32c2485`、工作区干净，reflog 显示该 clone 从此提交创建。该证据能确认当前审阅的参考版本，但不能证明历史移植时使用的 checkout；因此移植时的精确来源提交仍记为未记录。

## 许可证边界

本表涉及的 `cookjohn/zotero-mcp` 文件均为 MIT License。只有实际移植实现的模块才在 `THIRD_PARTY_NOTICES.md` 登记原仓库、原文件、版权和适配文件；只参考行为或接口的模块不复制源码。

## 模块对照

| LitMTrans 模块 | 原实现 | 参考项目 / 文件 | 参考实现覆盖的边界 | 处理 | 移植原因 | 保留 LitMTrans 差异 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HTTP reader | `src/agent/mcp/http-request-reader.js`，由 server 调用 | cookjohn `httpRequestReader.ts`，275 行 | byte-level framing、CRLFCRLF、UTF-8 split、Content-Length bytes、增长缓冲区、截断/上限/等待/trailing bytes | `DIRECT_PORT` 的 JavaScript 适配，已完成 | 当前实现会反复 concat 全部缓冲；参考实现边界更完整 | 保留 loopback、Host/Origin、2026 headers、Mcp-Name、HeaderMismatch、411 policy 和大响应 writer | 已加入 runtime：ASCII、中文、跨 chunk、截断、超限、无 framing、chunked 411 |
| Zotero 写入 | `library-service.js` 的 `saveWithNotifier` / 各写入口 | cookjohn `deferredNotifierCommitter.ts`，178 行 | serialized writes、slow observers、foreground wait、shutdown flush、pending/error isolation | `DIRECT_PORT` 核心 coordinator，`ADAPT` 服务调用，已完成 | 多 Agent 并发写入需要单一队列 | 保留现有 item/collection/annotation API 和事务语义 | 已加入 runtime：并发顺序、flush、错误隔离 |
| Search | `library-service.js` `searchItems` | cookjohn `searchEngine.ts`，1090 行；`fulltextService.ts` | field queries、range/operator、relevance、fulltext/note、sorting/pagination、yield | `ADAPT`，已完成字段/算子/相关性/分页和 Zotero 原生全文回溯 | 参考实现的筛选和全文边界更全面 | 保留 LitMTrans 状态 join、敏感路径脱敏和现有 MCP 单 tool | 已覆盖 title、creator、原生 attachment fulltext、note、language、fieldQueries、relevance、tag mode 和范围 |
| Item formatter | `src/agent/item-formatter.js` + `itemRecord` | cookjohn `itemFormatter.ts`，341 行 | type-aware fields、creators/tags/notes/attachments、safe getField、content type/size/text state、per-item isolation | `ADAPT`，已完成 | 直接提升字段完整性和容错 | 默认不返回 absolute path；保留 LitMTrans status 和 attachmentKey | 已覆盖字段、creator、note、attachment metadata、缺失字段 |
| Collection formatter | `src/agent/collection-formatter.js` + `collectionRows` / `collectionRecord` | cookjohn `collectionFormatter.ts`，156 行 | path/depth、brief/list/tree/details | `DIRECT_PORT` 结构，`ADAPT` 状态字段，已完成 | 避免两套 hierarchy logic | 保留完整分页和 LitMTrans 状态 | 已覆盖深层级、父级、brief；tree/details 由 formatter contract 保持 |
| Annotation | `src/agent/annotation-formatter.js` + `listAnnotations` / `createAnnotation` / `updateAnnotation` | cookjohn `annotationService.ts`，715 行 | note/annotation fallback、page/position/type/text/comment/color/tags/sort、search/filter/pagination | `ADAPT` 成熟 normalize/filter/sort，已完成 | Zotero 数据兼容分支更全面 | 保留 block/figure/formula/table locator，写入继续使用 coordinator | 已覆盖 highlight/note、position/page/tags/pagination、document locator |
| Import / Citation | `import-service.js`、`citation-service.js` | cookjohn identifier/import handlers；54yyyu citation/import tools | Translator-first、DOI/title dedupe、native Cite/export、fallback backend | `KEEP_LITMTRANS` with targeted `ADAPT` | 当前已有 Translator/Cite 优先和 backend 标记 | 保留现有 fallback 和 privacy contract，不复制 Python parser | DOI、URL、BibTeX、CSL、duplicate、bibliography |
| Client registry | `src/agent/mcp/client-config.js` | cookjohn `clientConfigGenerator.ts`，417 行 | 多客户端 display/config/render/instructions | `ADAPT` registry，已完成并扩展到 13 个入口 | 复用成熟客户端覆盖面，但重新核对当前官方格式 | 普通 UI 不显示 client selector；新增自然语言 bootstrap；模板与已核对入口明确区分 | registry、官方 CLI/HTTP 格式、共存、bootstrap |
| MCP protocol | `protocol.js` | MCP TypeScript SDK v2；cookjohn streamable server | SDK authoritative modern/MRTR | `KEEP_LITMTRANS` | 当前实现已真实通过 modern/MRTR | 不引入旧 initialize/session 作为 modern 主链路 | SDK live、legacy、MRTR |
| 普通 Agent UX | 当前两处设置各自暴露技术选项 | cookjohn UI 仅作 backend 参考 | 连接配置展示 | `DO_NOT_PORT` UI | 参考 UI 面向技术用户，不符合 LitMTrans 产品原则 | 普通模式只显示开启、状态、连接提示和复制给智能体；技术选项收进开发者设置 | DOM contract、真实连接状态 |

## 复用顺序

1. HTTP reader contract 和 Zotero write coordinator：已完成，不改变 MCP protocol。
2. formatter、search、annotation 适配：已完成第一轮，保持 LitMTrans 状态和 locator。
3. client registry、bootstrap instruction、recent client tracking 和两处普通用户视图：已完成。
4. runtime/validate、隔离 Zotero live smoke 和 Windows build 已通过；仓库最终提交仅在本地创建，不推送。

## 官方客户端格式核对

本轮按当前官方文档核对了已标为 `verified` 的入口：

- [Codex MCP](https://developers.openai.com/codex/mcp/)：Streamable HTTP 使用 `codex mcp add <name> --url <url>`，配置文件使用 `mcp_servers.<name>.url`。
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)：HTTP 使用 `claude mcp add --transport http <name> <url>`，JSON 必须显式包含 HTTP 类型。
- [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)：使用 `mcp.json` 的 `mcpServers`，支持 Streamable HTTP。
- [Gemini CLI 配置](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)：`mcpServers.<name>.httpUrl` 表示 Streamable HTTP；配置同时支持 `url`、`httpUrl`、stdio。
- [Cline MCP](https://docs.cline.bot/mcp/mcp-overview)：推荐的远程格式为 `type: "streamableHttp"`，但本项目只将其标为模板，未宣称 CLI 已验证。

## 最终 UX 验收标准

普通用户只看到“AI 助手连接”、开启开关、连接状态、连接提示和“复制给智能体”。端口、URL、MCP、JSON、TOML、transport、协议版本、客户端选择和 raw config 只出现在开发者设置。复制内容可以包含真实 endpoint 供智能体使用，但界面不显示它；复制文本要求保留已有 `zotero-mcp`，只新增或更新 `litmtrans`，随后调用 `litmtrans_get_capabilities` 验证。
