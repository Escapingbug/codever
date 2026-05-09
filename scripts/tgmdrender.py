#!/usr/bin/env python3
"""tgmdrender — Stateless CLI wrapper around OpenHarness markdown rendering pipeline.

Converts Markdown into Telegram-compatible format using telegramify-markdown
(entity-based, not HTML) and md2png-lite (table images).

Subcommands:
  convert   Markdown → JSON with text + entities + table segments
  split     Markdown → JSON chunks fitting Telegram UTF-16 limits
  table     Markdown table → PNG binary on stdout
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# Table detection (from OpenHarness telegram.py)
# ---------------------------------------------------------------------------

_TABLE_BLOCK_RE = re.compile(
    r"(?:^[ \t]*\|[^\n]+\|[ \t]*$\n)+"   # header rows
    r"^[ \t]*\|[-: \t|]+\|[ \t]*$\n"      # separator row
    r"(?:^[ \t]*\|[^\n]+\|[ \t]*$\n?)*",   # data rows
    re.MULTILINE,
)


def _split_by_tables(markdown: str) -> list[tuple[str, str]]:
    """Split markdown into ordered segments: ('text', content) or ('table', content)."""
    segments: list[tuple[str, str]] = []
    cursor = 0
    for m in _TABLE_BLOCK_RE.finditer(markdown):
        start, end = m.span()
        if start > cursor:
            segments.append(("text", markdown[cursor:start]))
        segments.append(("table", m.group(0)))
        cursor = end
    if cursor < len(markdown):
        segments.append(("text", markdown[cursor:]))
    return segments


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _entity_to_dict(e) -> dict:
    """Convert a telegramify-markdown entity to a plain dict."""
    d = e.to_dict() if hasattr(e, "to_dict") else dict(e)
    return d


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def _split_plain_text(text: str, max_utf16_len: int) -> list[dict]:
    """Split plain text into chunks that fit within Telegram's UTF-16 limit."""
    if not text:
        return [{"kind": "text", "text": text, "entities": []}]

    chunks: list[dict] = []
    remaining = text
    while remaining:
        if _utf16_len(remaining) <= max_utf16_len:
            chunks.append({"kind": "text", "text": remaining, "entities": []})
            break

        lo, hi = 1, len(remaining)
        cut = min(len(remaining), max_utf16_len)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if _utf16_len(remaining[:mid]) <= max_utf16_len:
                lo = mid
            else:
                hi = mid - 1
        cut = lo

        nl = remaining.rfind("\n", 0, cut)
        if nl > 0:
            cut = nl + 1

        chunks.append({"kind": "text", "text": remaining[:cut], "entities": []})
        remaining = remaining[cut:]

    return chunks


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def cmd_convert(args: argparse.Namespace) -> None:
    """Convert markdown to JSON: text+entities segments, with table detection."""
    from telegramify_markdown import convert

    md = sys.stdin.read()

    if args.no_split:
        segments = [("text", md)]
    else:
        segments = _split_by_tables(md)

    results: list[dict] = []
    for kind, content in segments:
        if kind == "table":
            results.append({"kind": "table", "markdown": content})
        else:
            try:
                text, entities = convert(content)
                ent_dicts = [_entity_to_dict(e) for e in entities]
            except Exception:
                text = content
                ent_dicts = []
            results.append({
                "kind": "text",
                "text": text,
                "entities": ent_dicts,
            })

    json.dump(results, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def cmd_split(args: argparse.Namespace) -> None:
    """Convert markdown and split into Telegram UTF-16 sized chunks."""
    from telegramify_markdown import convert, split_entities
    try:
        from telegram import MessageEntity as TGMessageEntity
        HAS_TG = True
    except ImportError:
        HAS_TG = False

    md = sys.stdin.read()
    max_utf16 = args.max_utf16

    segments = _split_by_tables(md)
    results: list[dict] = []

    for kind, content in segments:
        if kind == "table":
            results.append({"kind": "table", "markdown": content})
            continue

        try:
            text, entities = convert(content)
            if HAS_TG and entities:
                tg_entities = [TGMessageEntity.de_json(_entity_to_dict(e), None) for e in entities]
                chunks = split_entities(text, tg_entities, max_utf16_len=max_utf16)
                for chunk_text, chunk_entities in chunks:
                    ent_dicts = [_entity_to_dict(e) for e in chunk_entities]
                    results.append({
                        "kind": "text",
                        "text": chunk_text,
                        "entities": ent_dicts,
                    })
            elif entities:
                # No python-telegram-bot available; use convert output directly
                # and fall back to plain text splitting if too long
                if _utf16_len(text) <= max_utf16:
                    ent_dicts = [_entity_to_dict(e) for e in entities]
                    results.append({
                        "kind": "text",
                        "text": text,
                        "entities": ent_dicts,
                    })
                else:
                    # Can't split with entities, convert to plain text chunks
                    results.extend(_split_plain_text(text, max_utf16))
            else:
                results.extend(_split_plain_text(text, max_utf16))
        except Exception:
            results.extend(_split_plain_text(content, max_utf16))

    json.dump(results, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def cmd_table(args: argparse.Namespace) -> None:
    """Render a markdown table as a PNG image (binary on stdout)."""
    from md2png_lite import render_markdown_image

    md = sys.stdin.read()

    # Build font paths for better emoji/CJK support on Windows
    font_paths: list[str] = []
    if sys.platform == "win32":
        fonts_dir = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "Fonts")
        # Priority: Segoe UI Emoji for emoji, Segoe UI for Latin, then CJK fallbacks
        for name in [
            "seguiemj.ttf",     # Segoe UI Emoji
            "segoeui.ttf",       # Segoe UI Regular
            "segoeuib.ttf",      # Segoe UI Bold
            "msyh.ttc",          # Microsoft YaHei (CJK)
            "msyhbd.ttc",        # Microsoft YaHei Bold
        ]:
            p = os.path.join(fonts_dir, name)
            if os.path.isfile(p):
                font_paths.append(p)

    result = render_markdown_image(
        md,
        theme=args.theme,
        font_paths=font_paths if font_paths else None,
    )

    if not result.get("ok"):
        print(f"Error: md2png-lite rendering failed: {result}", file=sys.stderr)
        sys.exit(1)

    img_bytes = base64.b64decode(result["base64"])
    sys.stdout.buffer.write(img_bytes)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    # Ensure UTF-8 IO on Windows — the Node.js caller sets PYTHONIOENCODING=utf-8
    # in the spawn env, so no reconfigure needed here.

    parser = argparse.ArgumentParser(
        prog="tgmdrender",
        description="Render Markdown for Telegram (entity-based, not HTML)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # convert
    p_convert = sub.add_parser("convert", help="Markdown → JSON (text + entities + table segments)")
    p_convert.add_argument("--no-split", action="store_true", help="Skip table detection")

    # split
    p_split = sub.add_parser("split", help="Markdown → JSON chunks fitting Telegram UTF-16 limits")
    p_split.add_argument("--max-utf16", type=int, default=4000, help="Max UTF-16 code units per chunk (default: 4000)")

    # table
    p_table = sub.add_parser("table", help="Markdown table → PNG binary")
    p_table.add_argument("--theme", default="github-dark", help="md2png-lite theme (default: github-dark)")

    args = parser.parse_args()

    if args.command == "convert":
        cmd_convert(args)
    elif args.command == "split":
        cmd_split(args)
    elif args.command == "table":
        cmd_table(args)


if __name__ == "__main__":
    main()
