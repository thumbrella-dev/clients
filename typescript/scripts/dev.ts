#!/usr/bin/env node
/**
 * dev.ts - local development loop for the browser client.
 *
 *   npm run dev
 *
 * Builds the working tree's `dist/browser.js` into `dev/tbr.js` (the same
 * esbuild options and banner the CDN release uses), then serves the package
 * directory over HTTP with permissive CORS so a page on any origin -- including
 * `file://` (origin `null`) and another localhost port -- can import it.
 *
 * The bundle is rebuilt on start.  Re-run `npm run dev` after changing `src/`,
 * or use `npm run build:dev` when you only need the bundle refreshed.
 *
 * Layout served at http://localhost:3115/ :
 *   /dev/tbr.js            the dev bundle S3Feather imports
 *   /examples/browser.html interactive streaming demo
 *   /dist/...              raw compiled modules
 *
 * Port defaults to 3115; override with TBR_DEV_PORT.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDevBundle } from "./bundle-dev.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const port = Number(process.env.TBR_DEV_PORT ?? 3115);

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function main(): Promise<void> {
  // tsc + esbuild on every start. The dev loop should never serve a bundle
  // that is older than the source tree.
  await buildDevBundle();
  console.log(`bundled dev/tbr.js from dist/browser.js`);

  createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = resolve(root, "." + normalize(path).replace(/^([/\\])+/, sep));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      file = join(file, "index.html");
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(res);
  }).listen(port, () => {
    console.log(`serving ${root}`);
    console.log(`  http://localhost:${port}/dev/tbr.js`);
    console.log(`  http://localhost:${port}/examples/browser.html`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
