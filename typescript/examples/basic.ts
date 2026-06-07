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
  if (!m) {
    console.error("Thumbnail did not succeed:", result.status);
    process.exit(1);
  }

  // Simple result metadata
  console.log(
    `${m.kind ?? "?"} ${m.fileSize?.toLocaleString() ?? "?"} bytes  ->  ` +
    `${m.thumbnail.length.toLocaleString()} bytes  ${path}`,
  );

  // Inspect thumbnail dimensions from JPEG header
  const bytes = m.thumbnail.bytes;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    // Quick SOF0 scan for dimensions
    let pos = 2;
    while (pos < bytes.length - 1) {
      if (bytes[pos] !== 0xFF) { pos++; continue; }
      const marker = bytes[pos + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        const h = (bytes[pos + 5] << 8) | bytes[pos + 6];
        const w = (bytes[pos + 7] << 8) | bytes[pos + 8];
        console.log(`mode: RGB  width: ${w}  height: ${h}`);
        break;
      }
      pos += 2 + ((bytes[pos + 2] << 8) | bytes[pos + 3]);
    }
  }

  // Write to disk
  writeFileSync(path, bytes);
  console.log(`wrote ${bytes.length} bytes to ${path}`);
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
