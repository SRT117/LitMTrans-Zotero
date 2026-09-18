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
