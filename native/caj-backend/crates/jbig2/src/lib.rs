//! # caj2pdf-jbig2
//!
//! JBIG2 stream decoder for caj2pdf-rs.
//!
//! This crate is a thin wrapper around the pure-Rust
//! [`pdfluent-jbig2`](https://crates.io/crates/pdfluent-jbig2) crate, which
//! implements ITU-T T.88 (JBIG2) decoding in 100% safe Rust. We use it to
//! keep the entire caj2pdf-rs binary free of C dependencies — no
//! `libjbig2dec`, no `pkg-config`, no platform-specific shared libraries.
//!
//! See `docs/jbig2-notes.md` for the CNKI image-header layout and the
//! `bytes_per_line` / `width_in_bytes` math.

#![deny(missing_debug_implementations)]
#![warn(unreachable_pub)]

use pdfluent_jbig2::Decoder;
use thiserror::Error;

/// Errors produced by the JBIG2 decoder.
#[derive(Debug, Error)]
pub enum Jbig2Error {
    #[error("input buffer is too short: need {need} bytes, got {got}")]
    ShortInput { need: usize, got: usize },
    #[error("JBIG2 decode failed: {0}")]
    Decode(String),
}

pub type Jbig2Result<T> = std::result::Result<T, Jbig2Error>;

/// The decoded bitmap (1 bit per pixel, MSB-first within each byte).
#[derive(Debug, Clone)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub bits: Vec<u8>,
}

impl Bitmap {
    pub fn row_bytes(&self) -> usize {
        ((self.width as usize) + 7) / 8
    }
}

/// Number of header bytes prepended to every JBIG2 image in a CNKI
/// `CImage` blob.  See `docs/jbig2-notes.md` for the full layout.
const CNKI_HEADER_LEN: usize = 48;

/// A `pdfluent_jbig2::Decoder` that accumulates pixels into a packed
/// 1-bpp byte buffer, MSB-first within each byte.
struct BitmapSink {
    width: u32,
    height: u32,
    row_bytes: usize,
    bits: Vec<u8>,
    /// Index of the next bit to write (`0..row_bytes*8`).
    cursor: usize,
}

impl BitmapSink {
    fn new(width: u32, height: u32) -> Self {
        let row_bytes = ((width as usize) + 7) / 8;
        Self {
            width,
            height,
            row_bytes,
            bits: vec![0u8; row_bytes * (height as usize)],
            cursor: 0,
        }
    }

    fn push(&mut self, black: bool) {
        if self.cursor >= self.bits.len() * 8 {
            return; // ignore trailing padding from the decoder
        }
        if black {
            let byte = self.cursor >> 3;
            let bit = 7 - (self.cursor & 7);
            self.bits[byte] |= 1 << bit;
        }
        self.cursor += 1;
    }
}

impl Decoder for BitmapSink {
    fn push_pixel(&mut self, black: bool) {
        self.push(black);
    }

    fn push_pixel_chunk(&mut self, black: bool, chunk_count: u32) {
        // 8 pixels per chunk. The pdfluent-jbig2 docs guarantee the byte
        // counter is always a multiple of 8 when this is called.
        for _ in 0..chunk_count {
            for _ in 0..8 {
                self.push(black);
            }
        }
    }

    fn next_line(&mut self) {
        // Round the cursor up to the next byte boundary so the next row
        // starts on a clean byte. pdfluent-jbig2 expects next_line() to
        // be called once per output row, and the cursor is a multiple of
        // 8 by the time push_pixel_chunk is called.
        self.cursor = (self.cursor + 7) & !7;
    }
}

/// Decode a JBIG2 image extracted from a CNKI `CImage` blob.
pub fn decode(input: &[u8], width: u32, height: u32) -> Jbig2Result<Bitmap> {
    if input.len() < CNKI_HEADER_LEN {
        return Err(Jbig2Error::ShortInput {
            need: CNKI_HEADER_LEN,
            got: input.len(),
        });
    }
    let stream = &input[CNKI_HEADER_LEN..];

    let img = pdfluent_jbig2::decode_embedded(stream, None)
        .map_err(|e| Jbig2Error::Decode(e.to_string()))?;

    if img.width != width || img.height != height {
        return Err(Jbig2Error::Decode(format!(
            "size mismatch: JBIG2 reported {}x{}, caller expected {}x{}",
            img.width, img.height, width, height
        )));
    }

    let mut sink = BitmapSink::new(width, height);
    img.decode(&mut sink);
    Ok(Bitmap {
        width,
        height,
        bits: sink.bits,
    })
}
