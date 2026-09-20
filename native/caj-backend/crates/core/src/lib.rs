//! # caj2pdf-core
//!
//! Format detection, CAJ/HN parsing, and the high-level `convert::convert`
//! entry point.
//!
//! The shared data types ([`CajError`], [`FileFormat`], [`OutlineEntry`],
//! [`DecodedImage`], [`Page`], [`ImageKind`], [`RawImage`]) live in the
//! `caj2pdf-types` crate and are re-exported here so existing callers
//! (`caj2pdf_core::DecodedImage`, etc.) keep working.

#![deny(missing_debug_implementations)]
#![warn(unreachable_pub)]

use std::path::{Path, PathBuf};

// Re-export the shared data types so callers can keep writing
// `caj2pdf_core::DecodedImage` instead of `caj2pdf_types::DecodedImage`.
pub use caj2pdf_types::{
    CajError, CajResult, DecodedImage, FileFormat, ImageKind, MonoOrientation, OutlineEntry,
    Page, RawImage, TextGlyph,
};

// ---------------------------------------------------------------------------
// Document handle
// ---------------------------------------------------------------------------

/// Handle to an opened CAJ-family file. Cheap to clone (just a `PathBuf` plus
/// cached offsets).
#[derive(Debug, Clone)]
pub struct CajDocument {
    pub(crate) path: PathBuf,
    pub(crate) format: FileFormat,
    pub(crate) page_count: u32,
    pub(crate) toc: Vec<OutlineEntry>,
    /// Offsets into the file that locate the page-data array. These are
    /// format-specific and interpreted by [`crate::hn::iter_pages`].
    pub(crate) layout: Layout,
    /// 完整文件字节（以内存方式打开时）。为 None 时按路径从磁盘读取。
    pub(crate) contents: Option<Vec<u8>>,
}

/// Format-specific page-data layout.
///
/// For HN there are two sub-variants:
///
/// * `with_toc = true`  – the long-form HN file, with an outline at 0x158.
/// * `with_toc = false` – the short-form HN file (`HN\xc8\x00` magic), no
///   outline, page-info table at 0xD8.
#[derive(Debug, Clone)]
pub(crate) enum Layout {
    Caj {
        /// Offset of the first byte of the embedded PDF.
        pdf_start_offset: u64,
    },
    Hn {
        /// Offset of the first 20-byte PageInfo struct.
        page_info_table_offset: u64,
        /// True if the document has an outline tree at 0x158.
        with_toc: bool,
    },
    C8 {
        page_info_table_offset: u64,
    },
    Pdf,
    Kdh,
    Teb,
}

impl CajDocument {
    /// Open a file, detect its format, and read the page count and outline.
    ///
    /// # Errors
    /// * [`CajError::Io`] – the file could not be read.
    /// * [`CajError::UnknownFormat`] – the 4-byte magic is none of the six
    ///   known formats.
    pub fn open<P: AsRef<Path>>(path: P) -> CajResult<Self> {
        let path = path.as_ref().to_path_buf();
        let mut f = std::fs::File::open(&path)?;
        let mut header = [0u8; 4];
        use std::io::Read;
        f.read_exact(&mut header)?;

        // For HN we need to know which sub-variant we have *before* we can
        // pick a layout. The `with_toc` flag is derived from the magic
        // bytes: `HN\xc8\x00` ⇒ no outline, anything else ⇒ outline.
        let (format, hn_with_toc) = detect_format_inner(&header, &mut f)?;
        drop(f);

        let mut doc = Self {
            path,
            format,
            page_count: 0,
            toc: Vec::new(),
            layout: detect_layout(format, hn_with_toc)?,
            contents: None,
        };

        doc.read_page_count_and_toc()?;
        Ok(doc)
    }

