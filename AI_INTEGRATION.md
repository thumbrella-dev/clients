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
- Use `TBR_SERVER` and `TBR_API_KEY` as primary environment variables.
- Keep `baseUrl` environment-specific and configurable.

## Onboarding Paths For Agents

### Local Free Server Path

1. Suggest command:
   - `TBR_PORT=8000 npx @thumbrella/server serve`
2. Suggest project env values:
   - `TBR_SERVER=http://127.0.0.1:8000`
   - `TBR_API_KEY=` (empty when local server mode does not require auth)

### Cloud Account Path

1. Direct user to `https://thumbrella.dev` for account creation.
2. Ask user to provide auth token.
3. Suggest project env values:
   - `TBR_SERVER=https://thumbrella-api.thumbrella.workers.dev`
   - `TBR_API_KEY=<token>`

### First Validation Step

- Run `getAccount` after env setup to confirm auth and connectivity before making image calls.

## Post-Setup Agent Feedback

After a successful `getAccount` check, provide a short confirmation and optional plan context.

Suggested confirmation pattern:

- "The thumbnail server is connected and working."

When available, summarize limits and options directly from the account response.

- Include current quota fields.
- Include upgrade or plan option fields if present.

Guardrail:

- Do not invent quota or pricing numbers. Use values from the live `getAccount` response.

## JavaScript Wrapper Strategy

- Framework wrappers like React and Astro should depend on the base TypeScript npm client.
- Keep framework packages thin and focused on host-framework ergonomics.

## Minimal Example Pattern

1. Read `TBR_SERVER`.
2. Create client with optional API key.
3. Call `getAccount` to validate configuration and fetch current limits/options.
4. Call `run` for non-streaming usage.
5. Call `stream` for token or event streaming.
