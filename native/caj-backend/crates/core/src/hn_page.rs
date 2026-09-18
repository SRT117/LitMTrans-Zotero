//! Parse the dispatch records of a single HN-format page (text + figure
//! positions).
//!
//! See `docs/format-analysis.md` for the record grammar.

use std::collections::BTreeMap;

use caj2pdf_types::TextGlyph;

/// The positioned text recovered from a WITS/SBS2 dispatch stream.
#[derive(Debug, Clone, Default)]
pub struct TextLayout {
    pub text: String,
    pub glyphs: Vec<TextGlyph>,
    pub logical_size: Option<(u32, u32)>,
}

#[cfg(test)]
mod tests {
    use super::{parse_page_text, parse_text_layout};

    /// A new-style 0x8001 record carries a GBK character in two bytes
    /// (low, high) followed by two unknown bytes. The GBK char `中` is
    /// `0xD6 0xD0` – we store it little-endian as `[0xD0, 0xD6]`.
    #[test]
    fn parse_new_style_single_char() {
        // 0x8001 0xD0 0xD6 0x00 0x00
        let data = [0x01, 0x80, 0xD0, 0xD6, 0x00, 0x00];
        let out = parse_page_text(&data, false);
        assert_eq!(out, "中");
    }

    /// `0xA38A` (0x8A, 0xA3 in file) is mapped to `\n` per the OCR
    /// artifact table.
    #[test]
    fn parse_new_style_ocr_linebreak() {
        // 0x8001 0x8A 0xA3 0x00 0x00
        let data = [0x01, 0x80, 0x8A, 0xA3, 0x00, 0x00];
        let out = parse_page_text(&data, false);
        assert_eq!(out, "\n");
    }

    /// `0x800A` is a 26-byte figure record; it must not contribute any
    /// text and must not panic on the trailing bytes.
    #[test]
    fn parse_skips_figure_records() {
        // 0x800A followed by 26 zero bytes
        let mut data = vec![0x0A, 0x80];
        data.extend(std::iter::repeat(0u8).take(26));
        let out = parse_page_text(&data, false);
        assert_eq!(out, "");
    }

    /// Old-style (page_style=true) records: a 0x8001 emits a newline,
    /// then 2 unknown bytes, then a run of 4-byte characters. Each
    /// 4-byte record has the GBK char at positions [2..4] (low, high)
    /// in file order; position [1] is 0x80 to signal the next dispatch
    /// code.
    #[test]
    fn parse_old_style_text_run() {
        // 0x8001 0x00 0x00  [newline emitted]
        // 0x00 0x00 0xD0 0xD6  [first 4-byte record, GBK char = 中]
        // 0x00 0x80           [end-of-run marker at position 1]
        let data = [
            0x01, 0x80, 0x00, 0x00, //
            0x00, 0x00, 0xD0, 0xD6, //
            0x00, 0x80, //
        ];
        let out = parse_page_text(&data, true);
        assert_eq!(out, "\n中");
    }

    #[test]
    fn parse_sbs2_positioned_text() {
        let words = [
            0x8001, 0x0100, 0x8002, 0x0020, 0x801d, 0x0000, 0x0120, 0xD6D0, 0x0150,
            0xCEC4,
        ];
        let data = words
            .iter()
            .flat_map(|word| (*word as u16).to_le_bytes())
            .collect::<Vec<_>>();
        let out = parse_text_layout(&data, false);
        assert_eq!(out.glyphs.len(), 2);
        assert_eq!(out.glyphs[0].character, '中');
        assert_eq!(out.glyphs[1].character, '文');
        assert_eq!(out.glyphs[0].y, 0x20);
    }

    #[test]
    fn parse_wits21_variable_length_records() {
        let words = [
            0x80cc, 0x0204, 0x0100, 0x0001, 0x0120, 0xD6D0, 0x80cc, 0x0204, 0x0100, 0x0002,
            0x80ce, 0x0000, 0x0150, 0xCEC4,
        ];
        let data = words
            .iter()
            .flat_map(|word| (*word as u16).to_le_bytes())
            .collect::<Vec<_>>();
        let out = parse_text_layout(&data, false);
        assert_eq!(out.glyphs.len(), 2);
        assert_eq!(out.glyphs[0].character, '中');
        assert_eq!(out.glyphs[1].character, '文');
        assert_eq!(out.glyphs[1].x, 0x150);
    }
}

