//! Smoke tests for the caj2pdf-jbig2 pure-Rust wrapper.
//!
//! The pure-Rust pdfluent-jbig2 crate has its own exhaustive test
//! suite, so we don't try to round-trip a real JBIG2 bitstream here
//! either. Instead we verify:
//!   1. The 48-byte CNKI header is honoured: a 47-byte input is
//!      rejected with ShortInput before any decoder call.
//!   2. The link line works and the call sequence does not panic:
//!      garbage input produces a Jbig2Error.
//!   3. The Bitmap helper is sound.
//!   4. A purely Rust build (no C compiler, no pkg-config, no
//!      libjbig2dec) succeeds — this is the whole point of the
//!      rewrite.

use caj2pdf_jbig2::{decode, Bitmap, Jbig2Error};

/// Build a 48-byte CNKI `CImage` header with the given width/height
/// and a guaranteed 0 num_planes/bits_per_pixel suffix.
fn cnki_header(width: u32, height: u32) -> [u8; 48] {
    let mut h = [0u8; 48];
    h[4..8].copy_from_slice(&width.to_le_bytes());
    h[8..12].copy_from_slice(&height.to_le_bytes());
    h
}

#[test]
fn decode_rejects_short_input() {
    let input = [0u8; 47];
    let err = decode(&input, 1, 1).expect_err("47-byte input must be rejected");
    match err {
        Jbig2Error::ShortInput { need, got } => {
            assert_eq!(need, 48, "ShortInput must report the 48-byte CNKI header size");
            assert_eq!(got, 47);
        }
        other => panic!("expected ShortInput, got {other:?}"),
    }
}

#[test]
fn decode_returns_an_error_on_garbage_input() {
    let width = 8u32;
    let height = 8u32;
    let mut buf = cnki_header(width, height).to_vec();
    buf.extend_from_slice(&[0xFFu8; 64]); // 64 bytes of garbage JBIG2 "stream"
    let result = decode(&buf, width, height);
    assert!(
        result.is_err(),
        "garbage input must be rejected, got Ok({:?})",
        result.map(|b| (b.width, b.height, b.bits.len()))
    );
}

#[test]
fn decode_zero_width_does_not_panic() {
    let buf = cnki_header(0, 0).to_vec();
    let _ = decode(&buf, 0, 0);
}

#[test]
fn bitmap_construction_roundtrip() {
    let bits = vec![0b1010_1010, 0b0101_0101];
    let bm = Bitmap {
        width: 16,
        height: 1,
        bits: bits.clone(),
    };
    assert_eq!(bm.row_bytes(), 2);
    assert_eq!(bm.bits, bits);
}
