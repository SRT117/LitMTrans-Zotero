//! WebAssembly 胶水层：把 caj2pdf-core 的 HN/C8 转 PDF 能力暴露给 Zotero 插件。
//!
//! 接口全部使用 i32 传递指针与长度，避免 BigInt：
//!
//! 1. JS 调用 `ltm_alloc(len)` 拿到输入缓冲区指针并写入数据；
//! 2. 调用 `ltm_convert(ptr, len)` 执行转换；
//! 3. 通过 `ltm_result_ptr()` / `ltm_result_len()` 取回结果
//!    （成功为 PDF 字节，失败为 UTF-8 错误信息）。

#![allow(dead_code)]

use std::sync::Mutex;

use caj2pdf_core::{CajDocument, FileFormat};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn ltm_progress(completed: u32, total: u32);
}

/// 输入缓冲区。wasm 为单线程环境，Mutex 仅用于满足 Rust 借用规则。
static INPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
/// 字体缓冲区。用于接收 JS 端动态传入的思源宋体字节。
static FONT_BUF: Mutex<Vec<u8>> = Mutex::new(Vec::new());
/// 最近一次转换结果：成功时是 PDF 字节，失败时是 UTF-8 错误信息。
static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// 申请 len 字节字体缓冲区线性内存，返回缓冲区指针；参数非法时返回 0。
#[no_mangle]
pub extern "C" fn ltm_alloc_font(len: i32) -> i32 {
    if len <= 0 {
        return 0;
    }
    let mut buf = FONT_BUF.lock().unwrap();
    buf.clear();
    buf.resize(len as usize, 0);
    buf.as_ptr() as i32
}

/// 使用字体缓冲区中的数据初始化全局页面文字渲染字库。
/// 初始化完成后立即清空并收缩原始缓冲区，释放线性内存。
/// 成功返回 1，失败返回 0。
#[no_mangle]
pub extern "C" fn ltm_init_font(_ptr: i32, len: i32) -> i32 {
    if len <= 0 {
        return 0;
    }
    let mut buf = FONT_BUF.lock().unwrap();
    if buf.len() < len as usize {
        return 0;
    }
    let ok = caj2pdf_core::text_render::set_page_font(&buf[..len as usize]);
    buf.clear();
    buf.shrink_to_fit();
    if ok { 1 } else { 0 }
}

/// 申请 len 字节线性内存，返回缓冲区指针；参数非法时返回 0。
#[no_mangle]
pub extern "C" fn ltm_alloc(len: i32) -> i32 {
    if len <= 0 {
        return 0;
    }
    let mut buf = INPUT.lock().unwrap();
    buf.clear();
    buf.resize(len as usize, 0);
    buf.as_ptr() as i32
}

/// 转换输入缓冲区中的 len 字节（HN/C8 格式）。成功返回 1，失败返回 0，
/// 错误信息写入结果区。
#[no_mangle]
pub extern "C" fn ltm_convert(_ptr: i32, len: i32) -> i32 {
    if len <= 0 {
        *RESULT.lock().unwrap() = "非法的输入长度".to_string().into_bytes();
        return 0;
    }
    // 取走整个输入缓冲区（转由文档持有，避免额外复制大文件）。
    let input = std::mem::take(&mut *INPUT.lock().unwrap());
    let res = if input.len() < len as usize {
        Err("输入缓冲区小于声明长度".to_string())
    } else {
        convert_hn_c8(input)
    };
    match res {
        Ok(pdf) => {
            *RESULT.lock().unwrap() = pdf;
            1
        }
        Err(msg) => {
            *RESULT.lock().unwrap() = msg.into_bytes();
            0
        }
    }
}

/// 上次转换结果的起始指针。
#[no_mangle]
pub extern "C" fn ltm_result_ptr() -> i32 {
    RESULT.lock().unwrap().as_ptr() as i32
}

/// 上次转换结果的字节长度。
#[no_mangle]
pub extern "C" fn ltm_result_len() -> i32 {
    RESULT.lock().unwrap().len() as i32
}

/// HN/C8 字节流转 PDF；其余格式交由 JS 端已有转换器处理。
fn convert_hn_c8(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let doc = CajDocument::from_bytes(bytes).map_err(|e| format!("打开文档失败：{e}"))?;
    match doc.format() {
        FileFormat::Hn | FileFormat::C8 => {
            caj2pdf_core::convert::convert_hn_bytes_with_progress(&doc, |completed, total| {
                #[cfg(target_arch = "wasm32")]
                unsafe { ltm_progress(completed as u32, total as u32); }
                #[cfg(not(target_arch = "wasm32"))]
                let _ = (completed, total);
            }).map_err(|e| format!("转换失败：{e}"))
        }
        _ => Err("该文件由 JS 转换器处理".to_string()),
    }
}
