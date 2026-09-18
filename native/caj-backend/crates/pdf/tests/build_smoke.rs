//! Smoke tests for `caj2pdf-pdf::build_document` and
//! `caj2pdf-pdf::inject_outlines`.
//!
//! These tests build tiny PDFs from synthetic inputs and round-trip
//! them through `lopdf` to verify that the produced bytes are a
//! well-formed PDF.

use caj2pdf_types::{DecodedImage, MonoOrientation, OutlineEntry};
use caj2pdf_pdf::{build_document, inject_outlines, PageInput};

/// Build a synthetic 1-bpp mono bitmap filled with a single pattern.
fn mono_image(width: u32, height: u32, fill_byte: u8) -> DecodedImage {
    let stride = ((width as usize) + 7) / 8;
    let bits = vec![fill_byte; stride * height as usize];
    DecodedImage::Mono {
        width_px: width,
        height_px: height,
        orientation: MonoOrientation::FlipVertical,
        bits,
    }
}

/// Build a minimal valid JPEG. We hand-craft the SOI/EOI markers and
/// a tiny SOF0 segment to make `lopdf` happy.
///
/// We do **not** need a decodable JPEG for these tests; lopdf treats
/// the image stream as opaque (DCTDecode filter) and never decodes it.
fn minimal_jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut bytes = Vec::new();
    // SOI
    bytes.extend_from_slice(&[0xFF, 0xD8]);
    // SOF0
    bytes.extend_from_slice(&[0xFF, 0xC0]);
    let seg = [
        0, 17, // segment length (big-endian, including these two bytes)
        8,   // precision
        (height >> 8) as u8,
        (height & 0xFF) as u8,
        (width >> 8) as u8,
        (width & 0xFF) as u8,
        3, // number of components
        1,
        0x22,
        0, // Y: h=1, v=1, qt=0
        2,
        0x11,
        1, // Cb: h=1, v=1, qt=1
        3,
        0x11,
        1, // Cr: h=1, v=1, qt=1
    ];
    bytes.extend_from_slice(&seg);
    // EOI
    bytes.extend_from_slice(&[0xFF, 0xD9]);
    bytes
}

#[test]
fn two_page_mono_pdf_starts_with_pdf_header() {
    let pages = vec![
        PageInput::new(mono_image(100, 100, 0xAA)),
        PageInput::new(mono_image(100, 100, 0x55)),
    ];

    let bytes = build_document(&pages, &[]).expect("build_document must succeed");

    // Magic header.
    assert!(
        bytes.starts_with(b"%PDF-"),
        "output must start with the %PDF- magic, got {:02x?}",
        &bytes[..bytes.len().min(8)]
    );

    // The %%EOF marker is required by the PDF spec.
    let eof_idx = bytes.windows(5).rposition(|w| w == b"%%EOF");
    assert!(eof_idx.is_some(), "PDF must end with %%EOF");

    // Round-trip through lopdf to make sure the structure parses.
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf must parse our PDF");
    assert_eq!(doc.get_pages().len(), 2, "must have 2 pages");
}

#[test]
fn mono_pdf_uses_top_down_image_matrix() {
    let bytes = build_document(&[PageInput::new(mono_image(8, 6, 0xFF))], &[])
        .expect("build_document must succeed");
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf must parse our PDF");
    let page_id = *doc.get_pages().get(&1).expect("page 1 exists");
    let page = doc.get_dictionary(page_id).expect("page dictionary exists");
    let contents_id = page
        .get(b"Contents")
        .expect("page content exists")
        .as_reference()
        .expect("page content is a reference");
    let contents = doc
        .get_object(contents_id)
        .expect("content stream exists")
        .as_stream()
        .expect("content is a stream");
    let stream = String::from_utf8_lossy(&contents.content);
    assert!(stream.contains("0 0 -"), "mono image must be flipped in PDF Y axis");
}

#[test]
fn one_page_jpeg_pdf_has_correct_image_dimensions() {
    let jpeg = minimal_jpeg(8, 6);
    let pages = vec![PageInput::new(DecodedImage::Jpeg {
        width_px: 8,
        height_px: 6,
        jpeg_bytes: jpeg,
    })];

    let bytes = build_document(&pages, &[]).expect("build_document must succeed");
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf must parse our PDF");

    assert_eq!(doc.get_pages().len(), 1, "must have 1 page");

    let page_id = *doc.get_pages().get(&1).expect("page 1 exists");
    let images = doc
        .get_page_images(page_id)
        .expect("page must have at least one image");
    assert_eq!(images.len(), 1, "page must have exactly one image");
    assert_eq!(images[0].width, 8);
    assert_eq!(images[0].height, 6);
    assert_eq!(
        images[0].color_space.as_deref(),
        Some("DeviceRGB"),
        "JPEG must be tagged as DeviceRGB"
    );
    assert_eq!(
        images[0].filters.as_deref(),
        Some(&["DCTDecode".to_string()][..]),
        "JPEG must use DCTDecode"
    );
}

