//! Shared data types for the caj2pdf-rs workspace.
//!
//! This crate exists to break a circular dependency between
//! `caj2pdf-core` and `caj2pdf-pdf`:
//!
//! * `caj2pdf-pdf` needs [`DecodedImage`] and [`OutlineEntry`] to build
//!   PDF pages.
//! * `caj2pdf-core` needs `caj2pdf-pdf` to assemble the final PDF in
//!   `convert::convert` (so the GUI and CLI can share one entry point).
//!
//! Lifting these two types into a leaf crate that both depend on keeps
//! the workspace a DAG. See `docs/architecture.md` for the full picture.

#![deny(missing_debug_implementations)]
#![warn(unreachable_pub)]

use thiserror::Error;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that can occur while opening, parsing, or extracting pages
/// from a CAJ-family file.
#[derive(Debug, Error)]
pub enum CajError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("unsupported or unknown file type (magic bytes: {0:?})")]
    UnknownFormat([u8; 4]),

    #[error("unsupported feature: {0}")]
    Unsupported(&'static str),

    #[error("malformed {format:?} file: {message}")]
    Malformed {
        format: FileFormat,
        message: String,
    },

    #[error("page index {index} out of range (page count is {count})")]
    PageOutOfRange { index: usize, count: usize },

    #[error("text decoding error: {0}")]
    Text(String),

    #[error("zlib decompression failed: {0}")]
    Zlib(String),
}

impl CajError {
    /// Convenience constructor for the [`CajError::Malformed`] variant.
    pub fn malformed(format: FileFormat, message: impl Into<String>) -> Self {
        CajError::Malformed {
            format,
            message: message.into(),
        }
    }
}

pub type CajResult<T> = std::result::Result<T, CajError>;

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

/// The on-disk format of an academic-journal file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileFormat {
    /// Older CAJ format.
    Caj,
    /// HN8 / HN format.
    Hn,
    /// "C8" magic byte followed by a tiny header before page data.
    C8,
    /// PDF wrapped in a CAJ container.
    Pdf,
    /// KDH encrypted format.
    Kdh,
    /// Teb/Apabi format.
    Teb,
}

impl std::fmt::Display for FileFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            FileFormat::Caj => "CAJ",
            FileFormat::Hn => "HN",
            FileFormat::C8 => "C8",
            FileFormat::Pdf => "PDF",
            FileFormat::Kdh => "KDH",
            FileFormat::Teb => "TEB",
        };
        f.write_str(s)
    }
}

// ---------------------------------------------------------------------------
// Table of contents / outlines
// ---------------------------------------------------------------------------

/// One entry in the document's outline / table of contents.
///
/// `page` is 1-based.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineEntry {
    pub title: String,
    pub page: u32,
    pub level: u8,
}

// ---------------------------------------------------------------------------
// Page data model
// ---------------------------------------------------------------------------

/// Codec used to encode a single page image inside the container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageKind {
    /// Custom JBIG1 variant.
    Jbig1,
    /// JBIG2.
    Jbig2,
    /// JPEG (possibly upside-down depending on the variant byte).
    Jpeg { upside_down: bool },
}

/// Vertical transform required when a decoded monochrome bitmap is painted
/// into a PDF page.
///
/// CAJViewer's JBIG1 and JBIG2 decoders expose the same bitmap shape but not
/// the same row-origin convention.  Keeping that fact on the decoded value
/// prevents the PDF layer from applying one transform to every codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MonoOrientation {
    /// Paint with the normal PDF image matrix.
    Normal,
    /// Paint with a negative Y scale and translate back into the page.
    FlipVertical,
}

/// A still-undecoded image block.
#[derive(Debug, Clone)]
pub struct RawImage {
    pub kind: ImageKind,
    pub data: Vec<u8>,
    pub width_px: u32,
    pub height_px: u32,
}

/// A decoded image ready to be embedded in a PDF.
#[derive(Debug, Clone)]
pub enum DecodedImage {
    /// 1-bit-per-pixel monochrome bitmap.
    Mono {
        width_px: u32,
        height_px: u32,
        orientation: MonoOrientation,
        /// Packed bits, one byte per row padded to 8 pixels.
        bits: Vec<u8>,
    },
    /// 8-bit JPEG.
    Jpeg {
        width_px: u32,
        height_px: u32,
        jpeg_bytes: Vec<u8>,
    },
}

impl DecodedImage {
    /// Pixel width of the image.
    pub fn width_px(&self) -> u32 {
        match self {
            DecodedImage::Mono { width_px, .. } => *width_px,
            DecodedImage::Jpeg { width_px, .. } => *width_px,
        }
    }

    /// Pixel height of the image.
    pub fn height_px(&self) -> u32 {
        match self {
            DecodedImage::Mono { height_px, .. } => *height_px,
            DecodedImage::Jpeg { height_px, .. } => *height_px,
        }
    }
}

/// One positioned character from a WITS/SBS2 page stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextGlyph {
    /// Horizontal position in the format's native page units.
    pub x: u32,
    /// Vertical position in the format's native page units.
    pub y: u32,
    pub character: char,
}

/// Raw content of a single page.
#[derive(Debug, Clone, Default)]
pub struct Page {
    /// Plain text extracted from the dispatch records (GBK → UTF-8).
    pub text: String,
    /// Image blocks present on this page, in the order they appear.
    pub images: Vec<RawImage>,
    pub figures: Vec<[u16; 4]>,
    /// Positioned characters from the newer C8 WITS/SBS2 stream.
    pub glyphs: Vec<TextGlyph>,
    /// Native page dimensions when the stream declares them.
    pub logical_size: Option<(u32, u32)>,
}