    /// Open a document directly from in-memory bytes. Used by the
    /// WebAssembly front-end, where the input arrives as a byte buffer
    /// instead of a file path.
    pub fn from_bytes(bytes: Vec<u8>) -> CajResult<Self> {
        let header: [u8; 4] = bytes.get(..4).ok_or_else(|| {
            CajError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "input too short to contain a format magic",
            ))
        })?.try_into().unwrap();
        let mut cursor = std::io::Cursor::new(&bytes[..]);
        let (format, hn_with_toc) = detect_format_inner(&header, &mut cursor)?;

        let mut doc = Self {
            path: PathBuf::new(),
            format,
            page_count: 0,
            toc: Vec::new(),
            layout: detect_layout(format, hn_with_toc)?,
            contents: Some(bytes),
        };

        doc.read_page_count_and_toc()?;
        Ok(doc)
    }

    /// The raw file bytes: from the in-memory copy when the document was
    /// opened from memory, otherwise read from disk.
    pub(crate) fn file_bytes(&self) -> CajResult<std::borrow::Cow<'_, [u8]>> {
        match &self.contents {
            Some(bytes) => Ok(std::borrow::Cow::Borrowed(bytes)),
            None => Ok(std::borrow::Cow::Owned(std::fs::read(&self.path)?)),
        }
    }

    /// The detected file format.
    pub fn format(&self) -> FileFormat {
        self.format
    }

    /// The number of pages in the document.
    pub fn page_count(&self) -> u32 {
        self.page_count
    }

    /// The number of outline entries (zero for some formats).
    pub fn toc_entry_count(&self) -> usize {
        self.toc.len()
    }

    /// The parsed outline, in the on-disk order.
    pub fn toc(&self) -> &[OutlineEntry] {
        &self.toc
    }

    /// The on-disk path the document was opened from.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Iterate the pages of an HN / C8 document, returning the parsed text and
    /// raw image blocks for each.
    ///
    /// For CAJ / PDF / KDH / TEB, returns
    /// [`CajError::Unsupported`]: use [`CajDocument::extract_pdf`] for CAJ
    /// and PDF, or rely on [`crate::convert::convert`] for the high-level
    /// conversion.
    pub fn pages(&self) -> CajResult<Vec<Page>> {
        crate::hn::iter_pages(self)
    }

    /// Extract the embedded PDF blob of a CAJ document.
    ///
    /// The returned byte slice is the raw PDF as it sits inside the CAJ
    /// container, without any repair. For most workflows you want
    /// [`crate::convert::convert`] instead, which repairs the xref table and
    /// adds outlines.
    pub fn extract_pdf(&self) -> CajResult<Vec<u8>> {
        match self.format {
            FileFormat::Caj => crate::caj::extract_pdf(self),
            FileFormat::Pdf => std::fs::read(&self.path).map_err(CajError::from),
            _ => Err(CajError::Unsupported(
                "extract_pdf is only supported for CAJ and PDF documents",
            )),
        }
    }

    pub(crate) fn read_page_count_and_toc(&mut self) -> CajResult<()> {
        match self.layout {
            Layout::Caj { .. } => crate::caj::read_meta(self),
            Layout::Hn { .. } | Layout::C8 { .. } => crate::hn::read_meta(self),
            Layout::Pdf | Layout::Kdh | Layout::Teb => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Format detection helper (private)
// ---------------------------------------------------------------------------

pub mod convert;

mod caj;
mod hn;
mod hn_page;
pub mod text_render;

fn detect_format_inner<R: std::io::Read + std::io::Seek>(
    header: &[u8; 4],
    _f: &mut R,
) -> CajResult<(FileFormat, Option<bool>)> {
    use std::io::SeekFrom;

    // C8: first byte 0xC8, with a tiny header before page data.
    if header[0] == 0xC8 {
        return Ok((FileFormat::C8, None));
    }

    // HN with binary magic: "HN" + 0xC8 0x00 ⇒ short-form HN (no TOC).
    if &header[0..2] == b"HN" {
        if &header[2..4] == b"\xc8\x00" {
            return Ok((FileFormat::Hn, Some(false)));
        }
        // Fall through to the GBK magic check.
    }

    // Otherwise, interpret the first 4 bytes as GBK-decoded ASCII.
    let decoded = match encoding_rs::GBK.decode(&header[..]) {
        (cow, _, false) => cow.into_owned(),
        _ => {
            return Err(CajError::UnknownFormat(*header));
        }
    };

    // Trim NUL padding (e.g. "CAJ\0").
    let trimmed = decoded.trim_end_matches('\0').to_string();

    let result = match trimmed.as_str() {
        "CAJ" => Ok((FileFormat::Caj, None)),
        // The long-form HN file has a GBK-decoded "HN" magic (the two
        // bytes following "HN" are usually 0x00 0x00, or any pair that
        // decodes to empty / non-ASCII PUA characters that get trimmed).
        "HN" => Ok((FileFormat::Hn, Some(true))),
        "%PDF" => Ok((FileFormat::Pdf, None)),
        "KDH " => Ok((FileFormat::Kdh, None)),
        "TEB" => Ok((FileFormat::Teb, None)),
        _ => {
            // Some HN files have an unusual 2-byte suffix that does not
            // GBK-decode cleanly. We've already handled the
            // "HN\xc8\x00" case above; everything else is unknown.
            let _ = _f.seek(SeekFrom::Start(0));
            Err(CajError::UnknownFormat(*header))
        }
    };
    result
}

/// Public re-export of the internal detection helper, used by the integration
/// tests in `tests/format_detection.rs`.
///
/// The second return value is `Some(true)` / `Some(false)` for HN files,
/// where it indicates whether the document carries an outline tree. For
/// every other format the value is `None`.
#[doc(hidden)]
pub fn detect_format<R: std::io::Read + std::io::Seek>(
    header: &[u8; 4],
    f: &mut R,
) -> CajResult<(FileFormat, Option<bool>)> {
    detect_format_inner(header, f)
}

pub(crate) fn detect_layout(
    format: FileFormat,
    hn_with_toc: Option<bool>,
) -> CajResult<Layout> {
    Ok(match format {
        FileFormat::Caj => Layout::Caj {
            pdf_start_offset: 0,
        },
        FileFormat::Hn => Layout::Hn {
            page_info_table_offset: 0,
            with_toc: hn_with_toc.unwrap_or(true),
        },
        FileFormat::C8 => Layout::C8 {
            page_info_table_offset: 0,
        },
        FileFormat::Pdf => Layout::Pdf,
        FileFormat::Kdh => Layout::Kdh,
        FileFormat::Teb => Layout::Teb,
    })
}
