//! High-level conversion entry point: turn a CAJ-family file into a PDF.
//!
//! This module is the single place that knows about every format. Other
//! crates (the CLI, the GUI, library users) should call [`convert`] and let
//! this module dispatch on the detected file format.
//!
//! The full pipeline (xref repair, outline injection, JBIG/JPEG image
//! decoding, PDF assembly) lives here so every front-end uses the same
//! implementation.

use std::path::Path;

use tracing::info;

use crate::{
    CajDocument, CajError, CajResult, DecodedImage, FileFormat, ImageKind, MonoOrientation, Page,
    RawImage,
};
use caj2pdf_jbig1 as jbig1;
use caj2pdf_jbig2 as jbig2;
use caj2pdf_pdf::{self as pdf, PageInput};

use crate::text_render::{logical_size_px, render_text_page};

/// XOR key used by the KDH format's "encryption".
pub const KDH_PASSPHRASE: &[u8] = b"FZHMEI";

/// Convert a CAJ-family file at `input` to a PDF at `output`.
///
/// This is the **single high-level entry point** used by every front-end
/// (the `caj2pdf` CLI, the `caj2pdf-gui` desktop app, and any future
/// library consumer). The per-format pipeline is:
///
/// * **CAJ** – extract the embedded PDF, repair its xref table, inject the
///   outline tree, write to `output`.
/// * **HN / C8** – iterate the per-page text and image blocks, decode the
///   JBIG / JBIG2 / JPEG images via `caj2pdf-jbig1` / `caj2pdf-jbig2`, build
///   a fresh PDF via `caj2pdf-pdf`, write to `output`.
/// * **PDF** – copy the file verbatim.
/// * **KDH** – apply the XOR decryption with [`KDH_PASSPHRASE`], drop the
///   254-byte header, truncate to the last `%%EOF` marker, write to
///   `output`.
/// * **TEB** – not yet supported; returns
///   [`CajError::Unsupported("TEB format not yet implemented")`].
///
/// # Errors
/// See [`CajError`].
pub fn convert(input: &Path, output: &Path) -> CajResult<()> {
    info!(file = %input.display(), "opening input");
    let doc = CajDocument::open(input)?;
    info!(format = %doc.format(), "detected format");

    match doc.format() {
        FileFormat::Caj => convert_caj(&doc, output),
        FileFormat::Hn | FileFormat::C8 => convert_hn(&doc, output),
        FileFormat::Pdf => convert_pdf(&doc, output),
        FileFormat::Kdh => convert_kdh(&doc, output),
        FileFormat::Teb => Err(CajError::Unsupported(
            "TEB format is not yet implemented",
        )),
    }
}

// ---------------------------------------------------------------------------
// CAJ: extract embedded PDF, repair xref, inject outlines
// ---------------------------------------------------------------------------

fn convert_caj(doc: &CajDocument, output: &Path) -> CajResult<()> {
    info!("extracting embedded PDF from CAJ container");
    let pdf_bytes = doc.extract_pdf()?;
    info!(bytes = pdf_bytes.len(), "embedded PDF extracted");

    // Load the broken PDF, re-save it (lopdf rebuilds the xref), and add the
    // outline tree. caj2pdf-pdf::inject_outlines does the save+inject in
    // one step.
    let pdf_bytes = pdf::inject_outlines(&pdf_bytes, doc.toc()).map_err(|e| {
        CajError::Malformed {
            format: doc.format(),
            message: format!("xref repair / outline injection failed: {e}"),
        }
    })?;
    std::fs::write(output, &pdf_bytes)?;
    info!(file = %output.display(), "wrote repaired PDF with outlines");
    Ok(())
}

// ---------------------------------------------------------------------------
// HN / C8: iterate pages, decode images, build PDF
// ---------------------------------------------------------------------------

pub fn convert_hn_bytes(doc: &CajDocument) -> CajResult<Vec<u8>> {
    convert_hn_bytes_with_progress(doc, |_, _| {})
}

