"use strict";

importScripts("../assets/vendor/pdf-lib/pdf-lib.min.js", "caj-converter.js");

self.onmessage = async ({ data }) => {
  const report = (message, completed = 0, total = 0) => {
    self.postMessage({ type: "progress", message, completed, total });
  };
  try {
    const bytes = new Uint8Array(data.source);
    const format = self.LitMTrans.CAJConverter.detectFormat(bytes);
    let pdf;
    if (format === "HN" || format === "C8") {
      report("正在加载转换组件");
      const { instance } = await WebAssembly.instantiate(data.wasm, {
        env: {
          ltm_progress(completed, total) {
            report(completed === total ? "正在生成 PDF" : `正在转换页面 ${completed} / ${total}`, completed, total);
          }
        }
      });
      const api = instance.exports;
      if (!data.font || !(data.font.byteLength || data.font.length)) {
        throw new Error("缺少 CAJ 文字渲染字体数据，已停止转换");
      }
      if (typeof api.ltm_alloc_font !== "function" || typeof api.ltm_init_font !== "function") {
        throw new Error("CAJ 转换组件版本不匹配，缺少字体接口");
      }
      const fontBytes = new Uint8Array(data.font);
      const fontPtr = api.ltm_alloc_font(fontBytes.length) >>> 0;
      if (!fontPtr) throw new Error("无法分配 CAJ 字体渲染内存");
      new Uint8Array(api.memory.buffer, fontPtr, fontBytes.length).set(fontBytes);
      const fontOk = api.ltm_init_font(fontPtr, fontBytes.length);
      if (!fontOk) throw new Error("CAJ 字体初始化失败，无法渲染文字页");
      data.font = null;
      const pointer = api.ltm_alloc(bytes.length) >>> 0;
      if (!pointer) throw new Error("无法分配转换内存");
      new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
      report("正在读取页面结构");
      const ok = api.ltm_convert(pointer, bytes.length);
      const length = api.ltm_result_len() >>> 0;
      const result = api.ltm_result_ptr() >>> 0;
      if (!ok || !length || !result) {
        throw new Error(length && result
          ? new TextDecoder().decode(new Uint8Array(api.memory.buffer, result, length))
          : "CAJ 转换未返回 PDF");
      }
      pdf = new Uint8Array(api.memory.buffer, result, length).slice();
    }
    else {
      report("正在转换 PDF");
      pdf = await self.LitMTrans.CAJConverter.convertToPDF(bytes);
    }
    report("正在校验 PDF");
    const document = await self.PDFLib.PDFDocument.load(pdf, { throwOnInvalidObject: true, updateMetadata: false });
    const pageCount = document.getPageCount();
    if (!pageCount) throw new Error("转换结果没有可用页面");
    const output = pdf.byteOffset === 0 && pdf.byteLength === pdf.buffer.byteLength
      ? pdf.buffer
      : pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
    self.postMessage({ type: "result", pdf: output, pageCount, format }, [output]);
  }
  catch (error) {
    self.postMessage({ type: "error", message: String(error?.message || error) });
  }
};
