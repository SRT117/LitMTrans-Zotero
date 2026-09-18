//! # caj2pdf-jbig1
//!
//! Pure-Rust port of the **custom** JBIG1 decoder found in CAJViewer's
//! `libreaderex_x64.so`.
//!
//! The reference implementation is `JBigDecode.cc` in the original
//! `caj2pdf` repository; this module mirrors its behavior bit-for-bit so
//! that JBIG1 images extracted from a CAJ/HN file decode identically.
//!
//! ## Why a custom port?
//!
//! The standard `jbig-kit` library assumes a 14-context adaptive
//! template. CNKI's JBIG1 encoder uses only 5 contexts (MPS/ST tables
//! of length `0x1000` indexed by an at-most-8-bit SLNTP register),
//! uses 3-bit shifts in `GetBit` (`bit_offset / 3` instead of
//! `bit_offset >> 3`), and uses a custom SLNTP/LNTP predictor.
//! Substituting the standard codec silently produces wrong pixels for
//! real-world files.
//!
//! See `docs/jbig1-reverse-notes.md` for the line-by-line analysis.

#![deny(missing_debug_implementations)]
#![warn(unreachable_pub)]

mod codec;

use thiserror::Error;

pub use codec::{
    bits_per_pixel_from_header, bytes_per_line, dimensions_from_header, CNKI_HEADER_LEN,
};

/// Errors produced by the JBIG1 decoder.
#[derive(Debug, Error)]
pub enum JbigError {
    #[error("input buffer is too short: need {need} bytes, got {got}")]
    ShortInput { need: usize, got: usize },
    #[error("invalid image header: {0}")]
    InvalidHeader(String),
    #[error("decoder arithmetic error: {0}")]
    Arithmetic(String),
}

pub type JbigResult<T> = std::result::Result<T, JbigError>;

/// The decoded bitmap.
#[derive(Debug, Clone)]
pub struct Bitmap {
    /// Image width in pixels (1 bpp).
    pub width: u32,
    /// Image height in pixels.
    pub height: u32,
    /// Packed bits, one byte per row padded to the next 8-pixel boundary.
    /// Bits within a byte are stored MSB-first, matching the rest of the
    /// `caj2pdf-rs` codebase.
    pub bits: Vec<u8>,
}

impl Bitmap {
    /// Padded width in bytes (8 pixels per byte).
    pub fn row_bytes(&self) -> usize {
        ((self.width as usize) + 7) / 8
    }
}

/// Decode a JBIG1 image.
///
/// `input` is the raw image data **including** the 48-byte CNKI header
/// that prefixes every JBIG1 stream produced by CAJViewer. The `width`
/// and `height` arguments are taken to be authoritative: the
/// implementation will not re-parse them from the header (it does
/// re-read the bits-per-pixel field at offset 14, however, since the
/// row stride depends on it).
///
/// The output bitmap stores one byte per row padded to 8 pixels, with
/// bits in MSB-first order (column 0 = bit 0x80, column 7 = bit 0x01).
pub fn decode(input: &[u8], width: u32, height: u32) -> JbigResult<Bitmap> {
    if input.len() < CNKI_HEADER_LEN {
        return Err(JbigError::ShortInput {
            need: CNKI_HEADER_LEN,
            got: input.len(),
        });
    }
    let bpp = bits_per_pixel_from_header(input)
        .ok_or_else(|| JbigError::InvalidHeader("header is shorter than 16 bytes".to_string()))?;
    let padded_stride = bytes_per_line(width, u32::from(bpp)) as usize;
    let tight_stride = ((width as usize) + 7) / 8;
    let out_len = (height as usize)
        .checked_mul(padded_stride)
        .ok_or_else(|| JbigError::Arithmetic("output size overflow".to_string()))?;
    let mut padded_bits = vec![0u8; out_len];

    let mut codec_inst = codec::JBigCodec::new();
    let stream = &input[CNKI_HEADER_LEN..];
    codec_inst.decode(
        stream,
        stream.len(),
        height,
        width,
        padded_stride as u32,
        &mut padded_bits,
    )?;

    // CAJViewer's decoder uses 32-bit-aligned rows internally because that
    // is part of the private JBIG1 format. The public bitmap contract uses
    // only the normal 8-pixel row padding, so normalize the stride here.
    let mut bits = vec![0u8; tight_stride.saturating_mul(height as usize)];
    for row in 0..height as usize {
        let src_start = row * padded_stride;
        let dst_start = row * tight_stride;
        bits[dst_start..dst_start + tight_stride]
            .copy_from_slice(&padded_bits[src_start..src_start + tight_stride]);
    }

    Ok(Bitmap {
        width,
        height,
        bits,
    })
}
