# LitMTrans Agent Literature Research Backend

本文件记录文献研究后端的产品边界、数据契约和当前可验证状态。实现目标是让智能体围绕研究问题完成“发现候选文献—去重与导入—获取并验证 PDF—交给现有 MinerU 解析—按证据检索—形成综述工作区”的连续流程；MCP 只是连接层，普通用户不需要了解 Provider、端口、JSON、Python 或外部服务名称。

## 当前生产收口（2026-09-23）

全文获取只要 `acquireFullText=true` 且存在候选，就统一返回可持久化父 Job；`parse=true` 时由同一个父 Job 申请一次 MinerU 审批并创建带 parent linkage 的解析子 Job，`parse=false` 也不再同步阻塞。父 Job 的阶段为 `prepare-runtime → resolve → download → validate → import → parse → complete`，取消会传递到 HTTP、ScanSci 进程和 staging 清理路径，重试只重启对应父/子任务上下文。

机构访问通过高层 `litmtrans_fulltext_access` 暴露 `status`、`schools`、`login`、`retry`；不暴露 ScanSci 的低层工具名、Cookie 文件、密码或令牌。学校选择和网页登录仍由用户完成，工具只返回脱敏状态及下一步动作。工具列表会依据 ScanSci `tools/list` 的真实能力动态显示机构入口。

托管运行时采用目标描述和 `RuntimeAdapter`。当前实际支持矩阵如下：

| 目标 | LitMTrans 核心/MCP/OA 直链 | 托管 ScanSci | 现场证据 |
| --- | --- | --- | --- |
| Windows x64 | 支持 | 支持 | 已验证 Windows x64 插件驱动的干净 Profile E2E：冷安装、真实 ScanSci PDF、Zotero 附件、正常退出与重启复用 |
| Windows arm64 | 支持 | 适配器已建立，未 field-validated | 未宣称 |
| macOS arm64/x64 | 支持 | 适配器已建立，未 field-validated | 未宣称 |
| Linux x64/arm64（明确 GNU/glibc ABI） | 支持 | 适配器已建立，未 field-validated | A1 Ubuntu ARM64 已验证运行时、ScanSci MCP 与 OA 下载；未验证 Zotero Linux 宿主 |
| Linux musl、未知 ABI / 32-bit | 核心可继续运行 | 不提供托管运行时 | 明确降级为 OA/现有附件/Translator |

运行时平台信息来自 Zotero/Gecko Services.appinfo 和 Zotero 标志，不使用插件宿主中的 Node process.platform/process.arch。CAJ 仍是独立冻结边界。

Linux 的 Services.appinfo.XPCOMABI 不保证能区分 glibc 与 musl。只有 ABI 明确包含 musl 或 gnu/glibc 标记时才归类；像 aarch64-gcc3 这类不能判定 libc 的值按未知 ABI 处理，禁用托管运行时，不推断为 GNU。

## 1. 统一研究对象

`PaperCard` 是发现、排序、导入和综述模块之间的稳定元数据对象，不承载整篇 Markdown 或整篇 PDF。它包含：

- 本地身份：`libraryID`、条目 key、附件 key、稳定 `documentID`；
- 规范元数据：题名、作者、年份、期刊/会议、出版商、摘要和 DOI/arXiv/PMID/URL 等标识；
- Zotero 状态：标签、Collection、日期、本地是否已有附件；
- LitMTrans 状态：是否解析、解析是否过期、流式/排版译文、图表/公式计数；
- 发现增强：主题、关键词、概念、引用数、开放获取位置；
- 可追溯来源：`metadataSources` 和更新时间。

本地索引的事实来源仍是 Zotero 元数据、`litmtrans` 文献目录和外部元数据缓存。索引不是第二份文献库，损坏后可重建。

## 2. 本地索引与分层检索

索引路径固定为当前 Zotero Profile 下的 `litmtrans/literature-index.sqlite`。它不打开或修改 Zotero 自身的 `zotero.sqlite`。宿主有 FTS5 时使用独立 SQLite + FTS5；当前隔离 Zotero 10 的 SQLite 没有 FTS5/FTS4 扩展，因此会使用同一独立 SQLite 的普通字段表 + 内存评分，诊断为 `backend: "sqlite-scan"`。索引包含 PaperCard JSON payload、可检索字段和更新时间元数据。

若宿主没有可用的独立 SQLite API，或 SQLite 普通表也无法建立，代码明确降级到 `literature-index.json`，并在诊断中返回 `backend: "json-fallback"`；JSON 快照也用于 SQLite 恢复和重建，不会把普通扫描伪装成 FTS5。

检索按以下层级执行：

1. PaperCard 元数据/摘要 FTS 或显式 JSON fallback；
2. 本地过滤、年份/作者/主题/期刊/标签/Collection 和开放获取约束；
3. 标题、摘要、作者、主题、标识符和引用数的确定性排序；
4. 自动并行访问 OpenAlex、Semantic Scholar、Crossref、arXiv、Europe PMC，并进行 DOI/arXiv/PMID/题名去重；
5. 对已解析的本地文献才调用 Corpus 搜索，默认只取少量 block；
6. 返回带 `evidenceLevel` 的证据，全文证据必须含 `documentID` 及 `page` 或 `blockID`，并保留 `sourceFingerprint`。

