#!/usr/bin/env node
/**
 * bundle.ts — esbuild bundler for self-contained CDN entry points.
 *
 * Reads the package version, builds a banner, then bundles
 * src/browser.ts → browser.js.
 *
 * element.js is published as a byte-identical copy of browser.js for one
 * release so existing CDN / <script> users of `@thumbrella/client/element.js`
 * have time to migrate.  Remove the copy step in a future release.
 */

import * as esbuild from "esbuild";
import { copyFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const version: string = pkg.version;

const banner = `/*!
 * @thumbrella/client  v${version}
 * Bundled from TypeScript sources — DO NOT EDIT
 * https://github.com/thumbrella-dev/clients/tree/main/typescript
 */
`;

async function bundle(entry: string, outfile: string) {
  await esbuild.build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    banner: { js: banner },
    outfile: resolve(root, outfile),
  });
  console.log(`  ${outfile}`);
}

console.log(`Bundling @thumbrella/client v${version}…`);

await bundle("src/browser.ts", "browser.js");

// Legacy duplicate: element.js ships the same bundle as browser.js so
// users of `@thumbrella/client/element.js` keep working during the
// transition.  Remove this copy in a future release.
copyFileSync(resolve(root, "browser.js"), resolve(root, "element.js"));
console.log("  element.js  (copy of browser.js)");

console.log("Done.");
