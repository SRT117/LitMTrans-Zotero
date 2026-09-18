//! HN / C8 format specific reading logic.
//!
//! See `docs/format-analysis.md` for the byte-level layout this module parses.
//!
//! Both HN and C8 share the same 20-byte [`PageInfo`] struct and the same
//! per-page text+image block layout. They differ in their header layout:
//!
//! * **C8** – page count at 0x08, no outline, page-info table at 0x50.
//! * **HN (no-TOC)** – `HN\xc8\x00` magic, page count at 0x90, no outline,
//!   page-info table at 0xD8.
//! * **HN (with-TOC)** – `HN` GBK-decoded magic, page count at 0x90, outline
//!   count at 0x158, page-info table immediately after the outline tree.

use crate::{
    CajDocument, CajError, CajResult, FileFormat, ImageKind, Layout, OutlineEntry, Page, RawImage,
};
use std::io::{Read, Seek, SeekFrom};

const PAGE_INFO_ENTRY_SIZE: usize = 20;
const TOC_ENTRY_SIZE: usize = 0x134;
const HN_PAGE_COUNT_OFFSET: u64 = 0x90;
const HN_TOC_COUNT_OFFSET: u64 = 0x158;
const C8_PAGE_INFO_TABLE_OFFSET: u64 = 0x50;
const HN_NO_TOC_PAGE_INFO_TABLE_OFFSET: u64 = 0xD8;
const C8_PAGE_COUNT_OFFSET: u64 = 0x08;

/// Read the page count and (optionally) the table of contents for an HN or C8
/// file, then patch the document's layout with the actual offsets.
pub(crate) fn read_meta(doc: &mut CajDocument) -> CajResult<()> {
    let with_toc = matches!(
        doc.layout,
        Layout::Hn {
            with_toc: true,
            ..
        }
    );

    let page_count_offset = match doc.format {
        FileFormat::Hn => HN_PAGE_COUNT_OFFSET,
        FileFormat::C8 => C8_PAGE_COUNT_OFFSET,
        _ => unreachable!("read_meta called for non-HN/C8"),
    };

    // 先基于文件字节计算全部元数据，再一次性写回，避免借用冲突。
    let (page_count, layout, toc) = {
        let bytes = doc.file_bytes()?;
        let page_count = read_i32_at(&bytes, page_count_offset, doc.format)?;
        if page_count < 0 {
            return Err(CajError::malformed(
                doc.format,
                format!("page count must be non-negative, got {page_count}"),
            ));
        }
        let page_count = page_count as u32;

        match (doc.format, with_toc) {
            (FileFormat::C8, _) => (
                page_count,
                Layout::C8 {
                    page_info_table_offset: C8_PAGE_INFO_TABLE_OFFSET,
                },
                Vec::new(),
            ),
            (FileFormat::Hn, false) => (
                page_count,
                Layout::Hn {
                    page_info_table_offset: HN_NO_TOC_PAGE_INFO_TABLE_OFFSET,
                    with_toc: false,
                },
                Vec::new(),
            ),
            (FileFormat::Hn, true) => {
                let toc_count = read_i32_at(&bytes, HN_TOC_COUNT_OFFSET, doc.format)?;
                if toc_count < 0 {
                    return Err(CajError::malformed(
                        doc.format,
                        format!("toc count must be non-negative, got {toc_count}"),
                    ));
                }
                let mut toc = Vec::with_capacity(toc_count as usize);
                for i in 0..toc_count as u64 {
                    let offset = (HN_TOC_COUNT_OFFSET + 4 + i * TOC_ENTRY_SIZE as u64) as usize;
                    let end = offset + TOC_ENTRY_SIZE;
                    let buf = bytes.get(offset..end).ok_or_else(|| {
                        CajError::malformed(
                            doc.format,
                            format!("toc entry {} at 0x{:x} is past EOF", i + 1, offset),
                        )
                    })?;
                    let ttl_end = buf[..0x100].iter().position(|&b| b == 0).unwrap_or(0x100);
                    let title_raw = &buf[..ttl_end];
                    let (title, _, _) = encoding_rs::GBK.decode(title_raw);
                    let title = title.into_owned();

                    let pg_end = buf[0x118..0x124]
                        .iter()
                        .position(|&b| b == 0)
                        .unwrap_or(12);
                    let page: u32 = std::str::from_utf8(&buf[0x118..0x118 + pg_end])
                        .unwrap_or("0")
                        .parse()
                        .unwrap_or(0);
                    let level = i32::from_le_bytes(buf[0x130..0x134].try_into().unwrap()) as u8;
                    toc.push(OutlineEntry { title, page, level });
                }
                let page_info_table_offset =
                    HN_TOC_COUNT_OFFSET + 4 + (toc_count as u64) * TOC_ENTRY_SIZE as u64;
                (
                    page_count,
                    Layout::Hn {
                        page_info_table_offset,
                        with_toc: true,
                    },
                    toc,
                )
            }
            _ => unreachable!(),
        }
    };

    doc.page_count = page_count;
    doc.toc = toc;
    doc.layout = layout;
    Ok(())
}

