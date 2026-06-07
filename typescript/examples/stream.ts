/**
 * stream.ts - show progress on async thumbnail rendering.
 *
 * Usage:
 *   npx tsx stream.ts https://www.python.org/static/img/python-logo.png https://www.pygame.org/docs/_images/pygame_powered.png https://pypi.org/unknown.jpg
 */

import { Client, type Result } from "../src/index.js";

function index(urls: string[]): Map<string, string> {
  const indices = new Map<string, string>();
  urls.forEach((u, i) => {
    const label = String(i + 1).padStart(3, "0");
    indices.set(u, label);
    console.log(`${label}: ${u}`);
  });
  return indices;
}

function report(start: number, idx: string, result: Result): void {
  const media = result.media;
  const kind = media
    ? `${media.kind}(${media.extension})`
    : "<nomedia>";
  console.log(
    `${((Date.now() - start)).toLocaleString()}ms ${idx}` +
    ` - ${result.status} ${kind} ${result.source ?? ""} ${result.message ?? ""}`,
  );
}

async function streamed(urls: string[]): Promise<void> {
  const tbr = await new Client().verify();
  const indices = index(urls);
  const start = Date.now();

  for await (const result of tbr.stream(urls)) {
    report(start, indices.get(result.url) ?? "XXX", result);
  }
}

async function batched(urls: string[]): Promise<void> {
  const tbr = await new Client().verify();
  const indices = index(urls);
  const start = Date.now();

  const results = await tbr.batch(urls);
  for (const result of results) {
    report(start, indices.get(result.url) ?? "XXX", result);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const batchFlag = args.includes("--batch");
  const urls = args.filter((a) => a !== "--batch");

  if (urls.length === 0) {
    console.error("usage: npx tsx stream.ts [--batch] <url> [url...]");
    process.exit(2);
  }

  if (batchFlag) {
    await batched(urls);
  } else {
    await streamed(urls);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
