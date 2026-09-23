# 文献研究参考仓库复用审计

以下仓库在仓库外的本地参考目录中审阅。本表只记录行为、接口和边界参考，不将这些仓库的源代码或运行时依赖复制进插件；因此不把它们误列为插件的 bundled dependency。

| 项目 | remote | 固定 commit | 许可证 | 复用类别 | 决策与边界 |
| --- | --- | --- | --- | --- | --- |
| `Rimagination/scansci-pdf` | `https://github.com/Rimagination/scansci-pdf.git` | `0a080e8a577416c165afe8fd6ff17bf542ed3e3c` | Apache-2.0；仓库含预编译 `src/scansci_pdf/_core` 二进制，单独按其分发边界核对 | `DESIGN_REFERENCE_ONLY` + `KEEP_LITMTRANS` | 参考 PDF 获取/MCP surface；插件不 vendoring `_core`，不依赖系统 Python，不在生产路径 clone。`ScanSciProvider` 只接受外部稳定 client。 |
| `KaguraTart/literature-review-with-LLM` | `https://github.com/KaguraTart/literature-review-with-LLM.git` | `05467f9344c25feb52101027470df1dad2b12f81` | Apache-2.0 | `DESIGN_REFERENCE_ONLY` | 参考综述工作流的候选—矩阵—写作分层；插件保留证据级别、Zotero 回溯和人工可审计边界，不复制其前端/模型调用。 |
| `Future-House/paper-qa` | `https://github.com/Future-House/paper-qa.git` | `57e89f7223b0960d5ee5ea048c69e3c47e088572` | Apache-2.0 | `DESIGN_REFERENCE_ONLY` | 参考 evidence retrieval、引用和问答契约；插件使用现有 MinerU/Corpus block、figure/table/formula locator，不引入 Python runtime 或其索引实现。 |
| `carsten-streb/openalex-mcp` | `https://github.com/carsten-streb/openalex-mcp.git` | `f7d2d5a874b076446b5ffd5eed5aed12f1daf193` | MIT | `DESIGN_REFERENCE_ONLY` | 只参考 OpenAlex 查询和字段映射；Provider 为 LitMTrans 独立实现，没有复制其源文件。 |
| `smaniches/semantic-scholar-mcp` | `https://github.com/smaniches/semantic-scholar-mcp.git` | `38b3aa876e975f2a433ec43922ea39015cd697c2` | MIT | `DESIGN_REFERENCE_ONLY` | 只参考 search/citation/reference API 边界；Provider 为 LitMTrans 独立实现，没有复制其源文件。 |
| `ElliotPadfield/unpaywall-mcp` | `https://github.com/ElliotPadfield/unpaywall-mcp.git` | `39baf601d933b1443d3919afbb97eee229d775f8` | MIT | `DESIGN_REFERENCE_ONLY` | 参考开放获取位置发现；当前插件接受候选的 OA location，并在下载后进行 PDF 校验；没有把 Unpaywall API 设成隐藏必需依赖。 |
| `yilewang/llm-for-zotero` | `https://github.com/yilewang/llm-for-zotero.git` | `4d20b41442c89dfe047fce7d2627928763be558` | AGPL-3.0 | `DESIGN_REFERENCE_ONLY` | 仅参考 Zotero 内研究助手的交互想法；禁止复制源码、AGPL 模块或其打包方式，不能作为本插件实现来源。 |

## 当前代码对应关系

- `src/agent/literature/*`：PaperCard、缓存、Provider、排序、引用图和分层检索；
- `src/agent/acquisition/*`：已有附件、直接 OA、托管运行时、ScanSci 边界、Translator fallback 和 PDF 校验；
- `src/agent/review-workspace.js`：Literature Matrix、证据台账、冲突/缺口和导出；
- `src/agent/facade.js` 与 `src/agent/mcp/tools.js`：高层智能体入口，不把外部仓库的底层配置暴露给普通用户。

只有真正复制或实质改写第三方源码时，才需要在 `THIRD_PARTY_NOTICES.md` 和 bundled license 目录新增归属。本轮未从上述七个仓库复制源码，因此只保留本审计记录。