/// 以小端序读取 offset 处的 i32；越界时返回 Malformed 错误。
fn read_i32_at(bytes: &[u8], offset: u64, format: FileFormat) -> CajResult<i32> {
    let start = offset as usize;
    let end = start + 4;
    if end > bytes.len() {
        return Err(CajError::malformed(
            format,
            format!("i32 field at 0x{:x} is past EOF (0x{:x})", offset, bytes.len()),
        ));
    }
    Ok(i32::from_le_bytes(bytes[start..end].try_into().unwrap()))
}

/// Iterate the per-page info table of an HN / C8 file, yielding a [`Page`]
/// for each entry. Image blocks are kept as [`RawImage`] ready for decoding
/// by the JBIG/JPEG decoders in `caj2pdf-jbig1` / `caj2pdf-jbig2`.
///
/// # Errors
/// * [`CajError::Malformed`] if the document's page info is inconsistent
///   (e.g. a referenced image offset does not match the running cursor).
/// * [`CajError::Unsupported`] if called on a non-HN/C8 document.
pub fn iter_pages(doc: &CajDocument) -> CajResult<Vec<Page>> {
    let page_info_table_offset = match doc.layout {
        Layout::Hn {
            page_info_table_offset,
            ..
        } => page_info_table_offset,
        Layout::C8 {
            page_info_table_offset,
        } => page_info_table_offset,
        _ => {
            return Err(CajError::Unsupported(
                "iter_pages is only supported for HN and C8 documents; use extract_pdf for CAJ/PDF",
            ));
        }
    };

    iter_pages_inner(doc, page_info_table_offset)
}

