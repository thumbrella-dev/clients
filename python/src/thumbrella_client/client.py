from __future__ import annotations

import json
from dataclasses import asdict
from typing import AsyncIterator, Dict, Optional

import aiohttp
import requests

from .models import RunRequest, RunResponse, StatusResponse, StreamEvent


class ThumbrellaClient:
    def __init__(self, base_url: str, api_key: Optional[str] = None, timeout_seconds: int = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    def get_status(self) -> StatusResponse:
        data = self._request_json("GET", "/v1/status")
        return StatusResponse(ok=bool(data.get("ok")), version=data.get("version"))

    def run(self, payload: RunRequest) -> RunResponse:
        data = self._request_json("POST", "/v1/run", json_body=asdict(payload))
        return RunResponse(
            request_id=str(data.get("requestId", "")),
            output=str(data.get("output", "")),
            model=data.get("model"),
        )

    def run_image_bytes(self, payload: RunRequest) -> bytes:
        return self._request_bytes(
            "POST",
            "/v1/run",
            json_body=asdict(payload),
            accept="image/jpeg",
        )

    async def stream(self, payload: RunRequest) -> AsyncIterator[StreamEvent]:
        headers = self._headers()
        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)

        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.base_url}/v1/stream",
                headers=headers,
                json=asdict(payload),
            ) as response:
                response.raise_for_status()

                async for raw_line in response.content:
                    line = raw_line.decode("utf-8").strip()
                    if not line:
                        continue

                    event = json.loads(line)
                    yield StreamEvent(
                        request_id=str(event.get("requestId", "")),
                        type=str(event.get("type", "unknown")),
                        delta=event.get("delta"),
                        done=event.get("done"),
                        error=event.get("error"),
                    )

    def _request_json(self, method: str, path: str, json_body: Optional[Dict[str, object]] = None) -> Dict[str, object]:
        response = requests.request(
            method,
            f"{self.base_url}{path}",
            headers=self._headers(),
            json=json_body,
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        return response.json()

    def _request_bytes(
        self,
        method: str,
        path: str,
        json_body: Optional[Dict[str, object]] = None,
        accept: Optional[str] = None,
    ) -> bytes:
        response = requests.request(
            method,
            f"{self.base_url}{path}",
            headers=self._headers(accept=accept),
            json=json_body,
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        return response.content

    def _headers(self, accept: Optional[str] = None) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if accept:
            headers["Accept"] = accept
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers
