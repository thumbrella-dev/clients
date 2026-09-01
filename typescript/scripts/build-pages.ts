#!/usr/bin/env node
/**
 * build-pages.ts - stages the browser bundle for every published version
 * into a Cloudflare Pages deployment directory and regenerates _redirects
 * and _headers.
 *
 * Stateless: the staging dir is wiped first, then rebuilt from the npm
 * registry on every deploy.  Every version (including the current one) is
 * treated identically:
 *   1. download the published npm tarball
 *   2. bundle package/dist/browser.js with esbuild -> tbr.js (+ tbr.js.map)
 *   3. stage under public/<version>/
 * No local build and no per-version branching.  Requires `tar` on PATH.
 *
 * Run AFTER the corresponding npm publish so the released version is on the
 * registry.  Produced layout:
 *   public/<version>/tbr.js
 *   public/<version>/tbr.js.map
 *   public/_redirects    floating aliases -> exact versions (302)
 *   public/_headers      CORS + immutable caching for the bundles
 */

import * as esbuild from "esbuild";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const out = resolve(root, "public");

const PACKAGE = "@thumbrella/client";
// First version that shipped dist/browser.js (the entry we bundle).
const MIN_VERSION = "1.2.0";

type SemVer = [number, number, number];

function semver(v: string): SemVer | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: SemVer, b: SemVer): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function gte(a: SemVer, b: SemVer): boolean {
  return compare(a, b) >= 0;
}

function fmt(v: SemVer): string {
  return v.join(".");
}

interface PublishInfo {
  version: string;
  tarball: string;
}

async function publishedVersions(): Promise<PublishInfo[]> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE}`);
  if (!res.ok) throw new Error(`npm registry fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  const infos: PublishInfo[] = [];
  for (const [version, meta] of Object.entries(data.versions ?? {})) {
    if (meta.dist?.tarball) infos.push({ version, tarball: meta.dist.tarball });
  }
  return infos;
}

function banner(version: string): string {
  return [
    "/*!",
    ` * @thumbrella/client  v${version}`,
    " * Browser bundle -- DO NOT EDIT",
    " * https://github.com/thumbrella-dev/clients/tree/main/typescript",
    " */",
    "",
  ].join("\n");
}

// Download a version's tarball, bundle its dist/browser.js, and stage the
// result as public/<version>/tbr.js (+ .map).  Returns false if the tarball
// has no dist/browser.js.
async function bundleVersion(version: string, tarball: string): Promise<boolean> {
  const dir = resolve(out, version);
  mkdirSync(dir, { recursive: true });

  const tmp = join(tmpdir(), `thumbrella-${version}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const res = await fetch(tarball);
    if (!res.ok) throw new Error(`tarball fetch failed for ${version}: HTTP ${res.status}`);
    writeFileSync(join(tmp, "pkg.tgz"), new Uint8Array(await res.arrayBuffer()));

    const tar = spawnSync("tar", ["-xzf", join(tmp, "pkg.tgz"), "-C", tmp], {
      encoding: "utf-8",
    });
    if (tar.status !== 0) {
      throw new Error(`tar extraction failed for ${version}: ${tar.stderr?.trim()}`);
    }

    const entry = join(tmp, "package", "dist", "browser.js");
    if (!existsSync(entry)) {
      console.warn(`  ${version}: no dist/browser.js in tarball; skipping`);
      return false;
    }

    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      sourcemap: true, // external: writes tbr.js.map next to tbr.js
      banner: { js: banner(version) },
      outfile: resolve(dir, "tbr.js"),
    });
    console.log(`  staged ${version}/tbr.js (+ .map) [bundled from npm]`);
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Floating aliases (latest, each major, each major.minor) -> highest matching
// staged version, as _redirects lines.
function redirectLines(staged: SemVer[]): string[] {
  const lines: string[] = [];
  const latest = staged[staged.length - 1];
  if (latest) {
    lines.push(`/latest/*  /${fmt(latest)}/:splat  302`);
  }

  const majors = new Map<number, SemVer[]>();
  for (const p of staged) {
    const list = majors.get(p[0]) ?? [];
    list.push(p);
    majors.set(p[0], list);
  }
  for (const major of [...majors.keys()].sort((a, b) => a - b)) {
    const list = majors.get(major)!;
    lines.push(`/${major}/*  /${fmt(list[list.length - 1])}/:splat  302`);
  }

  const minors = new Map<string, SemVer[]>();
  for (const p of staged) {
    const key = `${p[0]}.${p[1]}`;
    const list = minors.get(key) ?? [];
    list.push(p);
    minors.set(key, list);
  }
  for (const minor of [...minors.keys()].sort()) {
    const list = minors.get(minor)!;
    lines.push(`/${minor}/*  /${fmt(list[list.length - 1])}/:splat  302`);
  }

  return lines;
}

const HEADERS = `# Generated by scripts/build-pages.ts -- do not edit by hand.
# CORS + immutable caching for the packed bundles and their source maps.
/*/tbr.js
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable
/*/tbr.js.map
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable
`;

async function main(): Promise<void> {
  const floor = semver(MIN_VERSION)!;
  const versions = (await publishedVersions())
    .filter(({ version }) => {
      const p = semver(version);
      return p !== null && gte(p, floor);
    })
    .sort((a, b) => compare(semver(a.version)!, semver(b.version)!));

  // Fresh staging dir so the deployment contains exactly the rebuilt set.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const staged: SemVer[] = [];
  let skipped = 0;
  for (const { version, tarball } of versions) {
    const p = semver(version)!;
    if (await bundleVersion(version, tarball)) {
      staged.push(p);
    } else {
      skipped += 1;
    }
  }

  const redirects = [
    "# Generated by scripts/build-pages.ts -- do not edit by hand.",
    "# Floating aliases -> highest matching staged version (302; targets move on release).",
    ...redirectLines(staged),
    "",
  ].join("\n");
  writeFileSync(resolve(out, "_redirects"), redirects);
  writeFileSync(resolve(out, "_headers"), HEADERS);

  console.log(`  staged ${staged.length} versions (${skipped} skipped)`);
  console.log("  wrote _redirects + _headers");
  console.log("Ready: wrangler pages deploy public --project-name thumbrella-js");
}

await main();
