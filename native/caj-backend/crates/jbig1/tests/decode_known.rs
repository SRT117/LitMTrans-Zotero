//! Integration tests for the JBIG1 decoder against hand-crafted inputs.
//!
//! These tests don't have real CAJViewer streams to compare against (that
//! requires the proprietary encoder), but they do exercise the
//! `bytes_per_line` formula, the 48-byte CNKI header layout, and the
//! `Bitmap` row-packing convention that the rest of `caj2pdf-rs`
//! relies on.

use caj2pdf_jbig1::{bytes_per_line, decode, Bitmap, CNKI_HEADER_LEN};

/// Build a synthetic 48-byte CNKI image header with the given
/// dimensions and bits-per-pixel.
fn make_cnki_header(width: u32, height: u32, bits_per_pixel: u16) -> [u8; CNKI_HEADER_LEN] {
    let mut buf = [0u8; CNKI_HEADER_LEN];
    buf[4..8].copy_from_slice(&width.to_le_bytes());
    buf[8..12].copy_from_slice(&height.to_le_bytes());
    buf[14..16].copy_from_slice(&bits_per_pixel.to_le_bytes());
    buf
}

/// Assert that the `bytes_per_line` formula matches the C `jbigdec.cc`
/// expression `((W * bpp + 31) >> 5) << 2` for a small sweep of
/// representative inputs.
#[test]
fn bytes_per_line_matches_c_formula() {
    // 1 bpp: the typical case for CAJ images.
    assert_eq!(bytes_per_line(1, 1), 4);
    assert_eq!(bytes_per_line(8, 1), 4);
    assert_eq!(bytes_per_line(16, 1), 4);
    assert_eq!(bytes_per_line(32, 1), 4);
    assert_eq!(bytes_per_line(33, 1), 8);
    assert_eq!(bytes_per_line(64, 1), 8);
    assert_eq!(bytes_per_line(100, 1), 16); // 100*1+31=131, 131>>5=4, 4<<2=16
    assert_eq!(bytes_per_line(800, 1), 100); // 800*1+31=831, 831>>5=25, 25<<2=100
    assert_eq!(bytes_per_line(1024, 1), 128);

    // 8 bpp: just to exercise the multiplier path.
    assert_eq!(bytes_per_line(8, 8), 8);
    assert_eq!(bytes_per_line(16, 8), 16);

    // 4 bpp: another non-1-bpp case.
    assert_eq!(bytes_per_line(8, 4), 4);
    assert_eq!(bytes_per_line(16, 4), 8);
}

/// The decoder must reject inputs shorter than 48 bytes with a
/// `ShortInput` error.
#[test]
fn decode_rejects_short_input() {
    // Zero-length input: clearly not enough for the 48-byte header.
    let res = decode(&[], 0, 0);
    assert!(res.is_err(), "expected error for empty input, got {res:?}");
    let err = res.err().unwrap();
    assert!(
        matches!(err, caj2pdf_jbig1::JbigError::ShortInput { .. }),
        "expected ShortInput, got {err:?}"
    );

    // 47 bytes: still one short of the 48-byte header.
    let mut buf = vec![0u8; 47];
    buf[4..8].copy_from_slice(&16u32.to_le_bytes());
    buf[8..12].copy_from_slice(&8u32.to_le_bytes());
    let res = decode(&buf, 16, 8);
    assert!(res.is_err());
}

/// The decoder must expose 8-pixel-byte-aligned rows even though the
/// private CAJViewer decoder uses 32-bit-aligned rows internally.
#[test]
fn decode_allocates_correct_output_size() {
    // 16x8 image, 1 bpp.
    let header = make_cnki_header(16, 8, 1);
    // Append 4 bytes of "junk" stream so the decoder has something
    // to consume. The exact pixel content doesn't matter for this
    // test, only the allocation.
    let mut input = Vec::from(&header[..]);
    input.extend_from_slice(&[0u8; 4]);

    let bm: Bitmap = decode(&input, 16, 8).expect("decode should succeed");
    assert_eq!(bm.width, 16);
    assert_eq!(bm.height, 8);
    // Public rows use 2 bytes, so total = 8 * 2 = 16 bytes.
    assert_eq!(bm.bits.len(), 16);
    assert_eq!(bm.row_bytes(), 2);
}

/// A 16x8 1-bpp image with a deterministic input stream should
/// decode into a 32-byte `bits` buffer (the precise pixel content
/// depends on the SLNTP arithmetic stream; we only check that the
/// buffer exists and is the right size).
#[test]
fn decode_handcrafted_16x8_image() {
    let header = make_cnki_header(16, 8, 1);
    // A small arithmetic stream. The values were picked arbitrarily;
    // the goal is to confirm that the codec runs end-to-end without
    // panicking on a real input and that the output is the right
    // size and the right dimensions.
    let stream: [u8; 8] = [0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70];
    let mut input = Vec::from(&header[..]);
    input.extend_from_slice(&stream);

    let bm = decode(&input, 16, 8).expect("decode must succeed");
    assert_eq!(bm.width, 16);
    assert_eq!(bm.height, 8);
    assert_eq!(bm.bits.len(), 8 * 2);
}

/// A 0-height image must not crash and must return an
/// appropriately-sized (empty) `bits` buffer.
#[test]
fn decode_zero_height_image() {
    let header = make_cnki_header(16, 0, 1);
    let mut input = Vec::from(&header[..]);
    input.extend_from_slice(&[0u8; 16]);

    let bm = decode(&input, 16, 0).expect("decode of zero-height image");
    assert_eq!(bm.width, 16);
    assert_eq!(bm.height, 0);
    assert!(bm.bits.is_empty());
    assert_eq!(bm.row_bytes(), 2);
}