pub fn convert_hn_bytes_with_progress(
    doc: &CajDocument,
    mut progress: impl FnMut(usize, usize),
) -> CajResult<Vec<u8>> {
    info!("iterating pages");
    let pages = doc.pages()?;
    progress(0, pages.len());
    info!(count = pages.len(), "decoded page list");

    // 先解码全部页面。WITS/SBS2 的文字页可能没有图片，或者只有一
    // 个插图，因此这里同时保留文字底图和图片列表，后面按页决定组合
    // 策略，而不是把“没有图片”直接当成空白页。
    let mut decoded_pages: Vec<Vec<DecodedImage>> = Vec::with_capacity(pages.len());
    let mut text_pages = Vec::with_capacity(pages.len());
    let mut reference_size: Option<(u32, u32)> = None;
    for (idx, page) in pages.iter().enumerate() {
        info!(page = idx + 1, images = page.images.len(), "decoding page");
        let decoded = decode_page(page)?;
        if reference_size.is_none() {
            if let Some(logical_size) = page.logical_size {
                reference_size = Some(logical_size_px(Some(logical_size)));
            } else if let Some(first) = decoded.first() {
                reference_size = Some((
                    first.width_px(),
                    (first.height_px() as i32).unsigned_abs() as u32,
                ));
            }
        }
        text_pages.push(render_text_page(page));
        decoded_pages.push(decoded);
        progress(idx + 1, pages.len());
    }

    let (ref_w, ref_h) = reference_size.unwrap_or_else(|| logical_size_px(None));

    let mut page_inputs = Vec::with_capacity(pages.len());
    for ((page, decoded), text_page) in pages
        .iter()
        .zip(decoded_pages.iter())
        .zip(text_pages.iter())
    {
        // A WITS/SBS2 page is normally a text canvas with an optional figure
        // layer. Full-page scans (JBIG2 in particular) already contain the
        // complete page and must win over the reconstructed text to avoid
        // duplicating or obscuring the scan.
        if let Some((text_image, text_size)) = text_page {
            let has_full_page_scan = decoded
                .iter()
                .any(|image| is_full_page_scan(image, *text_size));
            if !has_full_page_scan {
                page_inputs.push(build_text_backed_page(
                    text_image.clone(),
                    *text_size,
                    decoded,
                ));
                continue;
            }
        }

        if decoded.is_empty() {
            // 没有图像、且文字字体缺失或记录不完整时，至少保留页数和
            // 正确的页面尺寸；这比让 Zotero 打不开转换结果更容易恢复。
            let stride = (ref_w as usize).div_ceil(8);
            let blank = DecodedImage::Mono {
                width_px: ref_w,
                height_px: ref_h,
                orientation: MonoOrientation::Normal,
                bits: vec![0u8; stride * ref_h as usize],
            };
            let mut input = PageInput::new(blank);
            input.page_size = Some((ref_w, ref_h));
            page_inputs.push(input);
            continue;
        }

        let base = decoded.first().unwrap().clone();
        if decoded.len() == 1 {
            page_inputs.push(PageInput::new(base));
            continue;
        }

        // 多图页：优先使用文本记录中的图框定位；缺失或无效时退化为垂直堆叠。
        let mut input = PageInput::new(base.clone());
        let remaining: Vec<&DecodedImage> = decoded[1..].iter().collect();
        let figure_ok = page.figures.len() >= decoded.len()
            && {
                let b = page.figures[0];
                b[0] == 0 && b[1] == 0 && b[2] != 0 && b[3] != 0
            };
        if figure_ok {
            let base_rect = page.figures[0];
            let mut layers = Vec::new();
            for (n, layer) in remaining.iter().enumerate() {
                let r = page.figures[n + 1];
                layers.push((
                    (*layer).clone(),
                    [
                        r[0] as f64 / base_rect[2] as f64,
                        r[1] as f64 / base_rect[3] as f64,
                        r[2] as f64 / base_rect[2] as f64,
                        r[3] as f64 / base_rect[3] as f64,
                    ],
                ));
            }
            input.layers = layers;
        } else {
            // 垂直堆叠：各图按底图宽度等比缩放，页面高度为各图高度之和。
            let base_w = base.width_px() as u64;
            let base_h = (base.height_px() as i32).unsigned_abs() as u64;
            let mut scaled_heights: Vec<u64> = Vec::with_capacity(remaining.len());
            let mut total_h: u64 = base_h;
            for img in &remaining {
                let iw = (img.width_px() as u64).max(1);
                let sh = (img.height_px() as i32).unsigned_abs() as u64 * base_w / iw;
                scaled_heights.push(sh);
                total_h += sh;
            }
            let total_h = total_h.max(1) as u32;
            let page_w = base_w.max(1) as u32;
            let mut layers = Vec::new();
            let mut cursor: u64 = base_h;
            for (img, sh) in remaining.iter().zip(scaled_heights.iter()) {
                layers.push((
                    (*img).clone(),
                    [
                        0.0,
                        cursor as f64 / total_h as f64,
                        1.0,
                        *sh as f64 / total_h as f64,
                    ],
                ));
                cursor += *sh;
            }
            input.layers = layers;
            input.page_size = Some((page_w, total_h));
            input.image_rect = [0.0, 0.0, 1.0, base_h as f64 / total_h as f64];
        }
        page_inputs.push(input);
    }

    if page_inputs.is_empty() {
        return Err(CajError::Malformed {
            format: doc.format(),
            message: "file has no pages to embed".into(),
        });
    }

    let pdf_bytes = pdf::build_document(&page_inputs, doc.toc()).map_err(|e| {
        CajError::Malformed {
            format: doc.format(),
            message: format!("PDF build failed: {e}"),
        }
    })?;
    info!(pages = page_inputs.len(), "built PDF");
    Ok(pdf_bytes)
}

