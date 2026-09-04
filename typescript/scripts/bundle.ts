/**
 * bundle.ts - shared browser-bundle construction for @thumbrella/client.
 *
 * Single source of truth for the esbuild options (and version banner) that
 * produce tbr.js. Used by BOTH:
 *   - scripts/release-stage.ts (GitHub release + attestation staging)
 *   - scripts/build-cdn.ts      (js.thumbrella.dev fallback build)
 *
 * Determinism contract: output is MINIFIED (no CWD- or path-dependent
 * comments) and the esbuild version is pinned EXACTLY in package.json, so the
 * same npm tarball plus these options yields byte-identical tbr.js / tbr.js.map
 * regardless of where the build runs. Keep this module free of timestamps,
 * absolute paths, or any environment-dependent content.
 */

import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE = "@thumbrella/client";
// First version that shipped dist/browser.js (the entry we bundle).
export const MIN_VERSION = "1.2.0";

export function banner(version: string): string {
  return [
    "/*!",
    ` * ${PACKAGE}  v${version}`,
    " * Browser bundle -- DO NOT EDIT",
    " * https://github.com/thumbrella-dev/clients/tree/main/typescript",
    " */",
    "",
  ].join("\n");
}

// esbuild options shared by every tbr.js consumer. `entryPoints` and `outfile`
// are supplied by the caller; everything that affects output bytes lives here.
// `minify` is essential for reproducibility: unminified bundles embed
// CWD-relative `// <path>` comments that break byte-identity across runners.
export function esbuildOptions(version: string): esbuild.BuildOptions {
  return {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: true, // external: writes <outfile>.map next to the bundle
    banner: { js: banner(version) },
  };
}

// Bundle one entry file with the shared options. Writes <outfile> and (because
// sourcemap is external) <outfile>.map.
export async function bundleEntry(
  version: string,
  entryPoint: string,
  outfile: string,
): Promise<void> {
  await esbuild.build({
    ...esbuildOptions(version),
    entryPoints: [entryPoint],
    outfile,
  });
}

// Download a version's npm tarball and extract it into <intoDir>/package.
// Resolves to the absolute path of the extracted `package/` directory.
//
// Extraction happens INSIDE the staging dir (not a random tmp dir) so the
// relative path esbuild embeds in tbr.js.map sources is constant no matter
// where the staging dir lives. That keeps the whole output (bundle + map)
// byte-identical between the CDN rebuild and the release/attest build.
export async function downloadAndExtractTarball(
  version: string,
  tarball: string,
  intoDir: string,
): Promise<string> {
  const pkgDir = join(intoDir, "package");
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  const tarballPath = join(pkgDir, "pkg.tgz");
  try {
    const res = await fetch(tarball);
    if (!res.ok) {
      throw new Error(`tarball fetch failed for ${version}: HTTP ${res.status}`);
    }
    writeFileSync(tarballPath, new Uint8Array(await res.arrayBuffer()));

    const tar = spawnSync("tar", ["-xzf", tarballPath, "-C", pkgDir], {
      encoding: "utf-8",
    });
    if (tar.status !== 0) {
      throw new Error(`tar extraction failed for ${version}: ${tar.stderr?.trim()}`);
    }
    return join(pkgDir, "package");
  } catch (e) {
    rmSync(pkgDir, { recursive: true, force: true });
    throw e;
  }
}
