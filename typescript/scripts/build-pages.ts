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
 *   public/index.html    landing page (scripts/pages-index.html)
 *   public/404.html      custom 404 page (scripts/pages-404.html)
 *   public/_redirects    floating aliases -> exact versions (302)
 *   public/_headers      CORS on files, no-store on floating aliases
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndExtractTarball, bundleEntry, MIN_VERSION } from "./bundle.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const out = resolve(root, "public");

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

// Download a version's tarball, bundle its dist/browser.js, and stage the
// result as public/<version>/tbr.js (+ .map).  Returns false if the tarball
// has no dist/browser.js.
async function bundleVersion(version: string, tarball: string): Promise<boolean> {
  const dir = resolve(out, version);
  mkdirSync(dir, { recursive: true });

  let ok = false;
  try {
    const pkgDir = await downloadAndExtractTarball(version, tarball, dir);

    const entry = join(pkgDir, "dist", "browser.js");
    if (!existsSync(entry)) {
      console.warn(`  ${version}: no dist/browser.js in tarball; skipping`);
      ok = false;
    } else {
      await bundleEntry(version, entry, resolve(dir, "tbr.js"));
      console.log(`  staged ${version}/tbr.js (+ .map) [bundled from npm]`);
      ok = true;
    }
  } finally {
    rmSync(join(dir, "package"), { recursive: true, force: true });
  }
  return ok;
}

interface Alias {
  path: string;   // e.g. "latest", "1", "1.4"
  target: string; // e.g. "1.4.0"
}

// Floating aliases (latest, each major, each major.minor) -> highest matching
// staged version.
function floatingAliases(staged: SemVer[]): Alias[] {
  const aliases: Alias[] = [];
  const latest = staged[staged.length - 1];
  if (latest) aliases.push({ path: "latest", target: fmt(latest) });

  const majors = new Map<number, SemVer[]>();
  for (const p of staged) {
    const list = majors.get(p[0]) ?? [];
    list.push(p);
    majors.set(p[0], list);
  }
  for (const major of [...majors.keys()].sort((a, b) => a - b)) {
    const list = majors.get(major)!;
    aliases.push({ path: String(major), target: fmt(list[list.length - 1]) });
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
    aliases.push({ path: minor, target: fmt(list[list.length - 1]) });
  }

  return aliases;
}

function redirectLines(aliases: Alias[]): string[] {
  return aliases.map((a) => `/${a.path}/*  /${a.target}/:splat  302`);
}

// CORS set for GET/HEAD resources.  Matches what jsDelivr sends on its files
// (Allow-Origin + Expose-Headers); Allow-Methods/Max-Age are preflight-only
// and module loads never preflight.
const CORS = [
  "  Access-Control-Allow-Origin: *",
  "  Access-Control-Expose-Headers: *",
];

function headersContent(staged: SemVer[], aliases: Alias[]): string {
  const lines = [
    "# Generated by scripts/build-pages.ts -- do not edit by hand.",
    "# Exact versions: CORS + immutable caching.",
    "# Floating aliases: CORS + no-store so the 302s always re-resolve to the",
    "# newest release instead of pinning browsers/edges for a year.",
    "",
  ];

  // Landing page is CORS-accessible but must not be long-cached.
  lines.push("/index.html");
  lines.push("  Access-Control-Allow-Origin: *");
  lines.push("");

  for (const v of staged) {
    const version = fmt(v);
    for (const file of ["tbr.js", "tbr.js.map"]) {
      lines.push(`/${version}/${file}`);
      lines.push(...CORS);
      lines.push("  Cache-Control: public, max-age=31536000, immutable");
      lines.push("");
    }
  }

  for (const a of aliases) {
    lines.push(`/${a.path}/*`);
    lines.push("  Access-Control-Allow-Origin: *");
    lines.push("  Cache-Control: no-store");
    lines.push("");
  }

  return lines.join("\n");
}

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

  const aliases = floatingAliases(staged);
  const redirects = [
    "# Generated by scripts/build-pages.ts -- do not edit by hand.",
    "# Floating aliases -> highest matching staged version (302; targets move on release).",
    ...redirectLines(aliases),
    "",
  ].join("\n");
  writeFileSync(resolve(out, "_redirects"), redirects);
  writeFileSync(resolve(out, "_headers"), headersContent(staged, aliases));
  writeFileSync(
    resolve(out, "index.html"),
    readFileSync(resolve(root, "scripts", "pages-index.html"), "utf-8"),
  );
  writeFileSync(
    resolve(out, "404.html"),
    readFileSync(resolve(root, "scripts", "pages-404.html"), "utf-8"),
  );

  console.log(`  staged ${staged.length} versions (${skipped} skipped)`);
  console.log("  wrote _redirects + _headers + index.html + 404.html");
  console.log("Ready: wrangler pages deploy public --project-name thumbrella-js");
}

await main();
