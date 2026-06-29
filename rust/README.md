# thumbrella

Rust client for [Thumbrella](https://thumbrella.dev) — a thumbnail API that
handles images, video, documents, vector graphics, 3D models, and more.

[![Crates.io](https://img.shields.io/crates/v/thumbrella)](https://crates.io/crates/thumbrella)
[![docs.rs](https://img.shields.io/docsrs/thumbrella)](https://docs.rs/thumbrella)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](../../LICENSE)

Thumbrella servers can be self-hosted or used as Thumbrella Cloud. This crate
wraps the HTTP API with typed results, streaming NDJSON batches, pluggable
caching, and a connect-string system that works the same way across local dev,
CI, and production.

Async-first with `reqwest` (rustls). An optional `blocking` feature provides a
sync wrapper. Minimal dependency tree.

## Install

```bash
cargo add thumbrella
```

For the blocking wrapper:

```bash
cargo add thumbrella --features blocking
```

## Quick Start

```rust
use thumbrella::Client;

#[tokio::main]
async fn main() -> Result<(), thumbrella::Error> {
    // Client::new() reads $TBR_CONNECT from the environment.
    // verify() checks the server is reachable and auth is valid.
    let tbr = Client::new(None);
    tbr.verify().await?;

    // Single URL — returns a ResultData with the thumbnail JPEG.
    let result = tbr.thumb("https://example.com/photo.jpg").await?;
    if let Some(media) = &result.media {
        println!("{} bytes  {}", media.thumbnail.len(), media.kind);
        std::fs::write("thumb.jpg", media.thumbnail.bytes())?;
    }

    // Batch many URLs at once.
    let results = tbr.batch(&[
        "https://example.com/a.jpg",
        "https://example.com/b.png",
    ]).await?;
    for r in &results {
        println!("{}  {}", r.url, r.status);
    }

    // Stream results as the server finishes each thumbnail.
    let results = tbr.stream(&[
        "https://example.com/a.jpg",
        "https://example.com/b.png",
    ]).await?;
    for r in &results {
        println!("{}  {}", r.url, r.status);
    }

    Ok(())
}
```

### Blocking API

```rust
use thumbrella::blocking::BlockingClient;

fn main() -> Result<(), thumbrella::Error> {
    let tbr = BlockingClient::new(None);
    tbr.verify()?;
    let result = tbr.thumb("https://example.com/photo.jpg")?;
    println!("{} bytes", result.media.unwrap().thumbnail.len());
    Ok(())
}
```

## How It Works

Create a `Client` with server configuration and optional caches. Call `verify()`
to confirm connectivity. Then use `thumb()`, `batch()`, or `stream()` to
generate thumbnails.

Every URL gets a `ResultData` — even failures produce a result with a
placeholder image and an error message. Per-result failures are returned as
`Err(Error::Thumb { ... })` rather than panicking.

### Connect Strings

The client reads `$TBR_CONNECT` by default. Pass `Some("...")` to override:

```rust
// Local dev server (no auth)
Client::new(Some("http://localhost:3114"));

// Cloud service with auth token
Client::new(Some("https://cloud.thumbrella.dev,tbr_e_oQftPlhB6ulGkdu5lILXKZBM"));

// Custom server with handshake value
Client::new(Some("https://my-server.example.com,my-handshake"));

// Custom HTTP headers
Client::new(Some("https://api.example.com,Authorization=Bearer tok,x-custom=val"));
```

### ResultData

```rust
result.url              // String — the requested URL
result.status           // String — "SUCCESS" | "FAILED" | "OVERLOADED" | "INTERMEDIATE" | ...
result.source           // Option<String> — "RENDER" | "CACHE" | "FALLBACK" | "PLACEHOLDER" | ...
result.media            // Option<Media> — None when thumbnail could not be generated
result.duration         // Option<f64> — server processing time (ms)
result.message          // Option<String> — error or informational message
```

### Media

```rust
media.url               // String — the original media URL
media.mime              // Option<String> — "image/jpeg" | ...
media.kind              // String — "image" | "video" | "document" | "vector" | "geometry" | ...
media.file_size         // u64 — original file size in bytes
media.thumbnail         // Thumbnail — the thumbnail JPEG bytes
```

### Thumbnail

```rust
thumbnail.bytes()       // &[u8] — JPEG bytes
thumbnail.len()         // usize — byte count
thumbnail.key()         // String — content hash, useful for deduplication
```

### Errors

```rust
use thumbrella::Error;

Error::Connection(String)       // network errors, throttling
Error::Timeout                  // request exceeded timeout
Error::Verify(String)           // bad config or unreachable server
Error::Thumb { url, status, msg }   // per-URL failure
Error::Http(u16, String)        // unexpected HTTP status
```

`verify()` on a Client returns `Err(Error::Verify(...))` for bad config or
unreachable servers. Per-result failures return `Err(Error::Thumb { ... })`.

## Caching

Each `Client` defaults to an in-memory LRU cache (256 entries). Pass custom
caches to persist thumbnails across restarts or share them between clients:

```rust
use thumbrella::{Client, Cache, MemoryCache};

// Default memory cache
Client::new(None);

// No caching
Client::with_caches(None, vec![]);

// Custom cache backend
struct MyCache { /* ... */ }
impl Cache for MyCache {
    fn get(&self, url: &str) -> Option<Media> { /* check persistent store */ }
    fn set(&self, media: &Media) { /* write to persistent store */ }
    fn reset(&self) { /* clear */ }
}

// Multiple layers — checked in order, first hit wins
Client::with_caches(
    None,
    vec![Box::new(MyCache::new()), Box::new(MemoryCache::default())],
);
```

## Features

| Feature     | Description                          | Default |
|-------------|--------------------------------------|---------|
| (default)   | Async client with reqwest (rustls)   | Yes     |
| `blocking`  | Sync `BlockingClient` wrapper        | No      |

## Examples

```bash
# Download one thumbnail to disk
cargo run --example basic https://demo.thumbrella.dev/media/stanford-bunny.stl model.jpg

# Stream batch
cargo run --example stream https://example.com/a.jpg https://example.com/b.png
```

See [`examples/`](./examples) for full source.

## Where To Go Next

- [Full client documentation](https://thumbrella.dev/docs/client/)
- [Thumbrella main site](https://thumbrella.dev)
- [Rust API reference (docs.rs)](https://docs.rs/thumbrella)
- [GitHub repository](https://github.com/thumbrella-dev/clients)

## License

Apache-2.0. See [LICENSE](./LICENSE).
