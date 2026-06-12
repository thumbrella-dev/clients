#!/usr/bin/env node
/**
 * bench.ts — Thumbrella API benchmarking tool
 *
 * Uses the @thumbrella/client library to send batch requests and report timing.
 *
 * Usage:
 *   npx tsx scripts/bench.ts [<connect>] [--batch <size>] [--rounds <n>] [--full]
 *
 * <connect> is an optional positional connect string (default: $TBR_CONNECT or
 * https://api.thumbrella.dev).  Fetches the demo index to get media URLs, then
 * sends batch requests through the Client.  Verifies the server before starting.
 */

// import { Client, Result, Status, Source } from "@thumbrella/client";
import { Client, Result, Status, Source } from "../src/index.ts";

// ── CLI parsing ──────────────────────────────────────────────────────────

interface Options {
  connect: string;
  batchSize: number;
  rounds: number;
  full: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = { connect: "", batchSize: 5, rounds: 1, full: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      opts.connect = arg;
      continue;
    }
    switch (arg) {
      case "--batch":
        opts.batchSize = Math.max(1, parseInt(args[++i] ?? "5", 10) || 5);
        break;
      case "--rounds":
        opts.rounds = Math.max(1, parseInt(args[++i] ?? "1", 10) || 1);
        break;
      case "--full":
        opts.full = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: bench.ts [<connect>] [--batch <n>] [--rounds <n>] [--full]`);
        console.log(`  <connect>   Connect string (default: env TBR_CONNECT or https://api.thumbrella.dev)`);
        console.log(`  --batch     Number of URLs per batch request (default: 5)`);
        console.log(`  --rounds    Number of times to repeat the full set (default: 1)`);
        console.log(`  --full      Print per-item timing using server-reported duration`);
        process.exit(0);
    }
  }
  return opts;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const INDEX_URL = "https://demo.thumbrella.dev";

interface IndexEntry {
  full_url: string;
  name?: string;
}

async function fetchIndex(): Promise<IndexEntry[]> {
  const res = await fetch(INDEX_URL + "/index.json");
  if (!res.ok) throw new Error(`Failed to fetch index: ${res.status}`);
  const index = await res.json() as { files: IndexEntry[] };
  return index.files;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const tbr = new Client(opts.connect ? { connect: opts.connect } : undefined);

  await tbr.verify();

  const files = await fetchIndex();
  const urls = files.map((f) => f.full_url);

  console.log(`Benchmark ${urls.length} media for ${tbr.baseUrl}`);

  let totalOk = 0;
  let totalFail = 0;
  let totalWallMs = 0;
  let totalDuration = 0;
  let totalItems = 0;

  // Count sources for summary
  const sources: Record<string, number> = {};

  for (let round = 0; round < opts.rounds; round++) {
    if (opts.rounds > 1) console.log(`\n--- Round ${round + 1}/${opts.rounds} ---`);

    const shuffled = [...urls].sort(() => Math.random() - 0.5);

    for (let i = 0; i < shuffled.length; i += opts.batchSize) {
      const batch = shuffled.slice(i, i + opts.batchSize);
      const t0 = performance.now();
      const results: Result[] = await tbr.batch(batch);
      const elapsed = performance.now() - t0;

      let ok = 0, fail = 0;
      for (const r of results) {
        if (opts.full) {
          const name = r.url.split("/").pop() ?? "?";
          const durMs = (r.duration * 1000).toFixed(1);
          const status = r.status === Status.SUCCESS ? "OK" : r.status.toUpperCase();
          const src = r.source ?? "-";
          console.log(`  ${status.padEnd(12)} ${durMs.padStart(7)}ms  ${src.padEnd(10)} ${name}`);
        }
        if (r.status === Status.SUCCESS) {
          ok++;
          const src = r.source ?? "unknown";
          sources[src] = (sources[src] ?? 0) + 1;
        } else {
          fail++;
        }
      }

      totalOk += ok;
      totalFail += fail;
      totalWallMs += elapsed;
      totalItems += batch.length;
      for (const r of results) {
        totalDuration += r.duration;
      }

      const avg = (elapsed / batch.length).toFixed(0);
      const first = batch[0].split("/").pop() ?? "?";
      const line = `  batch ${Math.floor(i / opts.batchSize) + 1}: ${ok} ok ${fail} fail  ${elapsed.toFixed(0)}ms (${avg}ms/item)  [${first}]`;
      if (!opts.full) {
        process.stdout.write(line + "  \r");
      }
    }
    process.stdout.write("\n");
  }

  const wallSec = (totalWallMs / 1000).toFixed(1);
  const serverSec = totalDuration.toFixed(1);
  const avgPerItem = ((totalDuration * 1000) / totalItems).toFixed(1);
  const calls = Math.ceil(urls.length / opts.batchSize) * opts.rounds;
  console.log(`\n${tbr.baseUrl}`);
  console.log(`Bench:   ${wallSec}s  |  calls: ${calls}`);
  console.log(`Media:   ${serverSec}s  |  items: ${totalItems}  |  avg: ${avgPerItem}ms`);
  console.log(`Status:  success: ${totalOk}  |  failed: ${totalFail}`);
  const srcList = Object.entries(sources)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join("  |  ");
  console.log(`Source:  ${srcList}`);
  if (opts.rounds > 1) {
    const roundSec = (totalWallMs / opts.rounds / 1000).toFixed(1);
    console.log(`Rounds:  ${opts.rounds}  |  ~${roundSec}s/round`);
  }
}

main().catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
