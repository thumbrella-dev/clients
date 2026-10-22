/**
 * element.ts — compatibility re-export.
 *
 * The `<tbr-thumb>` custom element lives in `browser.ts`.  This module remains
 * for source-level imports of `./element.js`; it is not a published package
 * entry point (see the `exports` map in package.json).
 *
 * @deprecated Import from `./browser.js` instead.
 */
export * from "./browser.js";
