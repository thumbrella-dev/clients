# @thumbrella/client (TypeScript)

Lightweight TypeScript wrapper for the Thumbrella HTTP API.

Designed as a fast on-ramp for projects that need API-backed thumbnail and image transform workflows.

## Install

```bash
npm install
npm run build
```

## Usage

```ts
import { ThumbrellaClient } from "./src/index.js";

const client = new ThumbrellaClient({
  baseUrl: "https://api.example.com",
  apiKey: process.env.THUMBRELLA_API_KEY,
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
