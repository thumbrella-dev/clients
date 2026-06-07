"""stream.py - show progress on async thumbnail rendering.

Usage:
    python stream.py https://www.python.org/static/img/python-logo.png https://www.pygame.org/docs/_images/pygame_powered.png https://pypi.org/unknown.jpg

Gets a generated thumbnail for any URL. If there are problems connecting
to Thumbrella or accessing the media URL this will fail with an explanation.
"""

import asyncio
import argparse
import time

import thumbrella



def main():
    parser = argparse.ArgumentParser(description="monitor streamed results")
    parser.add_argument("urls", nargs="+", help="media URLs to stream")
    parser.add_argument("--batch", action="store_true", help="use sync back instead")
    args = parser.parse_args()

    tbr = thumbrella.Client().verify()
    try:
        if args.batch:
            batched(tbr, args.urls)
        else:
            asyncio.run(streamed(tbr, args.urls))
    except thumbrella.ThumbError as err:
        raise SystemExit(err)


async def streamed(tbr: thumbrella.Client, urls: list[str]):
    """Monitor streamed results."""
    # async with thumbrella.Client() as tbr:
    #     tbr.verify()
    async with tbr:
        indices = _index(urls)
        start = time.time()
        stream = tbr.stream(urls)
        async for result in stream:
            _report(start, indices.get(result.url, "XXX"), result)


def batched(tbr: thumbrella.Client, urls: list[str]):
    """Get all results in one single call"""
    indices = _index(urls)
    start = time.time()
    batch = tbr.batch(urls)
    for result in batch:
        _report(start, indices.get(result.url, "XXX"), result)


def _index(urls: list[str]):
    """Assign report index to each url"""
    indices = {u: f"{i:03d}" for i, u in enumerate(urls, 1)}
    for u, i in indices.items():
        print(f"{i}: {u}")
    return indices

def _report(start: float, idx: str, result: thumbrella.Result):
    """One line report for each result"""
    kind = f"{result.media.kind}({result.media.extension})" if result.media else "<nomedia>"
    print(
        f"{(time.time() - start) * 1000:,.0f}ms {idx}"
        f" - {result.status} {kind} {result.source} {result.message or ''}"
    )

if __name__ == "__main__":
    main()