fn is_full_page_scan(image: &DecodedImage, page_size: (u32, u32)) -> bool {
    let image_width = image.width_px() as f64;
    let image_height = (image.height_px() as i32).unsigned_abs() as f64;
    let page_width = page_size.0.max(1) as f64;
    let page_height = page_size.1.max(1) as f64;
    let area_ratio = image_width * image_height / (page_width * page_height);

    image_width / page_width >= 0.44
        && image_height / page_height >= 0.72
        && area_ratio >= 0.30
}

fn build_text_backed_page(
    text_image: DecodedImage,
    page_size: (u32, u32),
    images: &[DecodedImage],
) -> PageInput {
    let mut input = PageInput::new(text_image);
    input.page_size = Some(page_size);
    if images.is_empty() {
        return input;
    }

    // CAJ's WITS records do not expose a stable figure rectangle across all
    // producers. Keep the text canvas intact and place figure layers in the
    // lower half, preserving each image's aspect ratio. This is a format-level
    // fallback and therefore works for new files without filename rules.
    let slot_top = 0.49f64;
    let slot_height = 0.47f64 / images.len() as f64;
    for (index, image) in images.iter().enumerate() {
        let image_width = image.width_px().max(1) as f64;
        let image_height = (image.height_px() as i32).unsigned_abs().max(1) as f64;
        let max_width = 0.92 * page_size.0 as f64;
        let max_height = (slot_height * page_size.1 as f64).max(1.0);
        let scale = (max_width / image_width).min(max_height / image_height);
        let width = (image_width * scale / page_size.0 as f64).min(0.94);
        let height = (image_height * scale / page_size.1 as f64).min(slot_height);
        let y = slot_top + index as f64 * slot_height + (slot_height - height).max(0.0) / 2.0;
        input.layers.push((
            image.clone(),
            [((1.0 - width) / 2.0).max(0.0), y, width, height],
        ));
    }
    input
}

/// 写盘版入口：调用 [`convert_hn_bytes`] 后将 PDF 写入 `output`（CLI 使用）。
fn convert_hn(doc: &CajDocument, output: &Path) -> CajResult<()> {
    let pdf_bytes = convert_hn_bytes(doc)?;
    std::fs::write(output, &pdf_bytes)?;
    info!(file = %output.display(), "wrote PDF");
    Ok(())
}