/// Parse the text section of an HN page.
///
/// The on-disk format is a flat stream of 2-byte dispatch codes followed by
/// record-specific payloads:
///
/// * `0x8001` / `0x8070` – a run of single GBK characters. Old-style pages
///   (`page_style == true`) use a 4-byte-per-character layout; new-style
///   pages use a 6-byte layout where the first 2 bytes of the payload are
///   the character's GBK code and the next 2 are an unknown field.
/// * `0x800A` – a figure position record (26 bytes: x, y, width, height,
///   plus 8 unknown bytes).
///
/// Any other dispatch code is treated as a 4-byte "skip" record.
pub fn parse_page_text(data: &[u8], page_style: bool) -> String {
    let mut out = String::new();
    let mut off = 0usize;
    let len = data.len();

    while off + 2 <= len {
        let code = u16::from_le_bytes([data[off], data[off + 1]]);
        off += 2;

        match (code, page_style) {
            (0x8001, false) => {
                if off + 4 > len {
                    break;
                }
                let b0 = data[off];
                let b1 = data[off + 1];
                push_gbk(&mut out, b0, b1);
                off += 4;
            }
            (0x8001 | 0x8070, true) => {
                // 0x8001 in old-style means "newline before this run".
                if code == 0x8001 {
                    out.push('\n');
                }
                off += 2; // skip 2 unknown bytes
                while off + 4 <= len {
                    if data[off + 1] == 0x80 {
                        break;
                    }
                    let b0 = data[off + 2];
                    let b1 = data[off + 3];
                    push_gbk(&mut out, b0, b1);
                    off += 4;
                }
            }
            (0x800A, _) => {
                if off + 26 > len {
                    break;
                }
                // Figure records don't contribute to the text body.
                off += 26;
            }
            _ => {
                off += 2;
            }
        }
    }
    out
}

/// Parse the positioned text stream used by newer C8/HN pages.
///
/// The old parser is intentionally retained for the documented 0x8001 text
/// records. WITS/SBS2 pages use a different dispatch grammar: characters
/// carry their own x/y positions and a page can contain both text and image
/// records. Treating those records as generic two-byte skips is what used to
/// turn otherwise readable pages into blank or cropped PDFs.
pub fn parse_text_layout(data: &[u8], page_style: bool) -> TextLayout {
    if page_style {
        return TextLayout::default();
    }

    let words = data
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    let logical_size = declared_page_size(&words);
    let is_wits21 = words
        .windows(2)
        .any(|pair| pair[0] == 0x80cc && pair[1] == 0x0204);
    let mut glyphs = if is_wits21 {
        parse_wits21(&words)
    } else {
        parse_sbs2(&words)
    };

    let (page_width, page_height) = logical_size.unwrap_or((0x2800, 0x2000));
    glyphs.retain(|glyph| {
        glyph.x < page_width
            && glyph.y < page_height
            && glyph.character != '\0'
            && !glyph.character.is_control()
    });
    glyphs.sort_by_key(|glyph| (glyph.y, glyph.x));

    TextLayout {
        text: glyph_text(&glyphs),
        glyphs,
        logical_size: Some((page_width, page_height)),
    }
}

const DEFAULT_PAGE_WIDTH: u32 = 0x2800;
const DEFAULT_PAGE_HEIGHT: u32 = 0x2000;

fn declared_page_size(words: &[u16]) -> Option<(u32, u32)> {
    let mut width = None;
    let mut height = None;
    for i in 0..words.len().saturating_sub(1) {
        let value = words[i + 1] as u32;
        match words[i] {
            0x8024 if (0x1800..=0x4000).contains(&value) => width = Some(value),
            0x8021 if (0x1000..=0x4000).contains(&value) => height = Some(value),
            _ => {}
        }
    }
    Some((
        width.unwrap_or(DEFAULT_PAGE_WIDTH),
        height.unwrap_or(DEFAULT_PAGE_HEIGHT),
    ))
}

fn parse_sbs2(words: &[u16]) -> Vec<TextGlyph> {
    let mut glyphs = Vec::new();
    let mut current_x = 0u32;
    let mut current_y = 0u32;
    let mut i = 0usize;

    while i < words.len() {
        match words[i] {
            0x8001 if i + 1 < words.len() => {
                current_x = words[i + 1] as u32;
                i += 2;
            }
            0x8002 if i + 1 < words.len() => {
                current_y = words[i + 1] as u32;
                i += 2;
            }
            0x801d if i + 1 < words.len() => {
                // The first word is a run flag. The rest of the record is
                // (x, GBK-character) pairs terminated by the next dispatch
                // code (all dispatch codes have their high bit set).
                i += 2;
                while i + 1 < words.len() {
                    let x = words[i];
                    if x >= 0x8000 {
                        break;
                    }
                    if let Some(character) = decode_gbk_code(words[i + 1]) {
                        glyphs.push(TextGlyph {
                            x: x as u32,
                            y: current_y,
                            character,
                        });
                    }
                    current_x = x as u32;
                    i += 2;
                }
            }
            _ => i += 1,
        }
    }

    // Some SBS2 producers omit the explicit x position and only emit a
    // single character after 0x801d. Keeping the state variable here makes
    // that variant harmless while preserving the normal pair parser above.
    let _ = current_x;
    glyphs
}

