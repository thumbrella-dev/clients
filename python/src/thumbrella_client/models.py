from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass(slots=True)
class RunRequest:
    prompt: str
    metadata: Dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class RunResponse:
    request_id: str
    output: str
    model: Optional[str] = None


@dataclass(slots=True)
class StatusResponse:
    ok: bool
    version: Optional[str] = None


@dataclass(slots=True)
class StreamEvent:
    request_id: str
    type: str
    delta: Optional[str] = None
    done: Optional[bool] = None
    error: Optional[str] = None
