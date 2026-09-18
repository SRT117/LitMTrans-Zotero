//! Rasterize the positioned text records found in WITS/SBS2 pages.
//!
//! These records are not a PDF text layer. They are the character stream used
//! by CAJViewer to paint a page, so a portable converter needs to turn them
//! into a bitmap before the normal PDF image pipeline can consume them.

use caj2pdf_types::{DecodedImage, MonoOrientation, Page};
use fontdue::{Font, FontSettings};
use std::sync::OnceLock;

const FORMAT_UNITS_PER_PIXEL: f32 = 2.473;
const DEFAULT_LOGICAL_SIZE: (u32, u32) = (0x2800, 0x2000);
const FONT_SIZE_PX: f32 = 13.5;
const INK_THRESHOLD: u8 = 96;

// The plugin already ships this font for the layout reader. Embedding the
// same asset keeps the CAJ fallback deterministic on machines without a
// Chinese system font and works in the WASM build as well.
static SOURCE_HAN_SERIF: &[u8] = include_bytes!("../../../../../assets/fonts/SourceHanSerifCN-Regular.ttf");
static PAGE_FONT: OnceLock<Option<Font>> = OnceLock::new();

/// Convert native WITS/SBS2 page units to the bitmap dimensions used by PDF.
pub fn logical_size_px(logical_size: Option<(u32, u32)>) -> (u32, u32) {
    let (width, height) = logical_size.unwrap_or(DEFAULT_LOGICAL_SIZE);
    (
        ((width as f32 / FORMAT_UNITS_PER_PIXEL).ceil() as u32).max(1),
        ((height as f32 / FORMAT_UNITS_PER_PIXEL).ceil() as u32).max(1),
    )
}

/// Render a page's positioned glyphs as a 1-bpp image.
pub fn render_text_page(page: &Page) -> Option<(DecodedImage, (u32, u32))> {
    if page.glyphs.len() < 2 {
        return None;
    }

    let (width, height) = logical_size_px(page.logical_size);
    let stride = (width as usize).div_ceil(8);
    let mut bits = vec![0u8; stride * height as usize];
    let font = PAGE_FONT
        .get_or_init(|| Font::from_bytes(SOURCE_HAN_SERIF, FontSettings::default()).ok())
        .as_ref()?;

    let min_x = page.glyphs.iter().map(|glyph| glyph.x).min()? as f32;
    let max_x = page.glyphs.iter().map(|glyph| glyph.x).max()? as f32;
    let min_y = page.glyphs.iter().map(|glyph| glyph.y).min()? as f32;
    let max_y = page.glyphs.iter().map(|glyph| glyph.y).max()? as f32;
    let source_width = (max_x - min_x).max(33.0);
    let source_height = (max_y - min_y).max(33.0);
    let (target_left, target_top, target_width, target_height) = if page.images.is_empty() {
        (
            width as f32 * 0.06,
            height as f32 * 0.08,
            width as f32 * 0.88,
            height as f32 * 0.84,
        )
    } else {
        (
            width as f32 * 0.06,
            height as f32 * 0.06,
            width as f32 * 0.88,
            height as f32 * 0.38,
        )
    };
    let x_scale = target_width / source_width;
    let y_scale = target_height / source_height;
    let font_size = (FONT_SIZE_PX * FORMAT_UNITS_PER_PIXEL * y_scale).clamp(8.0, 32.0);

    let mut painted = 0usize;
    for glyph in &page.glyphs {
        let metrics_and_bitmap = font.rasterize(glyph.character, font_size);
        let metrics = metrics_and_bitmap.0;
        let bitmap = metrics_and_bitmap.1;
        let anchor_x = (target_left
            + (glyph.x as f32 - min_x) * x_scale)
            .round() as i32;
        let anchor_y = (target_top
            + (glyph.y as f32 - min_y) * y_scale)
            .round() as i32;
        let origin_x = anchor_x + metrics.xmin;
        let origin_y = anchor_y + metrics.ymin;

        for bitmap_y in 0..metrics.height {
            let y = origin_y + bitmap_y as i32;
            if y < 0 || y >= height as i32 {
                continue;
            }
            for bitmap_x in 0..metrics.width {
                let alpha = bitmap[bitmap_y * metrics.width + bitmap_x];
                if alpha < INK_THRESHOLD {
                    continue;
                }
                let x = origin_x + bitmap_x as i32;
                if x < 0 || x >= width as i32 {
                    continue;
                }
                let byte_index = y as usize * stride + x as usize / 8;
                bits[byte_index] |= 0x80 >> (x as usize % 8);
                painted += 1;
            }
        }
    }

    if painted == 0 {
        return None;
    }

    Some((
        DecodedImage::Mono {
            width_px: width,
            height_px: height,
            orientation: MonoOrientation::FlipVertical,
            bits,
        },
        (width, height),
    ))
}
