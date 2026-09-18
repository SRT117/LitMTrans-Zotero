//! Integration tests for the format-detection logic in `caj2pdf-core`.
//!
//! These tests construct an in-memory 16-byte buffer for each of the six
//! supported file formats and verify that
//! [`caj2pdf_core::detect_format`] returns the right [`FileFormat`].
//!
//! The 16-byte buffer is wrapped in a [`std::io::Cursor`] so that we satisfy
//! the `Read + Seek` bound on the detection API without touching the real
//! filesystem.
//!
//! Run with: `cargo test -p caj2pdf-core --test format_detection`

use std::io::Cursor;

use caj2pdf_core::{CajDocument, CajError, FileFormat};

/// Run the detection API on the first 4 bytes of `bytes`, treating the rest
/// of the buffer as the rest of the file.
fn detect(bytes: &[u8]) -> Result<(FileFormat, Option<bool>), CajError> {
    assert!(bytes.len() >= 4, "test buffers must be at least 4 bytes");
    let mut cursor = Cursor::new(bytes.to_vec());
    let mut header = [0u8; 4];
    use std::io::Read;
    cursor.read_exact(&mut header).unwrap();
    caj2pdf_core::detect_format(&header, &mut cursor)
}

// ---------------------------------------------------------------------------
// One test per format
// ---------------------------------------------------------------------------

#[test]
fn detect_c8() {
    // C8: first byte is 0xC8.
    let mut buf = vec![0u8; 16];
    buf[0] = 0xC8;
    let (fmt, with_toc) = detect(&buf).expect("C8 should be detected");
    assert_eq!(fmt, FileFormat::C8);
    assert_eq!(with_toc, None);
}

#[test]
fn detect_hn_binary_magic() {
    // "HN" + 0xC8 + 0x00 ⇒ the short-form HN variant (no outline).
    let mut buf = vec![0u8; 16];
    buf[0] = b'H';
    buf[1] = b'N';
    buf[2] = 0xC8;
    buf[3] = 0x00;
    let (fmt, with_toc) = detect(&buf).expect("HN\\xc8\\x00 should be detected");
    assert_eq!(fmt, FileFormat::Hn);
    assert_eq!(with_toc, Some(false));
}

#[test]
fn detect_hn_gbk_magic() {
    // "HN\0\0" decodes to "HN" under GBK after NUL trimming.
    let mut buf = vec![0u8; 16];
    buf[0] = b'H';
    buf[1] = b'N';
    let (fmt, with_toc) = detect(&buf).expect("HN (GBK) should be detected");
    assert_eq!(fmt, FileFormat::Hn);
    assert_eq!(with_toc, Some(true));
}

#[test]
fn detect_caj() {
    // "CAJ" + NUL pad.
    let mut buf = vec![0u8; 16];
    buf[0] = b'C';
    buf[1] = b'A';
    buf[2] = b'J';
    let (fmt, with_toc) = detect(&buf).expect("CAJ should be detected");
    assert_eq!(fmt, FileFormat::Caj);
    assert_eq!(with_toc, None);
}

#[test]
fn detect_pdf() {
    // "%PDF" – exact match.
    let mut buf = vec![0u8; 16];
    buf[0] = b'%';
    buf[1] = b'P';
    buf[2] = b'D';
    buf[3] = b'F';
    let (fmt, with_toc) = detect(&buf).expect("PDF should be detected");
    assert_eq!(fmt, FileFormat::Pdf);
    assert_eq!(with_toc, None);
}

#[test]
fn detect_kdh() {
    // "KDH " (with the trailing space) – exact match.
    let mut buf = vec![0u8; 16];
    buf[0] = b'K';
    buf[1] = b'D';
    buf[2] = b'H';
    buf[3] = b' ';
    let (fmt, with_toc) = detect(&buf).expect("KDH should be detected");
    assert_eq!(fmt, FileFormat::Kdh);
    assert_eq!(with_toc, None);
}

#[test]
fn detect_teb() {
    // "TEB" + NUL pad.
    let mut buf = vec![0u8; 16];
    buf[0] = b'T';
    buf[1] = b'E';
    buf[2] = b'B';
    let (fmt, with_toc) = detect(&buf).expect("TEB should be detected");
    assert_eq!(fmt, FileFormat::Teb);
    assert_eq!(with_toc, None);
}

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

#[test]
fn detect_unknown_magic() {
    // "ZZZZ" – not a known magic, not a GBK-decoded magic either.
    let mut buf = vec![0u8; 16];
    buf[0] = b'Z';
    buf[1] = b'Z';
    buf[2] = b'Z';
    buf[3] = b'Z';
    match detect(&buf) {
        Err(CajError::UnknownFormat(magic)) => {
            assert_eq!(magic, [b'Z', b'Z', b'Z', b'Z']);
        }
        other => panic!("expected UnknownFormat error, got {other:?}"),
    }
}

#[test]
fn detect_arbitrary_binary() {
    // 0x01 0x02 0x03 0x04 – not a known magic, GBK-decode will likely
    // produce replacement chars, so the result must be UnknownFormat.
    let buf = vec![0x01u8, 0x02, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    match detect(&buf) {
        Err(CajError::UnknownFormat(_)) => {}
        other => panic!("expected UnknownFormat error, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Cursor round-trip
// ---------------------------------------------------------------------------

#[test]
fn detect_format_preserves_cursor() {
    // The detection routine must not consume the cursor past the first 4
    // bytes. After `detect` returns we should still be able to read the
    // rest of the buffer.
    let mut buf = vec![0u8; 16];
    buf[0] = b'%';
    buf[1] = b'P';
    buf[2] = b'D';
    buf[3] = b'F';
    for (i, b) in buf.iter_mut().enumerate().take(16).skip(4) {
        *b = i as u8;
    }
    let mut cursor = Cursor::new(buf.clone());
    let mut header = [0u8; 4];
    use std::io::Read;
    cursor.read_exact(&mut header).unwrap();
    let (fmt, _) =
        caj2pdf_core::detect_format(&header, &mut cursor).expect("PDF should be detected");
    assert_eq!(fmt, FileFormat::Pdf);

    // The detection path leaves the cursor at byte 4 (it never seeks back
    // for known formats). Verify the remaining bytes are still readable.
    let mut rest = Vec::new();
    cursor.read_to_end(&mut rest).unwrap();
    assert_eq!(rest, &buf[4..]);
}

// ---------------------------------------------------------------------------
// End-to-end open()
// ---------------------------------------------------------------------------

#[test]
fn open_rejects_unknown_format() {
    // Write a 16-byte file that is not any known format and try to open it.
    let dir = std::env::temp_dir();
    let path = dir.join(format!("caj2pdf-core-test-{}.bin", std::process::id()));
    std::fs::write(&path, b"ZZZZnot-a-real-file!").unwrap();
    let result = CajDocument::open(&path);
    let _ = std::fs::remove_file(&path);
    match result {
        Err(CajError::UnknownFormat(_)) => {}
        Err(e) => panic!("expected UnknownFormat, got {e:?}"),
        Ok(_) => panic!("expected error opening bogus file"),
    }
}
