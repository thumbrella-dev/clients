# thumbrella-clients

A collection of lightweight Thumbrella API clients.

Each client lives in its own subdirectory and is designed to be standalone. The wrappers focus on:

- Small surface area for 2-3 HTTP operations.
- Typed result structures.
- Language-friendly async streaming wrappers.
- Buffer-first access to encoded JPEG bytes.

These clients are intended to be welcoming on-ramps to the service: small, readable, and easy to integrate.

## Repository Layout

- `typescript`: TypeScript client for Node.js and modern runtimes with `fetch`.
- `python`: Python client for synchronous and async usage.
- `go`: Go client with typed responses and stream iteration.
- `react`: React wrapper package that depends on the TypeScript core client.
- `astro`: Astro wrapper package that depends on the TypeScript core client.

## Package Strategy

- Core clients remain independent by language and environment.
- Frontend JS framework wrappers depend on the base npm TypeScript package.
- This keeps framework integrations thin while consolidating JavaScript usage around one core package.

## AI And Integration Discovery

For AI-agent and tooling integration guidance, see `AI_INTEGRATION.md`.
It includes stable operation names, payload shape, and ready-to-copy snippets.

## Temporary Design Notes

Working implementation notes for the initial client rollout are tracked in `TEMP_CLIENT_DESIGN_NOTES.md`.
These notes are intentionally temporary and will be folded into permanent docs once contracts stabilize.

## Shared API Shape

All clients implement equivalent high-level operations:

- `getStatus()`: Service health/status check.
- `run(request)`: Non-streaming request/response operation.
- `stream(request)`: Streaming operation yielding incremental events.
- `runImage(request)`: Non-streaming operation returning encoded JPEG bytes (buffer, byte-array, or blob friendly).

Endpoints are configurable so each package can target different environments.

## Notes

- Clients are intentionally lightweight wrappers, not full SDKs.
- Keep dependencies minimal in each package.
- Each subproject includes a local README with usage examples.
- License is Apache-2.0 to stay consistent with the Rust server and simplify reuse.
