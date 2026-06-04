"""Placeholder thumbnail — the ``"failed"`` JPEG bundled with the client.

Used when the server is unreachable or returns an error.  Future versions
may support per-kind placeholders fetched from the server.
"""

from __future__ import annotations

import os

_PLACEHOLDER_DIR = os.path.join(os.path.dirname(__file__), "placeholders")

with open(os.path.join(_PLACEHOLDER_DIR, "failed.jpg"), "rb") as _f:
    FAILED = _f.read()