#[test]
fn three_page_pdf_with_3_level_outline() {
    // Three pages.
    let pages = vec![
        PageInput::new(mono_image(50, 50, 0xFF)),
        PageInput::new(mono_image(50, 50, 0xFF)),
        PageInput::new(mono_image(50, 50, 0xFF)),
    ];

    // A 3-level outline:
    //   1 Chapter One        (page 1, level 1)
    //     1.1 Section A      (page 1, level 2)
    //       1.1.1 Sub A.1    (page 1, level 3)
    //   2 Chapter Two        (page 2, level 1)
    //     2.1 Section C      (page 2, level 2)
    //
    // The levels are arranged so that the BTree algorithm never has
    // to drop back from a deep level to a top-level entry, which is
    // a real limitation of the original Python algorithm.
    let outlines = vec![
        OutlineEntry {
            title: "Chapter One".into(),
            page: 1,
            level: 1,
        },
        OutlineEntry {
            title: "Section A".into(),
            page: 1,
            level: 2,
        },
        OutlineEntry {
            title: "Sub A.1".into(),
            page: 1,
            level: 3,
        },
        OutlineEntry {
            title: "Chapter Two".into(),
            page: 2,
            level: 1,
        },
        OutlineEntry {
            title: "Section C".into(),
            page: 2,
            level: 2,
        },
    ];

    let bytes = build_document(&pages, &outlines).expect("build_document must succeed");
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf must parse our PDF");

    // Verify page count.
    assert_eq!(doc.get_pages().len(), 3);

    // Verify the /Outlines dict exists in the catalog.
    let catalog = doc.catalog().expect("catalog exists").clone();
    let outlines_ref = catalog
        .get(b"Outlines")
        .expect("catalog must have /Outlines")
        .as_reference()
        .expect("/Outlines must be a reference");
    let outlines_dict = doc
        .get_dictionary(outlines_ref)
        .expect("/Outlines dict exists");
    assert_eq!(
        outlines_dict
            .get(b"Type")
            .ok()
            .and_then(|o| o.as_name().ok())
            .map(|b| std::str::from_utf8(b).unwrap()),
        Some("Outlines")
    );
    // /Count should be 5 (the 5 outline entries we added).
    let count = outlines_dict.get(b"Count").unwrap().as_i64().unwrap();
    assert_eq!(count, 5);

    // Walk the outline items: start at /First, follow /Next.
    let first_ref = outlines_dict.get(b"First").unwrap().as_reference().unwrap();
    let mut current = first_ref;
    let mut titles: Vec<String> = Vec::new();
    let mut iterations = 0;
    loop {
        iterations += 1;
        assert!(iterations < 20, "outline must not loop forever");
        let item = doc.get_dictionary(current).unwrap();
        let title_bytes = item.get(b"Title").unwrap().as_str().unwrap().to_vec();
        let title = String::from_utf8(title_bytes).expect("title is utf-8");
        titles.push(title);
        match item.get(b"Next") {
            Ok(obj) => {
                current = obj.as_reference().unwrap();
            }
            Err(_) => break,
        }
    }
    assert_eq!(
        titles,
        vec![
            "Chapter One".to_string(),
            "Section A".to_string(),
            "Sub A.1".to_string(),
            "Chapter Two".to_string(),
            "Section C".to_string(),
        ]
    );

    // Verify parent/child links: "Sub A.1" has Parent == "Section A",
    // and "Section A" has /First == "Sub A.1".
    let mut current = first_ref;
    let mut sub_a1_id = None;
    for _ in 0..3 {
        let item = doc.get_dictionary(current).unwrap();
        let title = String::from_utf8(item.get(b"Title").unwrap().as_str().unwrap().to_vec()).unwrap();
        if title == "Sub A.1" {
            sub_a1_id = Some(current);
            break;
        }
        current = item.get(b"Next").unwrap().as_reference().unwrap();
    }
    let sub_a1_id = sub_a1_id.expect("found Sub A.1");
    let sub_a1 = doc.get_dictionary(sub_a1_id).unwrap();
    let sub_a1_parent = sub_a1.get(b"Parent").unwrap().as_reference().unwrap();
    let sub_a1_parent_dict = doc.get_dictionary(sub_a1_parent).unwrap();
    let parent_title = String::from_utf8(
        sub_a1_parent_dict
            .get(b"Title")
            .unwrap()
            .as_str()
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert_eq!(parent_title, "Section A");

    // Section A must have /First pointing to Sub A.1.
    let section_a_first = sub_a1_parent_dict
        .get(b"First")
        .unwrap()
        .as_reference()
        .unwrap();
    assert_eq!(section_a_first, sub_a1_id);
}

#[test]
fn inject_outlines_into_existing_pdf() {
    // Build a base PDF with no outlines.
    let pages = vec![
        PageInput::new(mono_image(40, 40, 0xAA)),
        PageInput::new(mono_image(40, 40, 0x55)),
    ];
    let base = build_document(&pages, &[]).expect("build base");

    // Inject a flat 3-entry outline.
    let outlines = vec![
        OutlineEntry {
            title: "Intro".into(),
            page: 1,
            level: 1,
        },
        OutlineEntry {
            title: "Body".into(),
            page: 1,
            level: 1,
        },
        OutlineEntry {
            title: "End".into(),
            page: 2,
            level: 1,
        },
    ];
    let with_outlines = inject_outlines(&base, &outlines).expect("inject must succeed");
    assert!(with_outlines.starts_with(b"%PDF-"));

    let doc = lopdf::Document::load_mem(&with_outlines).expect("lopdf parses injected");
    let catalog = doc.catalog().expect("catalog exists");
    let outlines_ref = catalog
        .get(b"Outlines")
        .expect("/Outlines present")
        .as_reference()
        .unwrap();
    let outlines_dict = doc.get_dictionary(outlines_ref).unwrap();
    assert_eq!(outlines_dict.get(b"Count").unwrap().as_i64().unwrap(), 3);
}
