#!/usr/bin/env node
/**
 * release-stage.ts - build the canonical, deterministic tbr.js for ONE npm
 * version and stage it for a GitHub release + attestation.
 *
 *   npx tsx scripts/release-stage.ts <version> [--out DIR]
 *
 * The version's npm tarball is downloaded (the SAME source build-cdn.ts uses
 * for its fallback path), then dist/browser.js is bundled with the shared
 * esbuild options from bundle.ts. Writes under DIR (default dist-release/):
 *
 *   DIR/<version>/tbr.js
 *   DIR/<version>/tbr.js.map
 *   DIR/<version>/checksums.txt        sha256 lines for both files
 *
 * bundle.ts is shared and output is minified, so these bytes are deterministic
 * (identical wherever the build runs) and equal what build-cdn.ts stages for
 * the same version. An attestation over these files therefore also covers the
 * file served at https://js.thumbrella.dev/<version>/tbr.js.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE, downloadAndExtractTarball, bundleEntry } from "./bundle.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function usage(): never {
  console.error("usage: npx tsx scripts/release-stage.ts <version> [--out DIR]");
  process.exit(2);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let version: string | undefined;
  let outDir = resolve(root, "dist-release");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      outDir = resolve(argv[++i] ?? "");
      continue;
    }
    if (!a.startsWith("-") && version === undefined) {
      version = a;
      continue;
    }
    usage();
  }
  if (!version) usage();

  const tarballUrl = (await fetch(`https://registry.npmjs.org/${PACKAGE}/${version}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`registry HTTP ${r.status}`)))))
    .dist?.tarball as string | undefined;
  if (!tarballUrl) throw new Error(`no npm tarball found for ${PACKAGE}@${version}`);

  const dir = resolve(outDir, version);
  mkdirSync(dir, { recursive: true });

  const pkgDir = await downloadAndExtractTarball(version, tarballUrl, dir);
  try {
    await bundleEntry(version, join(pkgDir, "dist", "browser.js"), resolve(dir, "tbr.js"));
  } finally {
    rmSync(join(dir, "package"), { recursive: true, force: true });
  }

  const files = ["tbr.js", "tbr.js.map"];
  const sums = files.map((f) => `${sha256(resolve(dir, f))}  ${f}`);
  writeFileSync(resolve(dir, "checksums.txt"), sums.join("\n") + "\n");

  console.log(`staged ${version}/tbr.js (+ .map) [bundled from npm]`);
  for (const line of sums) console.log(`  ${line}`);
  console.log(`ready: upload ${dir}/* to the GitHub release and attest`);
}

await main();
