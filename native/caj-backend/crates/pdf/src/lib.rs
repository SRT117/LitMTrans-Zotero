//! # caj2pdf-pdf
//!
//! PDF document assembly and outline injection for caj2pdf-rs.
//!
//! Two responsibilities:
//!
//! 1. Build a fresh PDF document from a list of decoded page images
//!    (mono bitmaps + JPEG), using the lopdf crate for low-level PDF
//!    object construction.
//! 2. Inject a `/Outlines` tree (table of contents) into an existing
//!    PDF document.
//!
//! ## Design
//!
//! This crate uses [lopdf](https://crates.io/crates/lopdf) for all
//! PDF object construction. The original `caj2pdf` Python project
//! hand-wrote every byte (see `pdfwutils.py`, ~3 200 lines), which
//! made cross-reference management, incremental updates, and object
//! renumbering error-prone. lopdf 0.33 handles those concerns for us,
//! leaving us free to focus on the caj2pdf-specific bits:
//! the 1-bpp mono / DCT JPEG image embedding and the BTree
//! outline construction.
//!
//! See [`builder`] for the document builder and [`outlines`] for the
//! outline injection.

#![deny(missing_debug_implementations)]
#![warn(unreachable_pub)]

use thiserror::Error;
use caj2pdf_types::{CajError, DecodedImage, OutlineEntry};

pub mod builder;
pub mod outlines;

/// Errors that may occur while assembling a PDF.
#[derive(Debug, Error)]
pub enum PdfError {
    #[error("PDF construction failed: {0}")]
    Lopdf(#[from] lopdf::Error),
    #[error("I/O error during PDF write: {0}")]
    Io(#[from] std::io::Error),
    #[error("page assembly error: {0}")]
    Assembly(String),
    #[error("core error: {0}")]
    Core(#[from] CajError),
}

impl PdfError {
    /// Wrap a `std::io::Error` so call sites that already match on
    /// `lopdf::Error` can use the same `?` operator.
    pub fn from_io(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

pub type PdfResult<T> = std::result::Result<T, PdfError>;

/// A single page ready to be assembled into a PDF, with the image to embed
/// and any extracted text.
#[derive(Debug, Clone)]
pub struct PageInput {
    pub image: DecodedImage,
    /// 底图在页面内的归一化位置与尺寸。
    pub image_rect: [f64; 4],
    /// Optional plain text overlay (HN-format files only).
    pub text_overlay: Option<String>,
    pub layers: Vec<(DecodedImage, [f64; 4])>,
    /// 显式页面尺寸（像素）。缺省时以底层图片尺寸作为页面大小；
    /// 用于多图堆叠页面与空白占位页。
    pub page_size: Option<(u32, u32)>,
}

impl PageInput {
    /// Convenience constructor for a page containing a single decoded image.
    pub fn new(image: DecodedImage) -> Self {
        Self {
            image,
            image_rect: [0.0, 0.0, 1.0, 1.0],
            text_overlay: None,
            layers: Vec::new(),
            page_size: None,
        }
    }
}

/// Build a fresh PDF document from a sequence of page images.
///
/// The returned `Vec<u8>` is a complete, valid PDF file (not a `lopdf::Document`),
/// ready to be written to disk.
///
/// # Coordinate system
///
/// The PDF page is sized at 300 DPI, so 1 pixel = 1 point: an image of
/// `W x H` pixels is rendered onto a `W x H` point `/MediaBox`.
pub fn build_document(pages: &[PageInput], outlines: &[OutlineEntry]) -> PdfResult<Vec<u8>> {
    builder::build_document(pages, outlines)
}

/// Inject an outline tree into an existing PDF.
///
/// The existing PDF is parsed with `lopdf::Document::load`, the outline
/// tree is added as a top-level `/Outlines` dictionary hanging off
/// `/Catalog`, and the document is re-serialized. Existing pages and
/// resources are untouched.
pub fn inject_outlines(
    existing_pdf: &[u8],
    outlines: &[OutlineEntry],
) -> PdfResult<Vec<u8>> {
    outlines::inject_outlines(existing_pdf, outlines)
}
