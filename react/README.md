# @thumbrella/react

React helpers built on top of @thumbrella/client.

This package is intentionally thin so JavaScript usage is consolidated in the base package.

## Usage

```tsx
import { useThumbrellaImage } from "@thumbrella/react";

const { blob, loading, error } = useThumbrellaImage(
  { baseUrl: "https://api.example.com" },
  { prompt: "Generate a thumbnail" },
);
```

## License

Apache-2.0.
