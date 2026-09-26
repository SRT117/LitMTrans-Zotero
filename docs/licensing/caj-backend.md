# CAJ backend 许可准备

本轮对 CAJ 只做非侵入式许可和来源登记，不修改 `native/caj-backend` 的 Rust/WASM 逻辑，也不把 CAJ 转换加入 Agent 文献获取主链。

- 上游：`https://github.com/duststarr/caj2pdf-rs`
- 固定上游提交：`23f499e71ec1f9c0f615de2b6664f117a635e841`
- 本地目录：`native/caj-backend`
- 许可证：GPL-2.0-or-later；完整文本位于 `native/caj-backend/LICENSE`
- 本地来源说明：`native/caj-backend/UPSTREAM.md`
- 当前用途：独立 CAJ→PDF 转换后端，按现有项目的 wasm 发行流程处理。

许可边界：CAJ backend 是独立组件，不宣称为主项目 MIT 原创代码；其 GPL 义务、上游归属和修改说明应随对应源代码/分发物保留。Python `caj2pdf`、`caj-tools` 和 `zotero-caj` 只用于格式/行为参考，不作为插件运行时依赖。

本仓库同时分发包含该后端及其静态链接依赖的 WASM。仓库保留 GPL-2.0-or-later 源码、构建入口、固定上游提交和对应第三方许可证/归属；这份记录不对独立组件与插件整体的 combined-work 许可边界作法律结论，仍需按具体分发方式作专业审查。Cargo WASM 依赖图未列出独立 FreeType crate，但随 CAJ 后端分发的 `LICENSE` 明确包含 FreeType Project License（FTL）全文与归属，本轮继续原样保留；字体资产另按其自身许可证登记。

文献研究后端当前只接受经过验证的 PDF；CAJ 文件未自动进入 `PaperAcquisitionService`。如未来要加入 CAJ provider，必须先单独审查分发、许可兼容、WASM 产物归属和用户可见的转换失败恢复路径。
