/**
 * check.ts - pretty-print Thumbrella results for one or more URLs.
 *
 * Usage:
 *   npx tsx scripts/check.ts <url> [url ...]
 */

import { Client, Result } from "../src/index.js";

//  ANSI helpers (zero dependencies)

const B = "\x1b[1m";
const U = "\x1b[4m";
const R = "\x1b[0m";
const NUL = "\u2205";

function bold(s: string): string {
  const tty = process.stdout.isTTY;
  return tty ? `${B}${s}${R}` : s;
}

function uline(s: string): string {
  const tty = process.stdout.isTTY;
  return tty ? `${U}${s}${R}` : s;
}

function bnul(s: string): string {
  return bold(s || NUL);
}

//  Format helpers

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(s: number): string {
  if (s < 0.001) return `${(s * 1_000_000).toFixed(0)} us`;
  if (s < 1) return `${(s * 1000).toFixed(1)} ms`;
  return `${s.toFixed(2)} s`;
}

function fmtAge(secs: number): string {
  if (secs <= 0) return "expired";
  if (secs < 60) return `(${Math.round(secs)} seconds)`;
  if (secs < 3600) return `(${Math.round(secs / 60)} minutes)`;
  if (secs < 86400) return `(${Math.round(secs / 3600)} hours)`;
  return `(${Math.round(secs / 86400)} days)`;
}

/** Render `key=bold(value)` - empty values show the null symbol. */
function kv(key: string, value: string): string {
  return `${key}=${bnul(value)}`;
}

/**
 * Parse the cache token "<hex_epoch>:..." and return human-readable freshness.
 * Returns null if the cache string is empty or unparseable.
 */
function parseCache(cache: string): string | null {
  if (!cache) return null;
  const colon = cache.indexOf(":");
  if (colon < 0) return null;
  const epoch = parseInt(cache.slice(0, colon), 16);
  if (isNaN(epoch) || epoch <= 0) return null;
  const remaining = epoch - Date.now() / 1000;
  return fmtAge(remaining);
}

//  Print

function printResult(r: Result): void {
  console.log(uline(r.url));

  // Top-level result fields
  const resultLine = [
    kv("status", r.status),
    r.source ? kv("source", r.source) : null,
    kv("duration", fmtDuration(r.duration)),
    kv("download_size", fmtBytes(r.downloadSize)),
  ].filter(Boolean).join("  ");
  console.log(`  ${resultLine}`);

  if (r.httpStatus != null || r.message) {
    const parts = [
      r.httpStatus != null ? kv("http_status", String(r.httpStatus)) : null,
      r.message ? kv("message", r.message) : null,
    ].filter(Boolean).join("  ");
    console.log(`  ${parts}`);
  }

  const m = r.media;
  if (m) {
    const mediaLine = [
      kv("kind", m.kind),
      kv("extension", m.extension),
      kv("mime", m.mime),
      kv("file_size", fmtBytes(m.fileSize)),
      kv("placeholder", m.placeholder),
    ].join("  ");
    console.log(`  ${mediaLine}`);

    const props = m.properties;
    if (props && Object.keys(props).length > 0) {
      const propEntries = Object.entries(props)
        .map(([k, v]) => kv(k, JSON.stringify(v)))
        .join("  ");
      console.log(`  ${bold("properties:")} ${propEntries}`);
    }

    const thumbStr = kv("thumbnail", fmtBytes(m.thumbnail.length));
    const cacheStr = kv("cache", m.cache);
    const age = parseCache(m.cache);
    const cacheExtra = age ? `  ${age}` : "";
    console.log(`  ${thumbStr}  ${cacheStr}${cacheExtra}`);
  } else {
    console.log(`  ${kv("media", "")}`);
  }

  console.log();
}

async function main(): Promise<void> {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error("usage: npx tsx scripts/check.ts <url> [url ...]");
    process.exit(2);
  }

  const tbr = await new Client().verify();
  const results = await tbr.batch(urls);
  for (const r of results) {
    printResult(r);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
