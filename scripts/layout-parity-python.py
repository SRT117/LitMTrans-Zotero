"""Render a translated layout through the original Python implementation.

This is intentionally a very small bridge.  The orchestration and comparison
live in layout-parity-test.mjs; this file only imports the real desktop project
and calls its production layout functions with an existing translation cache.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def translation_map(cache: dict) -> dict[str, str]:
    values = cache.get("translations") or {}
    if not values and cache and all(isinstance(value, str) for value in cache.values()):
        values = cache
    if isinstance(values, dict):
        return {str(key): str(value) for key, value in values.items()}
    return {
        str(item.get("id") or ""): str(item.get("text") or "")
        for item in values
        if isinstance(item, dict) and item.get("id")
    }


def stream_trace(stream: dict) -> dict:
    """Keep the Python engine's actual fitter inputs reviewable in parity runs."""
    items = stream.get("items") or []
    return {
        "page": int(stream.get("page_index") or 0) + 1,
        "bbox": [round(float(value), 3) for value in (stream.get("bbox") or [])[:4]],
        "debug_role": str(stream.get("debug_role") or ""),
        "column_key": str(stream.get("column_key") or ""),
        "items": [
            {
                "kind": str(item.get("kind") or ""),
                "bbox": [round(float(value), 3) for value in (item.get("bbox") or [])[:4]],
                "plain_text": str(item.get("plain_text") or ""),
                "paragraphs": [
                    {
                        "plain_text": str(paragraph.get("plain_text") or ""),
                        "indent_px": float(paragraph.get("indent_px") or 0.0),
                    }
                    for paragraph in (item.get("paragraphs") or [])
                    if isinstance(paragraph, dict)
                ],
            }
            for item in items
            if isinstance(item, dict)
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python-root", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--translation-cache", type=Path)
    args = parser.parse_args()

    python_root = args.python_root.resolve()
    fixture = args.fixture.resolve()
    sys.path.insert(0, str(python_root))

    import PB_layout as desktop_layout  # noqa: PLC0415
    import layout_translate_preview as translated_layout  # noqa: PLC0415

    markdown = fixture / "full.cleaned.md"
    cache_path = (args.translation_cache or fixture / "layout_translation_blocks.zh.json").resolve()
    if not markdown.is_file():
        raise SystemExit(f"Missing Python layout input: {markdown}")
    if not cache_path.is_file():
        raise SystemExit(f"Missing translated-block cache: {cache_path}")

    bundle = desktop_layout.load_layout_preview_bundle(markdown)
    if not bundle:
        raise SystemExit(f"Cannot load the MinerU layout bundle for {markdown}")
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    records = translated_layout.iter_translatable_blocks(bundle["page_info"])
    translations = translation_map(cache)
    translated_layout.apply_translations(records, translations)
    replacements = cache.get("formula_replacements") or {}
    if isinstance(replacements, dict):
        formulas = translated_layout.iter_formula_context(bundle["page_info"])
        translated_layout.apply_formula_replacements(formulas, replacements)

    source_html = desktop_layout.render_layout_preview_html(markdown)
    if not source_html:
        raise SystemExit("The Python project could not render its source layout preview")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    style_calls: list[dict] = []
    original_solver = desktop_layout.solve_uniform_stream_style
    original_translated_solver = translated_layout.mineru.solve_uniform_stream_style

    def traced_solver(streams, ocr_boxes_by_page, refs_only):
        style = original_solver(streams, ocr_boxes_by_page, refs_only)
        style_calls.append(
            {
                "refs_only": bool(refs_only),
                "style": [float(style[0]), float(style[1])],
                "streams": [
                    {
                        **stream_trace(stream),
                        "line_metrics": list(
                            desktop_layout.stream_line_metrics(
                                stream.get("items") or [],
                                ocr_boxes_by_page.get(int(stream.get("page_index") or 0), []),
                            )
                        ),
                    }
                    for stream in streams
                ],
            }
        )
        return style

    desktop_layout.solve_uniform_stream_style = traced_solver
    translated_layout.mineru.solve_uniform_stream_style = traced_solver
    try:
        translated_layout.render_translated_layout(
            markdown,
            bundle,
            source_html,
            args.output,
            debug_overlay=True,
            reset_fit_cache=True,
            bundle_out_path=args.output.with_suffix(".bundle.json"),
        )
    finally:
        desktop_layout.solve_uniform_stream_style = original_solver
        translated_layout.mineru.solve_uniform_stream_style = original_translated_solver
    args.output.with_suffix(".engine.json").write_text(
        json.dumps({"style_calls": style_calls}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(args.output)


if __name__ == "__main__":
    main()