当前版本没有对数千篇文献逐篇调用 LLM。可选的外部模型重排应以后续显式审批为前提，不能替代本地候选筛选。

## 3. 智能体入口

业务入口是 `AgentFacade`，MCP 工具只暴露高层意图：

- `litmtrans_literature_search`：自然语言研究问题、推荐、引用扩展和参考文献扩展；Provider 自动路由；
- `litmtrans_literature_import`：按候选结果导入 Zotero，执行 DOI/题名去重；
- `litmtrans_acquire_papers`：复用已有附件，尝试已知开放 PDF、托管 ScanSci 边界和 Zotero Translator fallback；
- `litmtrans_literature_graph`：返回论文、作者、主题、venue 和引用边；
- `litmtrans_review_workspace`：创建/刷新/更新/读取/导出 Literature Matrix、证据、冲突和缺口；
- Developer-only 的索引重建和诊断工具。

普通访问模式默认授予完整科研访问：Zotero 读取/写入、Notes、Tags、Collections、Annotations、解析、翻译、研究资产、导出、Corpus Search、Literature Discovery、Paper Acquisition 和 Review Workspace。读取模式只允许 annotation read，不允许 annotation write；开发者诊断与原始维护操作单独隔离。

## 4. 获取与导入顺序

候选文献进入获取服务后按以下顺序处理：

1. 查找已有 Zotero 条目和可用 PDF；
2. 下载候选的明确开放获取 PDF，并以 PDF signature/page count 验证；
3. 需要时才准备托管运行时，再通过稳定的 ScanSci MCP client surface 获取；
4. 最后尝试 Zotero DOI/网页 Translator，并复用 Translator 产生的附件；
5. 只在得到有效 PDF 后创建/补全条目、加入 Collection 和启动现有解析 Job。

下载文件先进入 Profile 下的 staging 目录；不依赖用户系统的 Python、PATH、pip 或 uv，不在生产路径执行 `git clone`，也不把 ScanSci 的私有 `_core` 二进制带入插件。

运行时状态保存在 `litmtrans/runtime/acquisition/state.json`，包含版本、来源、能力、健康状态和错误诊断。更新失败会恢复上一次 `installed` 状态。运行时不静态打包进 XPI，而由 versioned runtime manifest 按固定版本、固定来源和 SHA-256 按需获取。Windows x64 已在真实 Zotero clean profile 中验证 ManagedRuntimeManager、ScanSci、PDF 校验、附件导入、正常关闭、重启以及 runtime/attachment 复用；Linux ARM64 已在 A1 验证运行时和 ScanSci/OA，但没有 Linux Zotero 宿主。

## 5. Review Workspace 契约

工作区保存于 Profile 的 `agent/review-workspaces/<id>.json`，包括：候选池、纳入/排除文献、Literature Matrix、主题/方法矩阵、主张、证据台账、冲突、缺口、引用图、覆盖率和导出草稿。

证据级别固定为：`metadata`、`abstract`、`full-text-block`、`figure`、`table`、`formula`。只有后四类要求精确定位；不能凭摘要或元数据生成“全文证据”。Markdown 导出保留证据级别和文献定位，方便后续写 Introduction/Literature Review 时回溯 Zotero 条目。

## 6. 当前状态分类

### 已实现并有离线覆盖

- PaperCard 构建、标准身份、字段索引和 1200-card 压力 fixture；
- 独立 SQLite/FTS5 尝试、JSON 明确 fallback 和诊断；
- 五类外部元数据 Provider、缓存、熔断式重试、统一去重和引用图；
- Zotero 元数据导入、DOI/题名去重、Collection 归属、PDF 校验和并发获取调度；
- Review Workspace、Literature Matrix、证据级别和定位校验；
- 现有 MinerU/Corpus 管线作为解析和全文证据来源。

### 有真实边界但不是当前发布默认依赖

- ScanSci 运行时：Windows x64 已完成真实 Zotero clean-profile 首次安装与完整获取闭环；其他托管目标的现场验证状态见平台矩阵；
- Zotero Translator：保留为最后 fallback，具体站点 translator 是否可用由 Zotero 环境决定；
- 外部 Provider：网络失败返回空结果/缓存或诊断，不阻塞本地 Zotero 搜索；
- SQLite：隔离 Zotero 10 已实际确认独立数据库可用，当前为 `sqlite-scan`，等待宿主提供 FTS5 扩展后自动升级为 FTS5；无独立 SQLite API 的离线环境保持 JSON fallback。

### 尚未宣称完成

- 对所有外部候选自动取得全文并保证版权/站点可访问性；
- 自动从每篇 PDF 生成可信的 method/data/findings 主张；
- 自动生成无需人工核验的最终综述、冲突判断或研究结论；
- CAJ 原件进入 Agent 文献获取主链。CAJ 本轮仅做许可和来源准备。
