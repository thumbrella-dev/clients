# @thumbrella/react

React components for [Thumbrella](https://thumbrella.dev), a fast thumbnail
server for images, video, documents, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/react)](https://www.npmjs.com/package/@thumbrella/react)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

> Thumbrella is still in prerelease. The server functionality is operational,
> but several production components have yet to appear. Recommended for early
> evaluation only.

Built on [`@thumbrella/client`](https://www.npmjs.com/package/@thumbrella/client).
Drop-in components that batch requests and stream thumbnails into your page.

## Install

```bash
npm install @thumbrella/react
```

Requires `react >= 18`.

## Quickstart

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

Thumbnails don't need to be immediate children of `<Thumbrella>`, anywhere in
the subtree works. New thumbnails added dynamically are picked up automatically.

### Connect Strings

```tsx
{/* Public demo server, no auth needed */}
<Thumbrella connect="https://demo.thumbrella.dev">

{/* Self-hosted with a publishable key */}
<Thumbrella connect="https://cloud.thumbrella.dev,tbr_p_...">
```

Use publishable keys (`tbr_p_`) in client-side code, they're visible to end
users and can be scoped to specific domains and quotas.

### Lazy Loading

```tsx
<Thumbrella connect="..." lazyLoad>

<Thumbnail src="..." lazyLoad={false} />
```

### Events

Each thumbnail fires a `tbr:loaded` event when it finishes:

```tsx
<div onTbrLoaded={(e) => console.log(e.detail.status, e.detail.kind)}>
  <Thumbnail src="https://demo.thumbrella.dev/media/raw-canon.cr2" />
</div>
```

## Servers

Works with self-hosted Thumbrella servers and Thumbrella Cloud. Thumbrella
provides a [demo gallery](https://demo.thumbrella.dev) and server for free
evaluation, no account required.

## Next Steps

- **[Client docs](https://thumbrella.dev/docs/client/)** - full API reference
- **[Thumbrella](https://thumbrella.dev)** - main site
- **[GitHub](https://github.com/thumbrella-dev/clients)** - source and issues

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).

