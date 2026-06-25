#!/usr/bin/env node
/**
 * bench.ts — Thumbrella API benchmarking tool
 *
 * Uses the @thumbrella/client library to send batch requests and report timing.
 *
 * Usage:
 *   npx tsx scripts/bench.ts [<connect>] [--batch <size>] [--rounds <n>]
 *                            [--full] [--warmup] [--json] [--label <name>]
 *
 * <connect> is an optional positional connect string (default: $TBR_CONNECT or
 * https://api.thumbrella.dev).  Fetches the demo index to get media URLs, then
 * sends batch requests through the Client.  Verifies the server before starting.
 *
 * --warmup runs one silent pass over all URLs before the timed benchmark, to
 * absorb cold-start latency on scale-to-zero services.
 *
 * --json outputs a single JSON object to stdout at the end (suppresses all
 * other output).  Use with --label to tag runs for cross-provider comparison.
 */

// import { Client, Result, Status, Source } from "@thumbrella/client";
import { Client, Result, Status, Source } from "../src/index.ts";

// ── CLI parsing ──────────────────────────────────────────────────────────

interface Options {
  connect: string;
  batchSize: number;
  rounds: number;
  full: boolean;
  warmup: boolean;
  json: boolean;
  label: string;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    connect: "", batchSize: 5, rounds: 1, full: false,
    warmup: false, json: false, label: "",
  };

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
      case "--warmup":
        opts.warmup = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--label":
        opts.label = args[++i] ?? "";
        break;
      case "--help":
      case "-h":
        console.log(`Usage: bench.ts [<connect>] [--batch <n>] [--rounds <n>] [--full] [--warmup] [--json] [--label <name>]`);
        console.log(`  <connect>   Connect string (default: env TBR_CONNECT or https://api.thumbrella.dev)`);
        console.log(`  --batch     Number of URLs per batch request (default: 5)`);
        console.log(`  --rounds    Number of times to repeat the full set (default: 1)`);
        console.log(`  --full      Print per-item timing using server-reported duration`);
        console.log(`  --warmup    Run one silent pass to absorb cold starts before timing`);
        console.log(`  --json      Output summary as JSON (suppresses text output)`);
        console.log(`  --label     Tag this run for cross-provider comparison`);
        process.exit(0);
    }
  }
  return opts;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const INDEX_URL = "https://demo.thumbrella.dev";

interface IndexEntry {
  name: string;
  size?: number;
  kind?: string;
}

interface DemoIndex {
  generated: string;
  media: string;
  thumb: string;
  data: string;
  files: IndexEntry[];
}

async function fetchIndex(): Promise<{ mediaTemplate: string; files: IndexEntry[] }> {
  const res = await fetch(INDEX_URL + "/index.json");
  if (!res.ok) throw new Error(`Failed to fetch index: ${res.status}`);
  const index = await res.json() as DemoIndex;
  return { mediaTemplate: index.media, files: index.files };
}

// ── Warmup ───────────────────────────────────────────────────────────────

async function warmup(tbr: Client, urls: string[], batchSize: number): Promise<void> {
  if (!opts.warmup) return;
  process.stderr.write("Warming up...");
  const shuffled = [...urls].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i += batchSize) {
    const batch = shuffled.slice(i, i + batchSize);
    await tbr.batch(batch);
    process.stderr.write(".");
  }
  process.stderr.write(" done\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

// Hold a module-level reference so warmup() can access opts.
let opts: Options;

async function main() {
  opts = parseArgs();
  const tbr = new Client(opts.connect ? { connect: opts.connect } : undefined);

  await tbr.verify();

  const { mediaTemplate, files } = await fetchIndex();
  const urls = files.map((f) => mediaTemplate.replace("{{name}}", f.name));

  if (!opts.json) {
    console.log(`Benchmark ${urls.length} media for ${tbr.baseUrl}`);
  }

  // Warmup pass — absorbs cold starts before timed runs.
  await warmup(tbr, urls, opts.batchSize);

  let totalOk = 0;
  let totalFail = 0;
  let totalWallMs = 0;
  let totalDuration = 0;
  let totalItems = 0;

  // Count sources for summary
  const sources: Record<string, number> = {};

  // Per-item detail for JSON output.
  interface ItemDetail {
    name: string;
    status: string;
    duration_ms: number;
    source: string;
  }
  const allItems: ItemDetail[] = [];

  for (let round = 0; round < opts.rounds; round++) {
    if (!opts.json && opts.rounds > 1) {
      console.log(`\n--- Round ${round + 1}/${opts.rounds} ---`);
    }

    const shuffled = [...urls].sort(() => Math.random() - 0.5);

    for (let i = 0; i < shuffled.length; i += opts.batchSize) {
      const batch = shuffled.slice(i, i + opts.batchSize);
      const t0 = performance.now();
      const results: Result[] = await tbr.batch(batch);
      const elapsed = performance.now() - t0;

      let ok = 0, fail = 0;
      for (const r of results) {
        const name = r.url.split("/").pop() ?? "?";
        const durMs = r.duration * 1000;
        const statusLabel = r.status === Status.SUCCESS ? "OK" : r.status.toUpperCase();
        const src = r.source ?? "-";

        allItems.push({
          name,
          status: r.status,
          duration_ms: Math.round(durMs * 10) / 10,
          source: r.source ?? "unknown",
        });

        if (!opts.json && opts.full) {
          console.log(`  ${statusLabel.padEnd(12)} ${durMs.toFixed(1).padStart(7)}ms  ${src.padEnd(10)} ${name}`);
        }
        if (r.status === Status.SUCCESS) {
          ok++;
          const srcKey = r.source ?? "unknown";
          sources[srcKey] = (sources[srcKey] ?? 0) + 1;
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

      if (!opts.json && !opts.full) {
        const avg = (elapsed / batch.length).toFixed(0);
        const first = batch[0].split("/").pop() ?? "?";
        const line = `  batch ${Math.floor(i / opts.batchSize) + 1}: ${ok} ok ${fail} fail  ${elapsed.toFixed(0)}ms (${avg}ms/item)  [${first}]`;
        process.stdout.write(line + "  \r");
      }
    }
    if (!opts.json) process.stdout.write("\n");
  }

  if (opts.json) {
    const summary = {
      label: opts.label || undefined,
      base_url: tbr.baseUrl,
      timestamp: new Date().toISOString(),
      rounds: opts.rounds,
      warmup: opts.warmup,
      total_items: totalItems,
      total_ok: totalOk,
      total_fail: totalFail,
      wall_sec: Math.round(totalWallMs / 10) / 100,
      server_sec: Math.round(totalDuration * 10) / 10,
      avg_ms: Math.round((totalDuration * 1000) / totalItems * 10) / 10,
      sources,
      items: allItems,
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
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
