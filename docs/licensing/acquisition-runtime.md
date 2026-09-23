# 文献获取托管运行时许可边界

本文档说明 `PaperAcquisitionService` 首次运行时下载的组件。它们不是插件 XPI 的静态捆绑内容，运行时只写入当前 Zotero Profile 的 `litmtrans/runtime/acquisition`，并使用清单中的固定版本和 SHA-256。

| 组件 | 当前用途 | 许可/来源 | 分发状态 |
| --- | --- | --- | --- |
| Python 3.13.15 Windows embeddable | 保留 Windows x64 已 field-validated 的托管解释器 | Python Software Foundation License；来源为 [Python Windows releases](https://www.python.org/downloads/windows/) | 按需下载到 Profile staging，不进入 XPI |
| python-build-standalone CPython 3.13.15 | Windows ARM64、macOS、Linux GNU 新目标解释器 | [Astral python-build-standalone](https://github.com/astral-sh/python-build-standalone)，仓库为 MPL-2.0；其 CPython 与构建依赖另有各自许可。uv/Python 版本、release、target triple 和 SHA-256 固定在运行时清单 | uv 从上游按需安装到当前 Profile；Linux ARM64 在 A1 已完成运行时/ScanSci 验证，未宣称 Zotero Linux 宿主 field-validated |
| uv 0.12.18 | 新目标的临时 Python 下载/解包/安装器 | [Astral uv](https://github.com/astral-sh/uv)，MIT OR Apache-2.0；每个目标的官方发布归档 SHA-256 固定在运行时清单 | 按需下载到 staging、校验后运行；Python 安装完成即删除 uv 二进制和归档，不进入 XPI 或正式 runtime generation |
| pip | 为托管解释器安装 ScanSci 依赖 | Windows x64 使用 [PyPI pip 25.3](https://pypi.org/project/pip/25.3/) MIT wheel；uv 管理的 python-build-standalone 自带 pip，版本随该 Python distribution | 只写入 Profile staging 的托管 Python site-packages，不进入 XPI |
| scansci-pdf 1.17.0 | ScanSci MCP 下载服务 | Apache-2.0；来源为本机审计的 scansci-pdf pyproject.toml 和 [Rimagination 上游项目](https://github.com/Rimagination/scansci-pdf) | 运行时按清单下载，不复制源码到本仓库 |
| mcp 及 ScanSci 依赖 | ScanSci MCP 协议和 PDF 下载依赖 | 依赖各自上游许可；安装结果保留在用户 Profile，不在插件包中重分发 | 不把依赖源码或 native wheel 放进 XPI |

运行时安装前以清单 SHA-256 校验 bootstrap/runtime 归档。Windows x64 继续使用原 Python embeddable + pip 25.3 路径，不经过 uv。新目标使用 uv 的 managed Python 安装流程，并传入 staging 内临时生成的单目标下载元数据，使 uv 只接受清单固定的 Python 版本、python-build-standalone release、归档 URL 和 SHA-256；该临时元数据、uv 二进制与归档在解释器安装后删除。此流程不读取系统 Python、不写用户 PATH 或全局 Python 安装目录；ScanSci 依赖只写入新解释器自己的 site-packages。

uv 启动器归档在运行时清单中优先尝试 releases.astral.sh 镜像，失败后回退 GitHub Releases。固定 Python 下载元数据中的 python-build-standalone URL 保留 GitHub 规范地址。A1 的既有记录证明 uv 0.12.18 成功安装了清单固定的 Python 3.13.15，但本地没有保留该次请求的详细 URL 日志，因此不据此断言它实际选择了哪个 Python 下载域名；归档仍由 uv 按清单 SHA-256 校验。

当前状态按验证边界区分：Windows x64 已完成 Zotero clean-profile field E2E；Linux ARM64 已在 A1（aarch64、glibc 2.39）验证 uv 0.12.18、Python 3.13.15、ScanSci 1.17.0、MCP 2.2.0、PyMuPDF、真实 ScanSci `tools/list` 与 arXiv OA 下载，但没有 Linux Zotero GUI 宿主，因此仍标 `adapter-ready-not-field-validated`。Windows ARM64、macOS arm64/x64、Linux x64 已实现目标 Adapter 和固定来源，但仍需相应主机验证后才能升级支持状态。

ScanSci universal wheel 在 A1 没有提供 `_core` 编译模块；上游 Python fallback 可正常工作，运行时探针会把该状态报告为 `scansci-python-fallback`，而不是推断为 native/optimized backend。PyMuPDF、MCP 及其 native wheels 仍分别通过当前目标的真实 import/server 检查。

CAJ 转换后端不属于本运行时；它的 GPL 边界和分发说明见 [`caj-backend.md`](caj-backend.md)，本次文献获取实现没有修改 CAJ 代码或把 CAJ 接入获取 Provider。

运行时日志、诊断和 MCP 响应不得包含 Cookie、密码、令牌或用户凭据。机构登录始终由用户在打开的浏览器窗口中完成；插件只传递高层登录意图，不接受或持久化 `cookie_file`。
