#!/usr/bin/env node
/**
 * bundle-dev.ts - build dev/tbr.js from the compiled working tree.
 *
 *   npm run build:dev
 *
 * Runs the TypeScript compiler first, then bundles dist/browser.js with the
 * exact esbuild options the CDN release uses. Kept separate from scripts/dev.ts
 * so rebuilding the bundle does not also start an HTTP server, and separate
 * from `npm run build` so a plain library build does not pay for esbuild.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleEntry } from "./bundle.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

export async function buildDevBundle(): Promise<void> {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    version: string;
  };

  const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (tsc.status !== 0) {
    throw new Error("tsc failed");
  }

  const entry = join(root, "dist", "browser.js");
  if (!existsSync(entry)) {
    throw new Error("dist/browser.js is missing after tsc");
  }

  await bundleEntry(`${pkg.version}-dev`, entry, join(root, "dev", "tbr.js"));
}

// Direct invocation: npm run build:dev
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDevBundle().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
