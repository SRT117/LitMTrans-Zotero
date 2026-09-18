//! Thin shim that delegates to `caj2pdf_core::convert::convert`.
//!
//! The full pipeline used to live in this file. Moving it into
//! `caj2pdf-core` lets the GUI (and any future front-end) share one
//! implementation. This shim exists only to convert
//! `caj2pdf_core::CajError` into `anyhow::Error` so the CLI's
//! `Result<()>` return type is preserved.

use std::path::Path;

use anyhow::{Context, Result};

/// Convert a CAJ-family file to a PDF.
///
/// See [`caj2pdf_core::convert::convert`] for the per-format pipeline.
pub fn run(input: &Path, output: &Path) -> Result<()> {
    caj2pdf_core::convert::convert(input, output)
        .map_err(anyhow::Error::new)
        .with_context(|| format!("converting {} -> {}", input.display(), output.display()))
}
