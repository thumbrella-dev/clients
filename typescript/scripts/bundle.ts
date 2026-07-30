#!/usr/bin/env node
/**
 * bundle.ts — esbuild bundler for self-contained CDN entry points.
 *
 * Reads the package version, builds a banner, then bundles
 * src/element.ts → element.js  and  src/browser.ts → browser.js.
 */

import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";
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
await bundle("src/element.ts", "element.js");
await bundle("src/browser.ts", "browser.js");
console.log("Done.");
