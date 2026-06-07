/**
 * basic.ts - download one thumbnail to a file.
 *
 * Usage:
 *   npx tsx basic.ts https://www.python.org/static/img/python-logo.png thumb.jpg
 */

import { writeFileSync } from "node:fs";
import { Client } from "../src/index.js";

async function thumbnail(url: string, path: string): Promise<void> {
  const tbr = await new Client().verify();
  const result = await tbr.thumb(url);

  const m = result.media;
  writeFileSync(path, m?.thumbnail.bytes ?? new Uint8Array(0));
  console.log(
    `${m?.kind ?? "?"}  ` +
      `${m?.fileSize?.toLocaleString() ?? "?"} bytes  ->  ` +
      `${m?.thumbnail.length.toLocaleString() ?? "0"} bytes  ` +
      `(${result.source ?? "render"})  ` +
      `${path}`,
  );
}

async function main(): Promise<void> {
  const [url, path] = process.argv.slice(2);
  if (!url || !path) {
    console.error("usage: npx tsx basic.ts <url> <out.jpg>");
    process.exit(2);
  }
  await thumbnail(url, path);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
