# Temporary Client Design Notes

Status: temporary working plan for initial client-library rollout.

This file is intended to be removed or folded into long-term docs once the first language clients are stable.

## 1) API Transport Strategy (Near Term)

- Keep URL-based source flow as the baseline for server-to-server usage.
- Add upload-based flow for local files and in-memory buffers.
- Start with plain HTTP POST upload as the reliability-first approach.
- Defer chunk negotiation (`need_more_data`) and advanced session protocols until later.

Near-term endpoint model:

- `GET /v1/status`
- `POST /v1/run` (JSON response mode)
- `POST /v1/run` with `Accept: image/jpeg` (binary JPEG mode)
- `POST /v1/stream` (NDJSON stream)

## 2) Binary-First Output for Image Calls

- Primary image output from client libraries should be encoded JPEG bytes.
- Core clients should expose byte-friendly methods first.
- Optional adapters (for PIL/ImageData/etc.) should be separate add-ons, not required by core clients.

Current direction by language:

- TypeScript: `runImage()` returns bytes metadata; `runImageBlob()` for browser/runtime blob workflows.
- Python: `run_image_bytes()` returns `bytes`.
- Go: `RunImageBytes()` returns `[]byte`.

## 3) Cross-Language Config Shape

Use a runtime server config object in every client:

- `baseUrl` (required)
- `apiKey` (optional)
- `timeoutMs` or language equivalent (optional)
- optional headers/user-agent fields

Resolution order:

1. Explicit call-level config
2. Client instance config
3. Environment variables
4. Language default values

Environment variable defaults:

- `TBR_SERVER`
- `TBR_API_KEY`
- `TBR_TIMEOUT_MS`

Guideline:

- Avoid mutable global singleton config as the primary pattern.
- Offer convenience constructors/helpers from env for simple scripts.

## 4) Sync/Async Surface Plan

- Keep one shared request/response model set per language.
- Where language ecosystems support both styles, provide sync and async client surfaces.
- Keep method semantics and outputs equivalent between sync and async variants.

Language intent:

- TypeScript/JavaScript: async-first only.
- Python: sync + async clients.
- Go: sync methods plus goroutine/channel composition (no separate async client needed initially).
- Rust/Swift (future): async-first with optional blocking/convenience layers.

## 5) JavaScript Package Strategy

- Keep base JS/TS client as the primary package.
- Framework-specific packages (React, Astro, etc.) remain thin wrappers that depend on the base package.
- This consolidates usage/telemetry around the base npm package while preserving framework ergonomics.

## 6) Temporary Exit Criteria

Retire this file after:

- upload flow contract is finalized,
- config object shape is stable across at least 3 language clients,
- sync/async parity guidance is moved into permanent docs,
- framework wrapper policy is documented in long-term package docs.

## 7) Server Binary Distribution (Planned)

Goal: extremely low-friction local server startup for developers.

Target UX:

- npm execution path: `TBR_PORT=8001 npx thumbrella/bin serve`
- uvx execution path: `TBR_PORT=8001 uvx thumbrella-server serve`

Recommended packaging model:

- Publish prebuilt server binaries for major targets (linux/macos/windows, x64/arm64).
- Provide thin launcher packages that resolve platform binary and exec it.
- Keep launcher logic minimal and predictable.

NPM path notes:

- Package name can be `thumbrella` with an exported bin command.
- Keep CLI entrypoint stable (`thumbrella` and optionally alias path forms).
- If `thumbrella/bin` path form is desired, verify npm bin mapping behavior and implement explicit wrappers if needed.

PyPI/uvx path notes:

- Publish a Python launcher package with a console script (for example `thumbrella-server`).
- Launcher should detect platform, fetch or bundle the matching binary, and exec.
- Prefer deterministic cache location and checksum verification.

Operational considerations:

- Signed checksums per release artifact.
- Clear version pinning and `latest` behavior.
- Helpful first-run errors when platform binary is unavailable.
- Environment variable passthrough (`TBR_PORT`, server auth/env config).

Defer until server release process is stable:

- full auto-update behavior,
- advanced background service management,
- shell-specific installer scripts.

At that point, move durable guidance to:

- `README.md`
- `API_CONTRACT.md`
- `AI_INTEGRATION.md`
