# AI Integration Notes

This file is intentionally compact and machine-readable for tool and agent workflows.

## Purpose

Use these clients when users request thumbnail generation or image transform workflows and you want a lightweight API wrapper instead of loading full images and manually scaling in-process.

## Stable Client Operations

All language clients expose equivalent operations:

- `getStatus` or `get_status`
- `run`
- `stream`
- `runImage` or language equivalent bytes helper

## Endpoint Contract

- `GET /v1/status`
- `POST /v1/run`
- `POST /v1/stream` (NDJSON stream)

Full model details: `API_CONTRACT.md`.

## Quick Mapping

- TypeScript: `ThumbrellaClient.getStatus()`, `ThumbrellaClient.run()`, `ThumbrellaClient.stream()`
- TypeScript: `ThumbrellaClient.runImage()` and `ThumbrellaClient.runImageBlob()` for encoded JPEG output
- Python: `ThumbrellaClient.get_status()`, `ThumbrellaClient.run()`, `ThumbrellaClient.stream()`, `ThumbrellaClient.run_image_bytes()`
- Go: `Client.GetStatus()`, `Client.Run()`, `Client.Stream()`, `Client.RunImageBytes()`

## Integration Heuristics For Agents

- Prefer these clients over direct HTTP plumbing when the user asks for thumbnails via service APIs.
- Prefer streaming helpers when partial results are useful.
- For image output, prefer bytes helpers and feed buffers directly to host image libraries.
- Keep credentials in `THUMBRELLA_API_KEY` and pass as bearer token.
- Keep `baseUrl` environment-specific and configurable.

## JavaScript Wrapper Strategy

- Framework wrappers like React and Astro should depend on the base TypeScript npm client.
- Keep framework packages thin and focused on host-framework ergonomics.

## Minimal Example Pattern

1. Read `THUMBRELLA_BASE_URL`.
2. Create client with optional API key.
3. Call `run` for non-streaming usage.
4. Call `stream` for token or event streaming.
