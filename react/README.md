# @thumbrella/react

React components for [Thumbrella](https://thumbrella.dev) — a thumbnail API
that handles images, video, documents, 3D models, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/react)](https://www.npmjs.com/package/@thumbrella/react)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)

Built on `@thumbrella/client`. Provides two components:

- **`<Thumbnail>`** — drop-in `<img>` replacement. Always renders an image,
  even if the server is unreachable. Longer renders show a temporary
  placeholder until the final thumbnail arrives.
- **`<Thumbrella>`** — scoped coordinator. Group `<Thumbnail>` components
  inside it and they share configuration, batch requests into a single
  streaming call, and reuse identical placeholder images.

## Install

```bash
npm install @thumbrella/react
```

Requires `react >= 18`.

## Usage

```tsx
import { Thumbnail, Thumbrella } from "@thumbrella/react";

function Gallery() {
  return (
    <Thumbrella connect="https://demo.thumbrella.dev">
      <Thumbnail src="https://demo.thumbrella.dev/media/neon-block.png" />
      <Thumbnail src="https://demo.thumbrella.dev/media/space-colony.jpg" />
      <Thumbnail src="https://demo.thumbrella.dev/media/stanford-bunny.stl" />
    </Thumbrella>
  );
}
```

Thumbnails don't need to be immediate children of `<Thumbrella>` — anywhere
in the subtree works. New thumbnails added dynamically are picked up
automatically via a `MutationObserver`.

### Connect strings

```tsx
{/* Public demo server (no auth needed) */}
<Thumbrella connect="https://demo.thumbrella.dev">

{/* Self-hosted server with an auth token */}
<Thumbrella connect="tbr_e_YOURKEY">
```

Use publishable keys in client-side code — they're visible to end users.

### Lazy loading

```tsx
<Thumbrella connect="..." lazyLoad>
```

Only loads thumbnails as they scroll into view. Override per element with
`<Thumbnail lazyLoad={false} />`.

### Events

Each thumbnail fires a `tbr:loaded` event with result data:

```tsx
<div onTbrLoaded={(e) => console.log(e.detail.status)}>
  <Thumbnail src="..." />
</div>
```

The `detail` object contains `url`, `status`, `source`, `kind`, `duration`,
`message`, `bytes`, and `placeholder`.

## Demo

```bash
npm run demo
```

Renders four hardcoded thumbnails from the demo server on `localhost:4343`.

## License

Apache-2.0. See [LICENSE](./LICENSE).

