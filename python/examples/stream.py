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
    """Report individual results from streamed request"""
    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("urls", nargs="+", help="media URLs to stream")
    args = parser.parse_args()
    tbr = thumbrella.Client().verify()
    asyncio.run(streamed(tbr, args.urls))

async def streamed(tbr: thumbrella.Client, urls: list[str]):
    """Stream async results."""
    start = time.time()
    async with tbr:
        stream = tbr.stream(urls)
        async for result in stream:
            _report(start, result)

def _report(start: float, result: thumbrella.Result):
    """Simple line report for each result"""
    kind = f"{result.media.kind} {result.media.extension}"
    duration = (time.time() - start) * 1000
    base = result.url.rsplit("/", 1)[-1]
    msg = f'"{result.message}"' or ''
    print(f"{duration:,.0f}ms {result.status} {base} - {kind}, {result.source} {msg}")

if __name__ == "__main__":
    main()
