"""gallery.py — stream a batch of URLs with live progress and local caching.

Usage:
    python gallery.py urls.txt thumbs/

urls.txt should contain one URL per line (# comments and blank lines ok).

Re-running with the same output directory skips unchanged thumbnails by
persisting cache tokens in thumbs/.thumbrella_cache.json.

"""

import argparse
import asyncio
import json
from pathlib import Path

import thumbrella


async def gallery(urls_file: Path, out_dir: Path) -> None:
    """Stream thumbnails for urls in *urls_file*, save to *out_dir*."""
    out_dir.mkdir(parents=True, exist_ok=True)
    urls = [
        line.strip()
        for line in urls_file.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]

    # Restore persistent cache tokens from last run.
    cache_path = out_dir / ".thumbrella_cache.json"
    prev_cache: dict[str, str] = {}
    try:
        prev_cache = json.loads(cache_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Client reads TBR_CONNECT env var for server URL or cloud token.
    tbr = thumbrella.Client().verify()
    image_loader = await _ensure_pil()

    image_cache: dict[int, object] = {}  # key → PIL Image
    new_cache: dict[str, str] = {}
    new_count, unchanged, failed = 0, 0, 0

    async for result in tbr.stream(urls):
        # Restore cache token so the server can 304 on unchanged media.
        if result.url in prev_cache:
            result.cache = prev_cache[result.url]

        if result.is_success():
            if result.is_fresh():
                unchanged += 1
            else:
                new_count += 1

            if result.cache:
                new_cache[result.url] = result.cache

            # Decode with PIL, deduplicated by thumbnail content key.
            img = image_cache.get(result.thumbnail.key)
            if img is None and image_loader is not None:
                img = image_loader(result.thumbnail.io)
                image_cache[result.thumbnail.key] = img

            # Save thumbnail.
            stem = result.url.rstrip("/").split("/")[-1] or "thumb"
            safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in stem)
            path = out_dir / f"{safe}.jpg"
            path.write_bytes(result.thumbnail.bytes)

            w, h = img.size if img else (0, 0)
            tag = "(cached)" if result.is_fresh() else ""
            print(f"  {tag:9s}{result.kind:8s} {w:>4d}x{h:<4d}  {result.mime:20s}  {result.url}")
        else:
            failed += 1
            print(f"  FAIL    {result.status:16s}  {result.url}")

    if new_cache:
        cache_path.write_text(json.dumps(new_cache, indent=2))

    print(f"\n{new_count} new, {unchanged} unchanged, {failed} failed")


async def _ensure_pil():
    """Return an image loader function, or None if Pillow is missing."""
    try:
        from PIL import Image
    except ImportError:
        print("(install Pillow for image dimensions)")
        return None

    def load(io) -> object:
        img = Image.open(io)
        img.load()
        return img

    return load


def main() -> None:
    parser = argparse.ArgumentParser(description="stream thumbnails from a URL list")
    parser.add_argument("urls", type=Path, help="file with one media URL per line")
    parser.add_argument("out_dir", type=Path, help="directory for output JPEGs")
    args = parser.parse_args()
    try:
        asyncio.run(gallery(args.urls, args.out_dir))
    except thumbrella.ThumbError as err:
        raise SystemExit(err)


if __name__ == "__main__":
    main()
