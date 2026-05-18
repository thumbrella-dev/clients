# thumbrella-client (Python)

Lightweight Python wrapper for the Thumbrella HTTP API.

Designed as a fast on-ramp for projects that need API-backed thumbnail and image transform workflows.

## Install

```bash
pip install -e .
```

## Usage

```python
import asyncio

from thumbrella_client import RunRequest, ThumbrellaClient

client = ThumbrellaClient(base_url="https://api.example.com")
status = client.get_status()
result = client.run(RunRequest(prompt="Hello"))
image_bytes = client.run_image_bytes(RunRequest(prompt="Generate thumbnail"))
print(len(image_bytes))

async def main() -> None:
    async for event in client.stream(RunRequest(prompt="Stream this")):
        if event.delta:
            print(event.delta, end="")

asyncio.run(main())
```

## License

Apache-2.0.