fn iter_pages_inner(doc: &CajDocument, page_info_table_offset: u64) -> CajResult<Vec<Page>> {
    let bytes = doc.file_bytes()?;
    let mut pages = Vec::with_capacity(doc.page_count as usize);

    for i in 0..doc.page_count {
        let info_offset = page_info_table_offset + (i as u64) * PAGE_INFO_ENTRY_SIZE as u64;
        let page_info = read_page_info(&bytes, info_offset)?;

        // ---- text section ----
        let (decompressed, old_style) = read_text_section(
            doc,
            &bytes,
            page_info.page_data_offset as u64,
            page_info.size_of_text_section as usize,
            page_info.next_page_data_offset as u64,
            i,
        )?;

        let layout = crate::hn_page::parse_text_layout(&decompressed, old_style);
        let text = if layout.glyphs.is_empty() {
            crate::hn_page::parse_page_text(&decompressed, old_style)
        } else {
            layout.text.clone()
        };

        // ---- image blocks ----
        let mut images = Vec::with_capacity(page_info.images_per_page.max(0) as usize);
        let mut current_offset =
            (page_info.page_data_offset as u64) + (page_info.size_of_text_section as u64);
        for _ in 0..page_info.images_per_page.max(0) {
            if (current_offset as usize) + 12 > bytes.len() {
                return Err(CajError::malformed(
                    doc.format,
                    format!(
                        "page {} image header at 0x{:x} is past EOF (0x{:x})",
                        i + 1,
                        current_offset,
                        bytes.len()
                    ),
                ));
            }
            let head = &bytes[current_offset as usize..current_offset as usize + 12];
            let image_type_enum = i32::from_le_bytes(head[0..4].try_into().unwrap());
            let offset_to_image_data = i32::from_le_bytes(head[4..8].try_into().unwrap()) as u64;
            let size_of_image_data = i32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;

            if offset_to_image_data != current_offset + 12 {
                return Err(CajError::malformed(
                    doc.format,
                    format!(
                        "page {} unusual image offset: header says 0x{:x}, expected 0x{:x}",
                        i + 1,
                        offset_to_image_data,
                        current_offset + 12
                    ),
                ));
            }
            let end = (offset_to_image_data as usize)
                .checked_add(size_of_image_data)
                .ok_or_else(|| {
                    CajError::malformed(
                        doc.format,
                        format!("page {} image size overflows usize", i + 1),
                    )
                })?;
            if end > bytes.len() {
                return Err(CajError::malformed(
                    doc.format,
                    format!(
                        "page {} image at 0x{:x} size {} past EOF (0x{:x})",
                        i + 1,
                        offset_to_image_data,
                        size_of_image_data,
                        bytes.len()
                    ),
                ));
            }
            let data = bytes[offset_to_image_data as usize..end].to_vec();
            current_offset = end as u64;

            // The CNKI image header (first 48 bytes) holds the dimensions:
            //   u32 width, u32 height, u16 planes, u16 bits_per_pixel
            let (width, height) = if data.len() >= 16 {
                (
                    u32::from_le_bytes(data[4..8].try_into().unwrap()),
                    u32::from_le_bytes(data[8..12].try_into().unwrap()),
                )
            } else {
                (0, 0)
            };
            let kind = match image_type_enum {
                0 => ImageKind::Jbig1,
                1 | 2 => ImageKind::Jpeg {
                    upside_down: image_type_enum == 2,
                },
                3 => ImageKind::Jbig2,
                other => {
                    return Err(CajError::malformed(
                        doc.format,
                        format!("page {} unknown image type {}", i + 1, other),
                    ));
                }
            };
            images.push(RawImage {
                kind,
                data,
                width_px: width,
                height_px: height,
            });
        }

        let figures = crate::hn_page::parse_figures(&decompressed, old_style);
        pages.push(Page {
            text,
            images,
            figures,
            glyphs: layout.glyphs,
            logical_size: layout.logical_size,
        });
    }

    Ok(pages)
}

fn read_page_info(bytes: &[u8], offset: u64) -> CajResult<crate::hn::PageInfo> {
    let start = offset as usize;
    let end = start + PAGE_INFO_ENTRY_SIZE;
    if end > bytes.len() {
        return Err(CajError::Malformed {
            format: FileFormat::Hn,
            message: format!("page-info entry at 0x{:x} is past EOF", offset),
        });
    }
    let buf: [u8; PAGE_INFO_ENTRY_SIZE] = bytes[start..end].try_into().unwrap();
    Ok(PageInfo {
        page_data_offset: i32::from_le_bytes(buf[0..4].try_into().unwrap()),
        size_of_text_section: i32::from_le_bytes(buf[4..8].try_into().unwrap()),
        images_per_page: i16::from_le_bytes(buf[8..10].try_into().unwrap()),
        page_no: i16::from_le_bytes(buf[10..12].try_into().unwrap()),
        unk2: i16::from_le_bytes(buf[12..14].try_into().unwrap()),
        _pad: i16::from_le_bytes(buf[14..16].try_into().unwrap()),
        next_page_data_offset: i32::from_le_bytes(buf[16..20].try_into().unwrap()),
    })
}

