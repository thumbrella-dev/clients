# @thumbrella/astro

Astro helpers built on top of @thumbrella/client.

This package is intentionally thin so JavaScript usage is consolidated in the base package.

## Usage

```ts
import { fetchThumbrellaImageBytes } from "@thumbrella/astro";

const data = await fetchThumbrellaImageBytes(
  { baseUrl: "https://api.example.com" },
  { prompt: "Generate a thumbnail" },
);
```

## License

Apache-2.0.
