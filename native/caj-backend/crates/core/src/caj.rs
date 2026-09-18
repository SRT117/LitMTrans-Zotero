//! CAJ-format specific reading logic.
//!
//! See `docs/format-analysis.md` for the byte-level layout this module parses.
//!
//! A CAJ file wraps an (often slightly mangled) PDF document together with a
//! page count and an optional outline. The page count lives at offset 0x10
//! and the outline tree starts at 0x110. The PDF itself is pointed to by a
//! 4-byte little-endian offset at 0x14, which in turn points to another
//! 4-byte LE offset – the start of the PDF bytes inside the container.

use crate::{CajDocument, CajError, CajResult, Layout, OutlineEntry};
use byteorder::{LittleEndian, ReadBytesExt};
use std::io::{Read, Seek, SeekFrom};

const PAGE_COUNT_OFFSET: u64 = 0x10;
const PDF_START_POINTER_OFFSET: u64 = 0x14;
const TOC_COUNT_OFFSET: u64 = 0x110;
const TOC_ENTRY_SIZE: usize = 0x134;

/// Read the page count and (optionally) the table of contents for a CAJ file,
/// then patch the document's layout with the actual offsets.
pub(crate) fn read_meta(doc: &mut CajDocument) -> CajResult<()> {
    let mut f = std::fs::File::open(&doc.path)?;

    // Page count is at offset 0x10.
    f.seek(SeekFrom::Start(PAGE_COUNT_OFFSET))?;
    let page_count = f.read_i32::<LittleEndian>()?;
    if page_count < 0 {
        return Err(CajError::malformed(
            doc.format,
            format!("page count must be non-negative, got {page_count}"),
        ));
    }
    doc.page_count = page_count as u32;

    // Outline tree.
    f.seek(SeekFrom::Start(TOC_COUNT_OFFSET))?;
    let toc_count = f.read_i32::<LittleEndian>()?;
    if toc_count < 0 {
        return Err(CajError::malformed(
            doc.format,
            format!("toc count must be non-negative, got {toc_count}"),
        ));
    }
    doc.toc = Vec::with_capacity(toc_count as usize);
    for i in 0..toc_count as u64 {
        let offset = TOC_COUNT_OFFSET + 4 + i * TOC_ENTRY_SIZE as u64;
        f.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; TOC_ENTRY_SIZE];
        f.read_exact(&mut buf)?;
        // Layout of each entry (308 bytes):
        //   0x000..0x100  title (256 bytes GBK, NUL-terminated)
        //   0x100..0x118  unknown 24 bytes
        //   0x118..0x124  page number (12 ASCII bytes, NUL-terminated)
        //   0x124..0x130  unknown 12 bytes
        //   0x130..0x134  level (4-byte int32, little-endian)
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

        doc.toc.push(OutlineEntry { title, page, level });
    }

    // Resolve the PDF start. The 4-byte LE integer at 0x14 is an offset
    // pointing to another 4-byte LE integer that is the actual PDF start.
    f.seek(SeekFrom::Start(PDF_START_POINTER_OFFSET))?;
    let pdf_start_pointer = f.read_u32::<LittleEndian>()? as u64;
    f.seek(SeekFrom::Start(pdf_start_pointer))?;
    let pdf_start = f.read_u32::<LittleEndian>()? as u64;

    doc.layout = Layout::Caj {
        pdf_start_offset: pdf_start,
    };

    Ok(())
}

/// Extract the embedded PDF bytes from a CAJ file.
///
/// The returned `Vec<u8>` is the raw PDF as it sits inside the container
/// (no repair, no outline injection). It starts at the resolved PDF offset
/// and runs through the last `endobj` of the embedded PDF, as in
/// `cajparser._convert_caj`.
pub(crate) fn extract_pdf(doc: &CajDocument) -> CajResult<Vec<u8>> {
    let pdf_start = match doc.layout {
        Layout::Caj { pdf_start_offset } => pdf_start_offset,
        _ => {
            return Err(CajError::Unsupported(
                "extract_pdf called on a non-CAJ document",
            ));
        }
    };

    // Read the whole file. The original Python scans the file for the
    // last `endobj`; the cost of a full read is negligible compared to
    // building the PDF, and it keeps the code simple and correct.
    let bytes = std::fs::read(&doc.path)?;
    let endobj = b"endobj";
    let last_endobj = bytes
        .windows(endobj.len())
        .rposition(|w| w == endobj)
        .map(|p| p + endobj.len())
        .unwrap_or(bytes.len());

    // If the slice after the last `endobj` contains an `xref` and a
    // `%%EOF` marker, include them — the downstream lopdf parser needs
    // the xref to read the PDF. Real CAJ files have neither (they store
    // raw PDF objects only), so this branch is a no-op for them but
    // helps callers that wrap a complete PDF in a CAJ container.
    let after = &bytes[last_endobj.min(bytes.len())..];
    let has_xref = after.windows(4).any(|w| w == b"xref");
    let has_eof = after.windows(5).any(|w| w == b"%%EOF");
    let pdf_end = if has_xref && has_eof {
        bytes
            .windows(5)
            .rposition(|w| w == b"%%EOF")
            .map(|p| p + 5)
            .unwrap_or(last_endobj)
    } else {
        last_endobj
    };

    if (pdf_start as usize) > pdf_end {
        return Err(CajError::malformed(
            doc.format,
            format!(
                "pdf_start (0x{:x}) is past the last endobj (0x{:x})",
                pdf_start, pdf_end
            ),
        ));
    }

    let pdf_data = &bytes[pdf_start as usize..pdf_end];

    // The original Python prepends a "%PDF-1.3\r\n" header and appends a
    // trailing "\r\n". We follow the same convention so downstream mutool /
    // lopdf tooling sees a well-formed header — but we skip the prepend if
    // the slice already starts with a %PDF- marker (this happens when the
    // CAJ file was constructed from a real, full PDF rather than a header-
    // less raw body).
    let mut out = Vec::with_capacity(pdf_data.len() + 16);
    let already_has_header = pdf_data.starts_with(b"%PDF-");
    if !already_has_header {
        out.extend_from_slice(b"%PDF-1.3\r\n");
    }
    out.extend_from_slice(pdf_data);
    if !already_has_header {
        out.extend_from_slice(b"\r\n");
    }
    Ok(out)
}