/// Decode every image on a page, returning the successfully decoded ones.
fn decode_page(page: &Page) -> CajResult<Vec<DecodedImage>> {
    let mut out = Vec::with_capacity(page.images.len());
    for raw in &page.images {
        out.push(decode_image(raw)?);
    }
    Ok(out)
}

fn decode_image(raw: &RawImage) -> CajResult<DecodedImage> {
    match raw.kind {
        ImageKind::Jbig1 => {
            let bmp = jbig1::decode(&raw.data, raw.width_px, raw.height_px)
                .map_err(|e| CajError::Malformed {
                    format: FileFormat::Hn,
                    message: format!("JBIG1 decode failed: {e}"),
                })?;
            Ok(DecodedImage::Mono {
                width_px: bmp.width,
                height_px: bmp.height,
                orientation: MonoOrientation::FlipVertical,
                bits: bmp.bits,
            })
        }
        ImageKind::Jbig2 => {
            let bmp = jbig2::decode(&raw.data, raw.width_px, raw.height_px)
                .map_err(|e| CajError::Malformed {
                    format: FileFormat::Hn,
                    message: format!("JBIG2 decode failed: {e}"),
                })?;
            Ok(DecodedImage::Mono {
                width_px: bmp.width,
                height_px: bmp.height,
                orientation: MonoOrientation::Normal,
                bits: bmp.bits,
            })
        }
        ImageKind::Jpeg { upside_down } => {
            let start = if raw.data.starts_with(&[0xff,0xd8]) { 0 } else { 48 };
            let jpeg_bytes = raw.data.get(start..).ok_or_else(|| CajError::malformed(FileFormat::Hn,"JPEG data missing"))?.to_vec();
            let (width, height, _, _) = pdf::builder::jpeg_info(&jpeg_bytes).map_err(|e| CajError::malformed(FileFormat::Hn,e.to_string()))?;
            Ok(DecodedImage::Jpeg { width_px: width, height_px: if upside_down { (-(height as i32)) as u32 } else { height }, jpeg_bytes })
        }
    }
}

// ---------------------------------------------------------------------------
// PDF and KDH: pass-through and decrypt
// ---------------------------------------------------------------------------

fn convert_pdf(doc: &CajDocument, output: &Path) -> CajResult<()> {
    info!("PDF pass-through, copying file");
    std::fs::copy(doc.path(), output)?;
    Ok(())
}

fn convert_kdh(doc: &CajDocument, output: &Path) -> CajResult<()> {
    info!("decrypting KDH");
    let bytes = std::fs::read(doc.path())?;
    let decrypted = decrypt_kdh(&bytes);

    // The KDH container holds a complete PDF (typically PDF 1.5+ with a
    // cross-reference stream) so no additional xref repair is needed.
    if !decrypted.starts_with(b"%PDF-") {
        return Err(CajError::Malformed {
            format: doc.format(),
            message: "decrypted KDH does not start with %PDF- — wrong XOR key?".into(),
        });
    }
    if !decrypted.windows(5).any(|w| w == b"%%EOF") {
        return Err(CajError::Malformed {
            format: doc.format(),
            message: "decrypted KDH is missing %%EOF marker".into(),
        });
    }

    std::fs::write(output, &decrypted)?;
    info!(
        file = %output.display(),
        bytes = decrypted.len(),
        "wrote decrypted PDF"
    );
    Ok(())
}

