# Thumbrella Client Contract

This document describes the shared logical API expected across all language clients.

Primary output for image generation endpoints is encoded JPEG bytes. Clients should expose a comfortable bytes or buffer API first, with optional convenience converters layered on top.

## Models

### RunRequest

- `prompt: string`
- `metadata?: map<string, string>`

### RunResponse

- `requestId: string`
- `output: string`
- `model?: string`

### StreamEvent

- `requestId: string`
- `type: string` (for example `delta`, `done`, `error`)
- `delta?: string`
- `done?: bool`
- `error?: string`

### StatusResponse

- `ok: bool`
- `version?: string`

## Operations

### getStatus

- HTTP: `GET /v1/status`
- Returns: `StatusResponse`

### run

- HTTP: `POST /v1/run`
- Body: `RunRequest`
- Returns: `RunResponse` for JSON mode, or JPEG bytes when `Accept: image/jpeg` is requested

### runImage

- HTTP: `POST /v1/run`
- Body: `RunRequest`
- Header: `Accept: image/jpeg`
- Returns: encoded JPEG bytes

### stream

- HTTP: `POST /v1/stream`
- Body: `RunRequest`
- Returns: newline-delimited JSON stream of `StreamEvent`

## Streaming Format

- Response body is NDJSON where each line is one JSON object.
- Clients should ignore empty lines.
- Parsing should be resilient to chunk boundaries.
