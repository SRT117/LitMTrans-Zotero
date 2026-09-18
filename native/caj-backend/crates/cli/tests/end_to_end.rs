//! End-to-end integration test: build a synthetic CAJ file in /tmp, run the
//! `caj2pdf convert` command, and verify the resulting PDF is valid.
//!
//! This test does NOT require a real CNKI-supplied CAJ file. The CAJ format
//! is "CAJ" magic + 4-byte page count + offset pointer to an embedded PDF.
//! We construct the smallest possible valid container so the conversion
//! pipeline runs end-to-end.

use std::path::PathBuf;
use std::process::Command;

use lopdf::{Dictionary, Document, Object};

/// Build a real one-page PDF using lopdf, then wrap it in a minimal CAJ
/// container and return the bytes.
fn build_synthetic_caj() -> Vec<u8> {
    // Step 1: build a real, valid PDF using lopdf.
    let mut doc = Document::with_version("1.4");
    let pages_id = doc.new_object_id();

    let mut page_dict = Dictionary::new();
    page_dict.set("Type", Object::Name(b"Page".to_vec()));
    page_dict.set("Parent", Object::Reference(pages_id));
    page_dict.set(
        "MediaBox",
        Object::Array(vec![
            Object::Real(0.0),
            Object::Real(0.0),
            Object::Real(100.0),
            Object::Real(100.0),
        ]),
    );
    let page_id = doc.add_object(page_dict);

    let mut pages_dict = Dictionary::new();
    pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
    pages_dict.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
    pages_dict.set("Count", Object::Integer(1));
    doc.objects
        .insert(pages_id, Object::Dictionary(pages_dict));

    let mut catalog_dict = Dictionary::new();
    catalog_dict.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog_dict.set("Pages", Object::Reference(pages_id));
    let catalog_id = doc.add_object(catalog_dict);
    doc.trailer.set("Root", catalog_id);

    let mut buf: Vec<u8> = Vec::new();
    doc.save_to(&mut buf).expect("lopdf save");

    // Step 2: build the CAJ container around the real PDF.
    //   offset 0x00:  4 bytes magic "CAJ\0"
    //   offset 0x10:  4 bytes page count (i32 LE)
    //   offset 0x14:  4 bytes PDF start pointer (i32 LE, absolute offset)
    //   offset 0x110: 4 bytes TOC count (i32 LE) — 0 means no TOC
    //   at the PDF pointer offset: 4 bytes PDF start offset (i32 LE)
    //   that value is the ABSOLUTE file offset of the PDF data.
    let mut out = Vec::new();
    out.extend_from_slice(b"CAJ\0");
    out.resize(0x10, 0);
    out.extend_from_slice(&1i32.to_le_bytes()); // page count = 1
    out.extend_from_slice(&0x118i32.to_le_bytes()); // PDF pointer at 0x118
    out.resize(0x110, 0);
    out.extend_from_slice(&0i32.to_le_bytes()); // toc_count = 0
    out.resize(0x118, 0);
    out.extend_from_slice(&0x11Ci32.to_le_bytes());
    out.extend_from_slice(&buf);
    out
}

fn temp_path(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("caj2pdf-rs-test-{}-{}", std::process::id(), name));
    p
}

#[test]
fn end_to_end_synthetic_caj_conversion() {
    let input = temp_path("synthetic.caj");
    let output = temp_path("synthetic.pdf");
    std::fs::write(&input, build_synthetic_caj()).expect("write synthetic CAJ");

    // Locate the CLI binary in the workspace's target dir.
    let bin = locate_cli_binary();
    eprintln!(
        "running {} convert {} -o {}",
        bin.display(),
        input.display(),
        output.display()
    );

    let out = Command::new(&bin)
        .arg("convert")
        .arg(&input)
        .arg("-o")
        .arg(&output)
        .output()
        .expect("spawn caj2pdf");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    eprintln!("stdout: {stdout}");
    if !stderr.is_empty() {
        eprintln!("stderr: {stderr}");
    }

    assert!(out.status.success(), "caj2pdf convert failed: {stderr}");

    // Verify the output PDF exists, has size > 0, and starts with %PDF-.
    let pdf_bytes = std::fs::read(&output).expect("read output PDF");
    assert!(!pdf_bytes.is_empty(), "output PDF is empty");
    assert!(
        pdf_bytes.starts_with(b"%PDF-"),
        "output PDF does not start with %PDF-: {:?}",
        &pdf_bytes[..pdf_bytes.len().min(8)]
    );
    assert!(
        pdf_bytes.windows(5).any(|w| w == b"%%EOF"),
        "output PDF does not contain %%EOF marker"
    );

    let _ = std::fs::remove_file(&input);
    let _ = std::fs::remove_file(&output);
}

#[test]
fn end_to_end_show_command_reports_caj() {
    let input = temp_path("show.caj");
    std::fs::write(&input, build_synthetic_caj()).expect("write synthetic CAJ");

    let bin = locate_cli_binary();
    let out = Command::new(&bin)
        .arg("show")
        .arg(&input)
        .output()
        .expect("spawn caj2pdf show");

    let stdout = String::from_utf8_lossy(&out.stdout);
    eprintln!("show stdout: {stdout}");
    assert!(out.status.success(), "caj2pdf show failed");
    assert!(stdout.contains("CAJ"), "show output should mention CAJ: {stdout}");

    let _ = std::fs::remove_file(&input);
}

/// Try to find the built `caj2pdf` binary in the workspace's target/ dir.
/// Uses `CARGO_BIN_EXE_caj2pdf` when running under `cargo test`, falls back
/// to `target/debug/caj2pdf` otherwise.
fn locate_cli_binary() -> PathBuf {
    if let Some(path) = option_env!("CARGO_BIN_EXE_caj2pdf") {
        return PathBuf::from(path);
    }
    let mut here = std::env::current_dir().expect("cwd");
    loop {
        let candidate = here.join("target").join("debug").join("caj2pdf");
        if candidate.exists() {
            return candidate;
        }
        if !here.pop() {
            panic!("could not locate caj2pdf binary; run `cargo build` first");
        }
    }
}
