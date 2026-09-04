#!/usr/bin/env node
/**
 * build-cdn.ts - stages the js.thumbrella.dev CDN directory.
 *
 * Stateless: public/ is wiped first, then reconstructed on every deploy. For
 * each published npm version >= MIN_VERSION, in ascending order, the source is
 * chosen so that the staged bytes are exactly what should be served:
 *
 *   1. canonical   - version has a GitHub release "client-js-v<version>":
 *                    download the RELEASED tbr.js / tbr.js.map (the attested
 *                    bytes produced by scripts/release-stage.ts). Never rebuilt.
 *   2. frozen      - no release yet but already live on the CDN (legacy
 *                    1.2.0-1.4.0): copy the CURRENT served bytes unchanged so
 *                    immutable-cached files never change.
 *   3. fallback    - neither (fresh publish racing its release): deterministic
 *                    minified build from the npm tarball via bundle.ts, which
 *                    is byte-identical to what the release will contain.
 *
 * Produced layout (same as before):
 *   public/<version>/tbr.js
 *   public/<version>/tbr.js.map
 *   public/index.html    landing page (scripts/pages-index.html)
 *   public/404.html      custom 404 page (scripts/pages-404.html)
 *   public/_redirects    floating aliases -> exact versions (302)
 *   public/_headers      CORS on files, no-store on floating aliases
 *   public/_attested.json  (only when >=1 canonical version is staged)
 *
 * Requires network access to the npm registry, GitHub, and js.thumbrella.dev.
 * Set GITHUB_TOKEN to avoid GitHub API rate limits (pages-cdn.yaml provides it).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE,
  MIN_VERSION,
  downloadAndExtractTarball,
  bundleEntry,
} from "./bundle.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const out = resolve(root, "public");

const REPO = process.env.GITHUB_REPOSITORY ?? "thumbrella-dev/clients";
const CDN_BASE = process.env.CDN_BASE ?? "https://js.thumbrella.dev";
const RELEASE_TAG_PREFIX = "client-js-v";
const GH_TOKEN = process.env.GITHUB_TOKEN;

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

async function fetchBytes(url: string): Promise<Buffer | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch failed for ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

// Return the assets of release tag "client-js-v<version>", or null if the tag
// (and therefore the canonical release) does not exist.
async function releaseAssets(version: string): Promise<ReleaseAsset[] | null> {
  const tag = `${RELEASE_TAG_PREFIX}${version}`;
  const url = `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "thumbrella-build-cdn",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub release lookup failed for ${tag}: HTTP ${res.status}`);
  const data = (await res.json()) as { assets?: ReleaseAsset[] };
  return data.assets ?? [];
}

type StageSource = "release" | "cdn" | "build";

// Resolve one version into staged bytes in public/<version>/. Returns the
// source that produced it, or null if the version cannot be served.
async function stageVersion(info: PublishInfo): Promise<StageSource | null> {
  const { version, tarball } = info;
  const dir = resolve(out, version);
  mkdirSync(dir, { recursive: true });

  // 1. Canonical: released (and attested) assets win.
  const assets = await releaseAssets(version);
  if (assets) {
    const want = new Map<string, ReleaseAsset>();
    for (const a of assets) if (a.name === "tbr.js" || a.name === "tbr.js.map") want.set(a.name, a);
    if (want.has("tbr.js") && want.has("tbr.js.map")) {
      for (const name of ["tbr.js", "tbr.js.map"]) {
        const buf = await fetchBytes(want.get(name)!.browser_download_url);
        if (!buf) throw new Error(`release asset missing for ${version}: ${name}`);
        writeFileSync(resolve(dir, name), buf);
      }
      return "release";
    }
    // Partial/malformed release: fall through to CDN/build rather than guess.
    console.warn(`  ${version}: release missing tbr.js/.map; ignoring`);
  }

  // 2. Frozen: already served on the CDN. Copy the live bytes unchanged so
  //    immutable-cached legacy versions never change.
  const cdnFiles = await Promise.all(
    ["tbr.js", "tbr.js.map"].map((name) =>
      fetchBytes(`${CDN_BASE}/${version}/${name}`),
    ),
  );
  if (cdnFiles.every((b): b is Buffer => b !== null)) {
    for (let i = 0; i < cdnFiles.length; i++) {
      writeFileSync(resolve(dir, ["tbr.js", "tbr.js.map"][i]), cdnFiles[i]!);
    }
    return "cdn";
  }

  // 3. Fallback: deterministic minified build from the npm tarball (byte-
  //    identical to the eventual release build).
  try {
    const pkgDir = await downloadAndExtractTarball(version, tarball, dir);
    try {
      const entry = join(pkgDir, "dist", "browser.js");
      if (!existsSync(entry)) {
        console.warn(`  ${version}: no dist/browser.js in tarball; skipping`);
        return null;
      }
      await bundleEntry(version, entry, resolve(dir, "tbr.js"));
      return "build";
    } finally {
      rmSync(join(dir, "package"), { recursive: true, force: true });
    }
  } catch (e) {
    console.warn(`  ${version}: fallback build failed; skipping (${e})`);
    return null;
  }
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
    "# Generated by scripts/build-cdn.ts -- do not edit by hand.",
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

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
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
  const sources = { release: 0, cdn: 0, build: 0, skipped: 0 };
  const attested: Array<{ version: string; tag: string; sha256: string }> = [];
  for (const info of versions) {
    const p = semver(info.version)!;
    const source = await stageVersion(info);
    if (source === null) {
      sources.skipped += 1;
      continue;
    }
    sources[source] += 1;
    staged.push(p);
    if (source === "release") {
      attested.push({
        version: fmt(p),
        tag: `${RELEASE_TAG_PREFIX}${fmt(p)}`,
        sha256: sha256File(resolve(out, fmt(p), "tbr.js")),
      });
    }
  }

  const aliases = floatingAliases(staged);
  const redirects = [
    "# Generated by scripts/build-cdn.ts -- do not edit by hand.",
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
  if (attested.length > 0) {
    writeFileSync(
      resolve(out, "_attested.json"),
      JSON.stringify({ repo: REPO, files: attested }, null, 2) + "\n",
    );
  }

  console.log(
    `  staged ${staged.length} versions ` +
      `(release=${sources.release}, cdn=${sources.cdn}, build=${sources.build}, skipped=${sources.skipped})`,
  );
  console.log("  wrote _redirects + _headers + index.html + 404.html");
  console.log("Ready: wrangler pages deploy public --project-name thumbrella-js");
}

await main();
