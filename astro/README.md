# @thumbrella/astro

Astro components for [Thumbrella](https://thumbrella.dev) — a thumbnail API
that handles images, video, documents, 3D models, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/astro)](https://www.npmjs.com/package/@thumbrella/astro)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)

Built on `@thumbrella/client`.  Provides two components:

- **`<Thumbnail>`** — drop-in `<img>` replacement.  Always renders an image,
  even if the server is unreachable or the media URL is invalid.  Longer
  renders show a temporary placeholder until the final thumbnail arrives.
- **`<Thumbrella>`** — scoped coordinator.  Group `<Thumbnail>` components
  inside it and they share configuration, batch their requests into a single
  streaming call, and reuse identical placeholder images.

## Install

```bash
npm install @thumbrella/astro
```

## Usage

```astro
---
import { Thumbnail, Thumbrella } from "@thumbrella/astro";
---

<Thumbrella connect="https://demo.thumbrella.dev">
  <Thumbnail src="https://demo.thumbrella.dev/media/apollo-exterior.glb" />
  <Thumbnail src="https://demo.thumbrella.dev/media/raw-pentax.pef" />
</Thumbrella>
```

Thumbnails live inside a `<Thumbrella>` wrapper — they don't need to be
immediate children.  Any `<Thumbnail>` anywhere in the subtree is discovered,
deduplicated by URL, and loaded through a single `stream()` call.  New
thumbnails added dynamically (SPA navigation, infinite scroll) are picked up
automatically.

### Connect strings

```astro
<!-- Public demo server (no auth needed) -->
<Thumbrella connect="https://demo.thumbrella.dev">

<!-- Self-hosted server with an auth token -->
<Thumbrella connect="tbr_e_YOURKEY">
```

**Important:** Thumbnail components load client-side in the browser.  Any
server address or key placed in the `connect` attribute will be visible to
end users.  Use publishable keys (`tbr_p_` / `tbr_e_`) which can be scoped
to specific domains and usage quotas.

### Lazy loading

```astro
<!-- Only load thumbnails as they scroll into view -->
<Thumbrella connect="..." lazyLoad>

<!-- Override per element -->
<Thumbnail src="..." lazyLoad={false} />
```

### Events

Each thumbnail fires a `tbr:loaded` event when it finishes loading.  Use it
to build custom badges, overlays, or status indicators:

```js
document.addEventListener("tbr:loaded", (e) => {
  // e.detail = { url, status, source, kind, duration, message, bytes, placeholder }
  const badge = document.createElement("div");
  badge.textContent = e.detail.source || e.detail.status;
  e.target.appendChild(badge);
});
```

### CSS hooks

The `.tbr-wrap` element on each thumbnail receives lifecycle classes for
styling: `tbr-requested`, `tbr-intermediate`, `tbr-success`, `tbr-failed`,
`tbr-overloaded`, `tbr-unavailable`, `tbr-offscreen`.

## How it works

1. `<Thumbnail>` renders two `<img>` elements — a placeholder that shows
   immediately, and a final image that fades in when the server responds.
2. `<Thumbrella>` injects a script that creates a `Client`, scans its DOM
   scope, and calls `stream()` to batch-load all URLs.
3. As results arrive each `<img>` gets its `src` replaced with the real JPEG.
   Intermediate results fill the placeholder slot so something is visible
   while the server works.
4. A `MutationObserver` picks up thumbnails added after the initial load.
5. Identical placeholder images share a single blob URL — the browser
   decodes them once.

## Demo

```bash
npm run demo
```

Loads `https://demo.thumbrella.dev/index.json` and renders a filterable grid
of all available media through the components.

## License

Apache-2.0. See [LICENSE](./LICENSE).