fn read_text_section(
    doc: &CajDocument,
    bytes: &[u8],
    page_data_offset: u64,
    size_of_text_section: usize,
    next_page_data_offset: u64,
    page_index: u32,
) -> CajResult<(Vec<u8>, bool)> {
    use flate2::read::ZlibDecoder;
    let old_style = next_page_data_offset > page_data_offset;

    let start = page_data_offset as usize;
    if start + 32 > bytes.len() {
        return Err(CajError::malformed(
            doc.format,
            format!(
                "page {} text section at 0x{:x} is past EOF",
                page_index + 1,
                page_data_offset
            ),
        ));
    }
    let header: [u8; 32] = bytes[start..start + 32].try_into().unwrap();

    let compressed_at_zero = header[0..12] == *b"COMPRESSTEXT";
    let compressed_at_eight = header[8..20] == *b"COMPRESSTEXT";

    let decompressed = if compressed_at_zero || compressed_at_eight {
        let coff: usize = if compressed_at_zero { 0 } else { 8 };
        let expanded_text_size =
            i32::from_le_bytes(header[12 + coff..16 + coff].try_into().unwrap()) as usize;
        let comp_start = page_data_offset as usize + 16 + coff;
        let comp_end = comp_start
            .checked_add(size_of_text_section)
            .and_then(|e| e.checked_sub(16 + coff))
            .ok_or_else(|| {
                CajError::malformed(
                    doc.format,
                    format!(
                        "page {} text section size underflow (offset=0x{:x} size={})",
                        page_index + 1,
                        page_data_offset,
                        size_of_text_section
                    ),
                )
            })?;
        if comp_end > bytes.len() {
            return Err(CajError::malformed(
                doc.format,
                format!(
                    "page {} compressed text at 0x{:x}..0x{:x} past EOF (0x{:x})",
                    page_index + 1,
                    comp_start,
                    comp_end,
                    bytes.len()
                ),
            ));
        }
        let compressed = &bytes[comp_start..comp_end];
        let mut dec = ZlibDecoder::new(compressed);
        let mut out = Vec::with_capacity(expanded_text_size);
        std::io::copy(&mut dec, &mut out).map_err(|e| CajError::Zlib(e.to_string()))?;
        if out.len() != expanded_text_size {
            return Err(CajError::malformed(
                doc.format,
                format!(
                    "page {} text size mismatch: got {} expected {}",
                    page_index + 1,
                    out.len(),
                    expanded_text_size
                ),
            ));
        }
        out
    } else {
        let end = page_data_offset as usize + size_of_text_section;
        if end > bytes.len() {
            return Err(CajError::malformed(
                doc.format,
                format!(
                    "page {} raw text at 0x{:x}..0x{:x} past EOF (0x{:x})",
                    page_index + 1,
                    page_data_offset,
                    end,
                    bytes.len()
                ),
            ));
        }
        bytes[page_data_offset as usize..end].to_vec()
    };

    Ok((decompressed, old_style))
}

/// One 20-byte page-info entry.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PageInfo {
    /// Byte offset of the start of this page's data section.
    pub page_data_offset: i32,
    /// Size in bytes of the text section that follows at `page_data_offset`.
    pub size_of_text_section: i32,
    /// Number of image blocks on this page.
    pub images_per_page: i16,
    /// 1-based page number as stored in the file.
    pub page_no: i16,
    /// Unknown.
    pub unk2: i16,
    /// Padding (still unknown).
    pub _pad: i16,
    /// Offset of the start of the *next* page's data. Used to compute
    /// `page_style` (old-style vs new-style text encoding).
    pub next_page_data_offset: i32,
}

/// See if the page is N x N images, N images written N times, by checking
/// image sizes and within 1 < N <= 10.
///
/// Returns `(true, stride)` if the page is a redundant N x N grid, otherwise
/// `(false, images_per_page)`.
///
/// Matches `utils.find_redundant_images` in the original Python project.
#[allow(dead_code)]
pub fn find_redundant_images<R: Read + Seek>(
    f: &mut R,
    initial_offset: u64,
    images_per_page: u32,
) -> CajResult<(bool, u32)> {
    const SQRT_TABLE: &[(u32, u32)] = &[
        (4, 2),
        (9, 3),
        (16, 4),
        (25, 5),
        (36, 6),
        (49, 7),
        (64, 8),
        (81, 9),
        (100, 10),
    ];

    let stride = match SQRT_TABLE.iter().find(|(n, _)| *n == images_per_page) {
        Some((_, s)) => *s,
        None => return Ok((false, images_per_page)),
    };

    let mut sizes: Vec<i32> = Vec::with_capacity(images_per_page as usize);
    let mut current_offset = initial_offset;
    for j in 0..images_per_page {
        f.seek(SeekFrom::Start(current_offset))?;
        let mut head = [0u8; 12];
        f.read_exact(&mut head)?;
        let _image_type_enum = i32::from_le_bytes(head[0..4].try_into().unwrap());
        let offset_to_image_data = i32::from_le_bytes(head[4..8].try_into().unwrap()) as u64;
        let size_of_image_data = i32::from_le_bytes(head[8..12].try_into().unwrap());
        if (j >= stride) && (size_of_image_data != sizes[(j - stride) as usize]) {
            return Ok((false, images_per_page));
        }
        sizes.push(size_of_image_data);
        current_offset = offset_to_image_data + size_of_image_data as u64;
    }
    Ok((true, stride))
}
