# CAJ 独立转换后端

基于 https://github.com/duststarr/caj2pdf-rs ，固定提交 `23f499e71ec1f9c0f615de2b6664f117a635e841`。
本目录为独立 GPL-2.0-or-later 组件，保留上游源码与许可证，编译为独立 CLI/WASM 组件；不声明为主项目 MIT 原创代码。

本地修改用于修复真实 HN/C8 样本的 JBIG1 算术解码、32 位行对齐、PDF 图像方向、JPEG 数据布局、多图页面定位、解码失败传播与结构化结果输出。构建与分发方法见项目 docs/caj-support.md。

## 与 Python 项目的关系

`caj2pdf` Python 项目是 CAJViewer 行为、页面记录和异常退化策略的参考实现，不作为 Zotero 插件的运行时依赖。它通过 `ctypes` 加载平台相关的 JBIG 解码 DLL，直接打包进 XPI 会依赖用户本机的 Python 和 DLL 环境；插件运行时因此采用可移植的 Rust/WASM 实现，但按 Python 项目的页面模型重新组织 HN/C8 的文字记录、图片层、方向矩阵和 PDF 页面输出。

后续修复应先以 Python 结果和 CAJViewer 视觉结果定义格式契约，再在共享的 Rust core 中实现，禁止按单个文件名增加特例。
