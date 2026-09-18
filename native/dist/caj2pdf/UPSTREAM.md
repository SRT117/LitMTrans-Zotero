# CAJ 独立转换后端

基于 https://github.com/duststarr/caj2pdf-rs ，固定提交 `23f499e71ec1f9c0f615de2b6664f117a635e841`。
本目录为独立 GPL-2.0-or-later 组件，保留上游源码与许可证，编译为 WebAssembly 模块在插件进程内运行；不声明为主项目 MIT 原创代码。

本地修改用于修复真实 HN/C8 样本的 JBIG1 算术解码、32 位行对齐、PDF 图像方向、JPEG 数据布局、多图页面定位、解码失败传播与结构化结果输出，并新增 wasm 胶水层（`crates/wasm`）以内存字节流方式调用核心转换，替代原先仅限 Windows 的独立 exe 进程。

构建（在 `native/caj-backend` 目录执行）：

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown -p litmtrans-wasm
cp target/wasm32-unknown-unknown/release/litmtrans_wasm.wasm ../dist/caj2pdf/caj2pdf.wasm
```

构建与分发方法见项目 docs/caj-support.md。
