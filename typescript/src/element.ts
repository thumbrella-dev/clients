/**
 * element.ts — DEPRECATED entry point.
 *
 * The `<tbr-thumb>` custom element has been merged into `browser.ts`.
 * This module now just re-exports the browser entry so existing imports of
 * `@thumbrella/client/element` (and `./element.js`) keep working during the
 * transition.
 *
 * @deprecated Import from `@thumbrella/client/browser` (or `./browser.js`)
 * instead.  The `element` entry will be removed in a future release.
 */
export * from "./browser.js";
