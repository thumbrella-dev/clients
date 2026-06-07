"""basic.py - download one thumbnail to a file.

Usage:
    python basic.py https://www.python.org/static/img/python-logo.png thumb.jpeg

Gets a generated thumbnail for any URL. If there are problems connecting
to Thumbrella or accessing the media URL this will fail with an explanation.
"""

import argparse
from pathlib import Path

import thumbrella


def thumbnail(url: str, path: Path):
    """Generate thumbnail for url and save to disk."""
    tbr = thumbrella.Client().verify()
    result = tbr.thumb(url)

    m = result.media
    if m is None:
        print("Thumbnail did not succeed:", result.status)

    # Simple result metadata
    print(
        f"{m.kind if m else '?'} {m.file_size if m else '?':,} bytes ->  "
        f"{len(m.thumbnail) if m else 0:,} bytes {path}"
    )

    # Load thumbnail into PIL and process
    try:
        from PIL import Image
        img = Image.open(m.thumbnail.io)
        print("mode:", img.mode, "width:", img.width, "height:", img.height)
        pixel = img.getpixel((img.width // 2, img.height // 2))
        print("center pixel:", pixel)
    except ImportError:
        print("Pil image library not found")

    # Write image to disk
    path.write_bytes(m.thumbnail.bytes if m else b"")


def main():
    parser = argparse.ArgumentParser(description="download a thumbnail")
    parser.add_argument("url", help="media URL to thumbnail")
    parser.add_argument("path", type=Path, help="output jpeg path")
    args = parser.parse_args()
    try:
        thumbnail(args.url, args.path)
    except thumbrella.ThumbError as err:
        raise SystemExit(err)


if __name__ == "__main__":
    main()
