/**
 * basic.ts - download one thumbnail to a file.
 *
 * Usage:
 *   npm install @thumbrella/client
 *   npx tsx basic.ts https://www.python.org/static/img/python-logo.png thumb.jpg
 *
 * From the repo source, use:  import { Client } from "../src/index.js";
 */

import { writeFileSync } from "node:fs";

import { Client } from "@thumbrella/client";


async function thumbnail(url: string, path: string): Promise<void> {
  // Client reads TBR_CONNECT env var for server URL or cloud token.
  // verify() ensures the connection is good before proceeding.
  const tbr = await new Client().verify();

  // thumb() auto-verifies — throws on failure instead of returning
  // a placeholder like batch() or stream() would.
  const result = await tbr.thumb(url);

  writeFileSync(path, result.thumbnail.bytes);
  console.log(
    `${result.kind}  ` +
      `${result.fileSize?.toLocaleString() ?? "?"} bytes  ->  ` +
      `${result.thumbnail.length.toLocaleString()} bytes  ` +
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
