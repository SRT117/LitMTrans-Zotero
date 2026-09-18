//! `caj2pdf` CLI entry point.
//!
//! Subcommands mirror the original Python tool:
//!
//! * `show`         — print the file's format, page count, and outline count
//! * `convert`      — convert a CAJ/HN/C8 file to a PDF
//! * `outlines`     — add outline entries from a CAJ/HN/C8 file to an
//!                    existing PDF (printed from CAJViewer, for example)
//! * `text-extract` — dump the extracted text of every page
//! * `parse`        — debug dump of every page's structure

mod pipeline;

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use tracing::info;

use caj2pdf_core::{CajDocument, CajError, FileFormat};

#[derive(Debug, Parser)]
#[command(
    name = "caj2pdf",
    about = "Convert Chinese academic journal (CAJ/HN) files to PDF",
    long_about = None,
    version,
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Show the file's format, page count, and outline count.
    Show {
        /// Path to the input CAJ-family file.
        input: String,
    },
    /// Convert a CAJ/HN/C8/KDH file to PDF.
    Convert {
        /// Path to the input CAJ-family file.
        input: String,
        /// Path to the output PDF (default: replace extension with .pdf).
        #[arg(short = 'o', long = "output")]
        output: Option<String>,
    },
    /// Inject the outline tree of a CAJ/HN/C8 file into an existing PDF.
    Outlines {
        /// Path to the input CAJ-family file.
        input: String,
        /// Path to the existing PDF.
        #[arg(short = 'o', long = "output")]
        output: String,
    },
    /// Dump the extracted text of every page.
    TextExtract {
        /// Path to the input CAJ-family file.
        input: String,
    },
    /// Debug-dump every page's structure.
    Parse {
        /// Path to the input CAJ-family file.
        input: String,
    },
}

fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    match cli.command {
        Command::Show { input } => cmd_show(&input).context("show"),
        Command::Convert { input, output } => {
            cmd_convert(&input, output.as_deref()).context("convert")
        }
        Command::Outlines { input, output } => cmd_outlines(&input, &output).context("outlines"),
        Command::TextExtract { input } => cmd_text_extract(&input).context("text-extract"),
        Command::Parse { input } => cmd_parse(&input).context("parse"),
    }
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

// ---------------------------------------------------------------------------
// Output path resolution
// ---------------------------------------------------------------------------

fn default_output_for(input: &str) -> String {
    let p = Path::new(input);
    if let Some(stem) = p.file_stem() {
        let mut s = stem.to_os_string();
        s.push(".pdf");
        p.with_file_name(s).to_string_lossy().into_owned()
    } else {
        format!("{input}.pdf")
    }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

fn cmd_show(input: &str) -> Result<()> {
    let doc = CajDocument::open(input).map_err(into_anyhow)?;
    match doc.format() {
        FileFormat::Pdf | FileFormat::Kdh => {
            println!("File: {input}");
            println!("Type: {}", doc.format());
        }
        f => {
            println!("File: {input}");
            println!("Type: {f}");
            println!("Page count: {}", doc.page_count());
            println!("Outlines count: {}", doc.toc_entry_count());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

fn cmd_convert(input: &str, output: Option<&str>) -> Result<()> {
    let out = output.map(String::from).unwrap_or_else(|| default_output_for(input));
    let out_path = PathBuf::from(&out);
    pipeline::run(Path::new(input), &out_path)?;
    println!("Wrote {}", out_path.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// outlines
// ---------------------------------------------------------------------------

fn cmd_outlines(input: &str, output: &str) -> Result<()> {
    let doc = CajDocument::open(input).map_err(into_anyhow)?;
    if matches!(doc.format(), FileFormat::Pdf | FileFormat::Kdh | FileFormat::Teb) {
        bail!(
            "outlines subcommand is only supported for CAJ / HN / C8 files; got {:?}",
            doc.format()
        );
    }
    let existing = std::fs::read(output)
        .with_context(|| format!("reading existing PDF at {output}"))?;
    let new_pdf = caj2pdf_pdf::inject_outlines(&existing, doc.toc())?;
    // Write to a temp file then atomically replace.
    let tmp = output.to_string() + ".tmp";
    std::fs::write(&tmp, &new_pdf).with_context(|| format!("writing {tmp}"))?;
    std::fs::rename(&tmp, output).with_context(|| format!("renaming {tmp} to {output}"))?;
    info!(file = %output, "injected outlines");
    println!("Wrote {output}");
    Ok(())
}

// ---------------------------------------------------------------------------
// text-extract
// ---------------------------------------------------------------------------

fn cmd_text_extract(input: &str) -> Result<()> {
    let doc = CajDocument::open(input).map_err(into_anyhow)?;
    if matches!(doc.format(), FileFormat::Pdf | FileFormat::Kdh | FileFormat::Teb) {
        bail!(
            "text-extract subcommand is only supported for HN / C8 files; got {:?}",
            doc.format()
        );
    }
    let pages = doc.pages().map_err(into_anyhow)?;
    for (i, page) in pages.iter().enumerate() {
        println!("=== Page {} ===", i + 1);
        if page.text.is_empty() {
            println!("(no extractable text)");
        } else {
            println!("{}", page.text);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// parse (debug)
// ---------------------------------------------------------------------------

fn cmd_parse(input: &str) -> Result<()> {
    let doc = CajDocument::open(input).map_err(into_anyhow)?;
    println!("File: {input}");
    println!("Format: {:?}", doc.format());
    println!("Page count: {}", doc.page_count());
    println!("Outlines count: {}", doc.toc_entry_count());
    if !doc.toc().is_empty() {
        println!("\nOutline (first 10):");
        for entry in doc.toc().iter().take(10) {
            println!(
                "  [L{:>2}] p.{:>4}  {}",
                entry.level, entry.page, entry.title
            );
        }
    }
    if matches!(doc.format(), FileFormat::Hn | FileFormat::C8) {
        let pages = doc.pages().map_err(into_anyhow)?;
        println!("\nPer-page summary (first 10 pages):");
        for (i, page) in pages.iter().take(10).enumerate() {
            println!(
                "  Page {:>3}: text_chars={:>5}  glyphs={:>5}  logical_size={:?}  images={}",
                i + 1,
                page.text.chars().count(),
                page.glyphs.len(),
                page.logical_size,
                page.images.len()
            );
            for img in &page.images {
                println!(
                    "    image kind={:?} {}x{}  bytes={}",
                    img.kind,
                    img.width_px,
                    img.height_px,
                    img.data.len()
                );
            }
            if !page.glyphs.is_empty() {
                let min_x = page.glyphs.iter().map(|glyph| glyph.x).min().unwrap_or(0);
                let max_x = page.glyphs.iter().map(|glyph| glyph.x).max().unwrap_or(0);
                let min_y = page.glyphs.iter().map(|glyph| glyph.y).min().unwrap_or(0);
                let max_y = page.glyphs.iter().map(|glyph| glyph.y).max().unwrap_or(0);
                println!(
                    "    glyph_bounds=({}, {})..({}, {}) sample={:?}",
                    min_x,
                    min_y,
                    max_x,
                    max_y,
                    page.glyphs
                        .iter()
                        .take(8)
                        .map(|glyph| (glyph.x, glyph.y, glyph.character))
                        .collect::<Vec<_>>()
                );
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// error helpers
// ---------------------------------------------------------------------------

fn into_anyhow(e: CajError) -> anyhow::Error {
    anyhow::Error::new(e)
}