/// Decrypt a KDH file by applying a fixed 6-byte XOR keystream
/// ([`KDH_PASSPHRASE`]) after skipping the 254-byte container header, then
/// truncate the result to the last `%%EOF` marker.
///
/// This matches `_convert_kdh` in the original Python
/// `cajparser.py:605-640` line-for-line:
///
/// 1. Drop the first 254 bytes (the KDH container header).
/// 2. XOR each remaining byte with the keystream
///    (`FZHMEI` repeated cyclically).
/// 3. Truncate to the byte just past the last occurrence of `%%EOF`.
///
/// The caller is responsible for repairing the PDF xref table (e.g. with
/// `mutool clean` or `lopdf`) after this returns.
pub fn decrypt_kdh(input: &[u8]) -> Vec<u8> {
    if input.len() <= 254 {
        // Truncated input: no payload to decrypt, no %%EOF to find.
        return Vec::new();
    }
    let payload = &input[254..];
    let mut output = Vec::with_capacity(payload.len());
    for (i, &b) in payload.iter().enumerate() {
        output.push(b ^ KDH_PASSPHRASE[i % KDH_PASSPHRASE.len()]);
    }

    // Drop everything after the last `%%EOF` (inclusive of the 5 bytes).
    if let Some(pos) = output
        .windows(b"%%EOF".len())
        .rposition(|w| w == b"%%EOF")
    {
        output.truncate(pos + b"%%EOF".len());
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip: a single byte XORed with `FZHMEI` should produce the
    /// original byte back.
    #[test]
    fn decrypt_round_trip_single_byte() {
        let key = KDH_PASSPHRASE;
        for (i, original) in b"hello world!".iter().enumerate() {
            let encrypted = original ^ key[i % key.len()];
            assert_eq!(encrypted ^ key[i % key.len()], *original);
        }
    }

    /// The decryption must skip the first 254 bytes of the input.
    /// We construct a payload that, after XOR with `FZHMEI`, yields a
    /// string ending in `%%EOF` (so the `rfind("%%EOF")` step has
    /// something to find).
    #[test]
    fn decrypt_skips_254_byte_header() {
        let target = b"%PDF-1.3\n%%EOF\n";
        let mut encrypted = target.to_vec();
        for (i, b) in encrypted.iter_mut().enumerate() {
            *b ^= KDH_PASSPHRASE[i % KDH_PASSPHRASE.len()];
        }
        let mut input = vec![0u8; 254];
        input.extend_from_slice(&encrypted);
        let out = decrypt_kdh(&input);
        // The output is the (decrypted) target truncated to the last
        // %%EOF, so the trailing newline gets dropped (this matches
        // the original Python behaviour).
        // More simply: the output must end exactly at the last %%EOF.
        assert!(out.ends_with(b"%%EOF"));
        assert_eq!(out.len(), target.len() - 1);
    }

    /// Decryption should truncate everything after the last `%%EOF`.
    #[test]
    fn decrypt_truncates_after_last_eof() {
        let mut input = vec![0u8; 254];
        let mut payload = b"%PDF-1.3\njunk\n%%EOF\nmore-junk-after".to_vec();
        // Re-XOR so the magic+EOF survive the keystream.
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= KDH_PASSPHRASE[i % KDH_PASSPHRASE.len()];
        }
        input.extend_from_slice(&payload);
        let out = decrypt_kdh(&input);
        // The trailing "more-junk-after" must be truncated.
        assert!(out.ends_with(b"%%EOF"));
        // Output is a strict prefix of the decrypted payload, ending
        // right after the last %%EOF.
        assert!(out.len() < 254 + payload.len());
    }

    /// An input shorter than 254 bytes must yield an empty output.
    #[test]
    fn decrypt_handles_truncated_input() {
        assert_eq!(decrypt_kdh(&[]), Vec::<u8>::new());
        assert_eq!(decrypt_kdh(&[0u8; 100]), Vec::<u8>::new());
        assert_eq!(decrypt_kdh(&[0u8; 254]), Vec::<u8>::new());
    }

    /// If the input has no `%%EOF` the original Python raises; the Rust
    /// port returns the whole decrypted blob instead (more forgiving).
    #[test]
    fn decrypt_no_eof_returns_full_payload() {
        let mut input = vec![0u8; 254];
        input.extend_from_slice(b"no eof marker here at all");
        let out = decrypt_kdh(&input);
        // The whole payload comes through, in XORed form.
        assert_eq!(
            out.len(),
            b"no eof marker here at all".len()
        );
    }
}
