"""Create the Reader-safe inline SVG from the transparent plugin ICO.

The Zotero Reader clones injected DOM into an isolated iframe, where external
image URLs are unreliable. This script preserves the original red/black pixel
art as compact horizontal SVG strokes, which can be injected as inline paths.
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "icon.ico"
TARGET = ROOT / "assets" / "icon-reader.svg"
SCRIPT_TARGET = ROOT / "src" / "icon-reader.js"


def color_for(red: int, green: int, blue: int) -> str:
    """Keep the two intentional paint layers; discard antialiased noise."""
    if red > green * 1.35 and red > blue * 1.35 and red > 55:
        return "#df121a"
    return "#111111"


def main() -> None:
    with Image.open(SOURCE) as original:
        image = original.convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        raise SystemExit("The plugin icon has no visible pixels.")
    image = image.crop(bbox)
    width, height = image.size
    pixels = image.load()
    paths: list[str] = []

    for y in range(height):
        x = 0
        while x < width:
            red, green, blue, opacity = pixels[x, y]
            if opacity < 28:
                x += 1
                continue
            color = color_for(red, green, blue)
            start = x
            x += 1
            while x < width:
                next_red, next_green, next_blue, next_opacity = pixels[x, y]
                if next_opacity < 28 or color_for(next_red, next_green, next_blue) != color:
                    break
                x += 1
            paths.append(f'<path d="M{start} {y + 0.5}h{x - start}" stroke="{color}"/>')

    markup = "\n".join(paths)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'aria-hidden="true" focusable="false" fill="none" stroke-width="1" '
        f'shape-rendering="geometricPrecision">\n{markup}\n</svg>\n'
    )
    TARGET.write_text(svg, encoding="utf-8")
    SCRIPT_TARGET.write_text(
        "(function (global) {\n"
        '  "use strict";\n'
        "  const LitMTrans = global.LitMTrans = global.LitMTrans || {};\n"
        f"  LitMTrans.readerToolbarIconSVG = {svg!r};\n"
        "})(this);\n",
        encoding="utf-8",
    )
    print(f"Created {TARGET.relative_to(ROOT)} and {SCRIPT_TARGET.relative_to(ROOT)} ({width}×{height}, {len(paths)} strokes).")


if __name__ == "__main__":
    main()
