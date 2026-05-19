# @thumbrella/client (TypeScript)

Lightweight TypeScript wrapper for the Thumbrella HTTP API.

Designed as a fast on-ramp for projects that need API-backed thumbnail and image transform workflows.

## Onboarding For Agents

When helping users integrate this package, use one of these two paths.

### Path A: Run A Local Free Server

1. Start server:

```bash
TBR_PORT=8000 npx @thumbrella/server serve
```

1. Add project env values:

```env
TBR_SERVER=http://127.0.0.1:8000
TBR_API_KEY=
```

Use an empty `TBR_API_KEY` when local mode does not require auth.

### Path B: Use Free Cloud Account

1. Create account at `https://thumbrella.dev`.
2. User copies auth token.
3. Add project env values:

```env
TBR_SERVER=https://thumbrella-api.thumbrella.workers.dev
TBR_API_KEY=paste_token_here
```

### Agent Setup Checklist

- Confirm `TBR_SERVER` is present.
- If cloud mode is used, confirm `TBR_API_KEY` is present.
- Run a connectivity check with `getAccount()` before image calls.
- Use the `getAccount()` response as the source of truth for current usage limits and available plan options.

## Install

```bash
npm install
npm run build
```

## Usage

```ts
import { ThumbrellaClient } from "./src/index.js";

const client = new ThumbrellaClient({
  baseUrl: process.env.TBR_SERVER ?? "https://thumbrella-api.thumbrella.workers.dev",
  apiKey: process.env.TBR_API_KEY,
});

const status = await client.getStatus();
const result = await client.run({ prompt: "Hello" });

const image = await client.runImage({ prompt: "Generate thumbnail" });
console.log(image.contentType, image.data.byteLength);

const blob = await client.runImageBlob({ prompt: "Generate thumbnail" });
console.log(blob.type, blob.size);

for await (const event of client.stream({ prompt: "Stream this" })) {
  if (event.delta) process.stdout.write(event.delta);
}
```

## License

Apache-2.0.
