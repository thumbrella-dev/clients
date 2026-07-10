# @thumbrella/astro

Astro components for [Thumbrella](https://thumbrella.dev), a fast thumbnail
server for images, video, documents, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/astro)](https://www.npmjs.com/package/@thumbrella/astro)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

> Thumbrella is still in prerelease. The server functionality is operational,
> but several production components have yet to appear. Recommended for early
> evaluation only.

Built on [`@thumbrella/client`](https://www.npmjs.com/package/@thumbrella/client).
Drop-in components that batch requests and stream thumbnails into your Astro
pages — with zero-config lazy loading, CSS lifecycle hooks, and SPA support.

## Install

```bash
npm install @thumbrella/astro
```

## Quickstart

```astro
---
import { Thumbnail, Thumbrella } from "@thumbrella/astro";
---

<Thumbrella connect="https://demo.thumbrella.dev">
  <Thumbnail src="https://demo.thumbrella.dev/media/apollo-exterior.glb" />
  <Thumbnail src="https://demo.thumbrella.dev/media/raw-pentax.pef" />
  <Thumbnail src="https://demo.thumbrella.dev/media/neon-block.png" />
</Thumbrella>
```

Thumbnails don't need to be direct children — anywhere in the subtree is
discovered, deduplicated by URL, and loaded through a single `stream()` call.
Thumbnails added dynamically (SPA navigation, infinite scroll) are picked up
automatically.

Every `<Thumbnail>` always renders an image — even on failure, or with no
server. A placeholder shows immediately and the final thumbnail fades in when
it arrives.

### Connect Strings

```astro
<!-- Public demo server — no auth needed -->
<Thumbrella connect="https://demo.thumbrella.dev">

<!-- Self-hosted with a publishable key -->
<Thumbrella connect="https://cloud.thumbrella.dev,tbr_p_...">
```

Use publishable keys (`tbr_p_`) in client-side code — they're visible to end
users and can be scoped to specific domains and quotas.

### Lazy Loading

```astro
<Thumbrella connect="..." lazyLoad>

<Thumbnail src="..." lazyLoad={false} />
```

### Events

Listen for `tbr:loaded` to build custom overlays or status badges:

```html
<script>
  document.addEventListener("tbr:loaded", (e) => {
    console.log(e.detail.status, e.detail.kind, e.detail.source);
  });
</script>
```

### CSS Hooks

Each `.tbr-wrap` element receives lifecycle classes for styling:
`.tbr-requested`, `.tbr-intermediate`, `.tbr-success`, `.tbr-failed`,
`.tbr-overloaded`, `.tbr-unavailable`, `.tbr-offscreen`, `.tbr-loaded`.

## Servers

Works with self-hosted Thumbrella servers and Thumbrella Cloud. Thumbrella
provides a [demo gallery](https://demo.thumbrella.dev) and server for free
evaluation — no account required.

## Next Steps

- **[Client docs](https://thumbrella.dev/docs/client/)** — full API reference
- **[Thumbrella](https://thumbrella.dev)** — main site
- **[GitHub](https://github.com/thumbrella-dev/clients)** — source and issues

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).
