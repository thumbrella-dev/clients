/**
 * file-share.ts — thumbnail a local file using the public Thumbrella cloud.
 *
 * Two modes (controlled by the --tunnel flag):
 *
 *   Upload (default): upload to a public host, then thumbnail.
 *     npx tsx examples/file-share.ts ./input.pdf out.jpg
 *
 *   Tunnel (--tunnel): serve the file from your machine through a tunnel.
 *     No middleman.  Supports HTTP range requests — Thumbrella only fetches
 *     the bytes it needs (great for large video files).
 *     npm install localtunnel
 *     npx tsx examples/file-share.ts --tunnel ./video.mp4 out.jpg
 *
 * Requires Node.js 18+ (native fetch + FormData) and tsx.
 */

import { readFileSync, writeFileSync, statSync, createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Client } from "../src/index.js";

// ── upload mode ─────────────────────────────────────────────────────────
//
// 0x0.st is a free, zero-auth file host.  One POST with FormData and you
// get back a plain-text URL.  Swap this out for any service you prefer
// (transfer.sh, file.io, your own S3 presigned URL, etc.).

const FILE_HOST = "https://0x0.st";

async function upload(filePath: string): Promise<string> {
  const bytes = readFileSync(filePath);
  const name = basename(filePath);

  const form = new FormData();
  form.append("file", new Blob([bytes]), name);

  const resp = await fetch(FILE_HOST, { method: "POST", body: form });
  if (!resp.ok) throw new Error(`Upload failed: HTTP ${resp.status}`);

  const url = (await resp.text()).trim();
  if (!url.startsWith("http")) throw new Error(`Unexpected response: ${url}`);
  return url;
}

// ── tunnel mode ─────────────────────────────────────────────────────────
//
// Instead of uploading the file somewhere, we serve it from localhost and
// open a public tunnel.  Thumbrella makes HTTP range requests against the
// tunnel URL, so only the first few MB of a large file are transferred.

/** Minimal HTTP file server with Range support and path-based access control. */
function serveFile(filePath: string, port: number, secret: string): Server {
  const stats = statSync(filePath);
  const prefix = `/${secret}/`;

  return createServer((req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
    if (!(req.url ?? "/").startsWith(prefix)) {
      await new Promise((r) => setTimeout(r, 7));
      res.writeHead(403);
      res.end();
      return;
    }
    const range = req.headers.range ?? "";
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (!match) { res.writeHead(416); res.end(); return; }
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : stats.size - 1;
      if (start >= stats.size || end >= stats.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
        res.end();
        return;
      }
      const len = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stats.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(len),
        "Content-Type": "application/octet-stream",
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": String(stats.size),
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
      });
      createReadStream(filePath).pipe(res);
    }
    })();
  }).listen(port, "127.0.0.1");
}

// ── thumbnail + save (shared) ───────────────────────────────────────────

async function thumbnailAndSave(publicUrl: string, outputAbs: string): Promise<void> {
  const tbr = await new Client().verify();
  const result = await tbr.thumb(publicUrl);

  if (!result.isSuccess() || !result.media) {
    throw new Error(
      `Thumbnail failed: status=${result.status}  ${result.message ?? ""}`,
    );
  }

  writeFileSync(outputAbs, result.media.thumbnail.bytes);
  console.error(`Wrote ${result.media.thumbnail.length.toLocaleString()} bytes → ${outputAbs}`);
  console.error(
    `  source : ${result.source ?? "?"}  ` +
    `kind: ${result.media.kind ?? "?"}  ` +
    `(${result.media.fileSize?.toLocaleString() ?? "?"} bytes original)`,
  );
  console.error(`  time   : ${result.duration?.toFixed(0) ?? "?"} ms`);
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let useTunnel = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--tunnel") useTunnel = true;
    else if (!a.startsWith("-")) positional.push(a);
  }

  if (positional.length < 2) {
    console.error("usage: npx tsx examples/file-share.ts [--tunnel] <input-file> <output.jpg>");
    process.exit(2);
  }

  const [inputPath, outputPath] = positional;
  const inputAbs = resolve(inputPath);
  const outputAbs = resolve(outputPath);
  const fileName = basename(inputAbs);
  const fileBytes = readFileSync(inputAbs);
  const kb = (fileBytes.length / 1024).toFixed(1);

  if (useTunnel) {
    // ── tunnel mode ──────────────────────────────────────────────────
    const secret = randomBytes(12).toString("base64url");
    const server = serveFile(inputAbs, 0, secret);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Could not start server");
    const port = addr.port;
    console.error(`Serving ${fileName} (${kb} KB) on 127.0.0.1:${port}`);

    const { default: localtunnel } = await import("localtunnel");
    const tunnel = await localtunnel({ port });
    const fileUrl = `${tunnel.url}/${secret}/${fileName}`;
    console.error(`Tunnel URL: ${fileUrl}`);

    try {
      await thumbnailAndSave(fileUrl, outputAbs);
    } finally {
      tunnel.close();
      server.close();
    }
  } else {
    // ── upload mode ──────────────────────────────────────────────────
    console.error(`Uploading ${fileName} (${kb} KB) …`);
    const publicUrl = await upload(inputAbs);
    console.error(`Public URL: ${publicUrl}`);
    await thumbnailAndSave(publicUrl, outputAbs);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

