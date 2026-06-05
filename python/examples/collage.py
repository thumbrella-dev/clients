"""collage.py — stream thumbnails into a grid collage.

Usage:
    python collage.py urls.txt collage.jpg

urls.txt should contain one URL per line (# comments and blank lines ok).

Streams results live and reports timing + cache status.  Thumbnails are
arranged on a 6-column grid (3 columns when fewer than 8 items).
"""

import argparse
import asyncio
import time
from pathlib import Path

import thumbrella

THUMB_W, THUMB_H = 250, 200
SPACING = 4
COLS = 6
COLS_SMALL = 3


async def collage(urls_file: Path, out_path: Path) -> None:
    urls = [
        line.strip()
        for line in urls_file.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]

    # Client reads TBR_CONNECT env var for server URL or cloud token.
    tbr = thumbrella.Client().verify()

    placed: list[thumbrella.Result] = []
    placeholders = 0
    t0 = time.monotonic()

    async for result in tbr.stream(urls):
        elapsed = time.monotonic() - t0

        # Intermediate result — tier1 delegating to a renderer.
        if result.status == "intermediate":
            placeholders += 1
            print(f"  ...      {result.url}")
            continue

        if result.is_success():
            placed.append(result)
            tag = _cache_tag(result)
            print(
                f"  {tag:6s}  {result.duration:>5.0f}ms  "
                f"{result.kind:8s}  {result.mime or '':20s}  {result.url}"
            )
        else:
            print(f"  FAIL     {result.status:16s}  {result.url}")

    if not placed:
        raise SystemExit("no thumbnails to collage")

    # Build collage grid.
    cols = COLS_SMALL if len(placed) < 8 else COLS
    rows = (len(placed) + cols - 1) // cols
    cw, ch = THUMB_W + SPACING, THUMB_H + SPACING
    canvas_w = cols * cw + SPACING
    canvas_h = rows * ch + SPACING

    from PIL import Image

    grid = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))

    for i, r in enumerate(placed):
        col, row = i % cols, i // cols
        x, y = SPACING + col * cw, SPACING + row * ch
        img = Image.open(r.thumbnail.io)
        img.load()
        grid.paste(img, (x, y))

    grid.save(out_path, quality=85)
    print(
        f"\n{len(placed)} thumbnails  "
        f"{rows}x{cols}  "
        f"{grid.size[0]}x{grid.size[1]} px  "
        f"{placeholders} placeholders  ->  {out_path}"
    )


def _cache_tag(result: thumbrella.Result) -> str:
    """Short label for how this thumbnail was produced."""
    src = result.source
    if src == thumbrella.Source.CLIENT:
        return "client"
    if src == thumbrella.Source.CACHE:
        return "cached"
    if src == thumbrella.Source.SHORTCUT:
        return "embed"
    return "render"


def main() -> None:
    parser = argparse.ArgumentParser(description="stream thumbnails into a collage")
    parser.add_argument("urls", type=Path, help="file with one media URL per line")
    parser.add_argument("out", type=Path, help="output collage JPEG path")
    args = parser.parse_args()
    try:
        asyncio.run(collage(args.urls, args.out))
    except thumbrella.ThumbError as err:
        raise SystemExit(err)


if __name__ == "__main__":
    main()