fn parse_wits21(words: &[u16]) -> Vec<TextGlyph> {
    let mut glyphs = Vec::new();
    let mut current_y = 0u32;
    let mut i = 0usize;

    while i < words.len() {
        match words[i] {
            0x8002 if i + 1 < words.len() => {
                current_y = words[i + 1] as u32;
                i += 2;
            }
            0x80cc if i + 3 < words.len() && words[i + 1] == 0x0204 => {
                let y = words[i + 2] as u32;
                if i + 5 < words.len()
                    && words[i + 4] < 0x8000
                    && decode_gbk_code(words[i + 5]).is_some()
                {
                    let x = words[i + 4] as u32;
                    let character = decode_gbk_code(words[i + 5]).unwrap();
                    glyphs.push(TextGlyph { x, y, character });
                    i += 6;
                } else {
                    // Some String records end after the character index and
                    // immediately start another dispatch record. Do not
                    // consume that following command as x/character data.
                    i += 4;
                }
                current_y = y;
            }
            0x80ce if i + 3 < words.len() => {
                let x = words[i + 2] as u32;
                if x < 0x8000 {
                    if let Some(character) = decode_gbk_code(words[i + 3]) {
                        glyphs.push(TextGlyph {
                            x,
                            y: current_y,
                            character,
                        });
                    }
                    i += 4;
                } else if x == 0x801d && i + 5 < words.len() {
                    // A String record may wrap a short 0x801d record before
                    // the actual (x, character) pair.
                    let actual_x = words[i + 4] as u32;
                    if actual_x < 0x8000 {
                        if let Some(character) = decode_gbk_code(words[i + 5]) {
                            glyphs.push(TextGlyph {
                                x: actual_x,
                                y: current_y,
                                character,
                            });
                        }
                    }
                    i += 6;
                } else {
                    i += 4;
                }
            }
            0x801d if i + 3 < words.len() => {
                let x = words[i + 2] as u32;
                if x < 0x8000 {
                    if let Some(character) = decode_gbk_code(words[i + 3]) {
                        glyphs.push(TextGlyph {
                            x,
                            y: current_y,
                            character,
                        });
                    }
                }
                i += 4;
            }
            _ => i += 1,
        }
    }

    glyphs
}

fn glyph_text(glyphs: &[TextGlyph]) -> String {
    let mut lines: BTreeMap<u32, Vec<&TextGlyph>> = BTreeMap::new();
    for glyph in glyphs {
        lines.entry(glyph.y).or_default().push(glyph);
    }

    let mut text = String::new();
    for (line_index, (_, mut line)) in lines.into_iter().enumerate() {
        line.sort_by_key(|glyph| glyph.x);
        if line_index != 0 {
            text.push('\n');
        }
        for glyph in line {
            text.push(glyph.character);
        }
    }
    text
}

fn decode_gbk_code(code: u16) -> Option<char> {
    match code {
        0xA389 => return Some('\t'),
        0xA38A => return Some('\n'),
        0xA38D => return Some('\r'),
        0xA3A0 => return Some(' '),
        0x0020..=0x007E => return Some(code as u8 as char),
        _ => {}
    }

    let high = (code >> 8) as u8;
    let low = code as u8;
    if !(0x81..=0xFE).contains(&high) || low == 0x7F || !(0x40..=0xFE).contains(&low) {
        return None;
    }
    let bytes = [high, low];
    let (decoded, _, had_replacement) = encoding_rs::GBK.decode(&bytes);
    if had_replacement {
        return None;
    }
    decoded.chars().next()
}

/// Decode one GBK character from the two bytes stored little-endian in the
/// file. `b0` is the low byte, `b1` is the high byte, so the numeric code is
/// `b1 * 256 + b0`. GBK decoding itself expects `[high, low]`, hence the
/// `[b1, b0]` byte order below.
fn push_gbk(out: &mut String, b0: u8, b1: u8) {
    let code = ((b1 as u16) << 8) | (b0 as u16);
    match code {
        0xA389 => out.push('\t'),
        0xA38A => out.push('\n'),
        0xA38D => out.push('\r'),
        0xA3A0 => out.push(' '),
        _ => {
            let bytes = [b1, b0];
            let (cow, _, had_repl) = encoding_rs::GBK.decode(&bytes);
            if !had_repl && !cow.is_empty() {
                out.push_str(&cow);
            } else {
                out.push_str(&format!("<0x{:04X}>\n", code));
            }
        }
    }
}

// 图框和字符共用记录流，必须按各自的完整长度跳转。
pub fn parse_figures(data: &[u8], old: bool) -> Vec<[u16; 4]> {
    let mut result = Vec::new(); let mut i = 0;
    while i + 2 <= data.len() {
        let code = u16::from_le_bytes([data[i], data[i+1]]); i += 2;
        match code {
            0x800a => {
                if i + 26 > data.len() { break; }
                let mut rect = [0; 4];
                for (n, v) in rect.iter_mut().enumerate() { *v = u16::from_le_bytes([data[i+2+n*2],data[i+3+n*2]]); }
                result.push(rect); i += 26;
            }
            0x8001 | 0x8070 if old => { i += 2; while i + 4 <= data.len() && data[i+1] != 0x80 { i += 4; } }
            0x8001 => i += 6,
            _ => i += 2,
        }
    }
    result
}
