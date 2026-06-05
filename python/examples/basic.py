"""basic.py - download one thumbnail to a file.

Usage:
    python basic.py https://www.python.org/static/img/python-logo.png thumb.jpeg

Gets a generated thumbnail for any url. If there any problems connecting to
Thumbrella or accessing the media url this will fail with a simple explanation.

"""

import argparse
import sys
from pathlib import Path

import thumbrella


def thumbnail(url: str, path: Path):
    """Generate thumbnail for url and save disk"""
    # Client reads TBR_CONNECT env var for server URL or cloud token.
    # Verify ensures our connection is good instead of falling back on 
    # bad placeholders when the server is not succeeding.
    tbr = thumbrella.Client().verify()

    # The thumb will fail if there was a problem handing the media,
    # unlike other calls like batch() or stream() which provide placeholders.
    result = tbr.thumb(url)

    path.write_bytes(result.thumbnail.bytes)
    print(
        f"{result.kind} {result.file_size or '?':,} bytes ->  "
        f"{len(result.thumbnail.bytes):,} bytes {path}"
    )


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
