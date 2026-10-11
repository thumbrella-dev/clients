# thumbrella-client

Rust client for [Thumbrella](https://thumbrella.dev), a fast thumbnail server
for images, video, documents, and more.

[![Crates.io](https://img.shields.io/crates/v/thumbrella-client)](https://crates.io/crates/thumbrella-client)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

The [client git repository](https://github.com/thumbrella-dev/clients) also has
packages for other languages and environments. See
[TypeScript](https://www.npmjs.com/package/@thumbrella/client),
[Python](https://pypi.org/project/thumbrella-client/), and more coming soon.

## Features

- Async-first with [reqwest](https://crates.io/crates/reqwest) (rustls TLS)
- Optional `blocking` feature provides a sync wrapper
- Minimal dependency tree; `reqwest`, `serde`, `base64`, `thiserror`
- Single call efficiently processes multiple thumbnails in parallel
- Stream async results as the server renders thumbnails
- Persistent client caching integrates with server and HTTP
- Placeholders for failures, even if disconnected or misconfigured
- Typed results with simple media metadata
- Thumbrella server supports 100+ formats

## Quickstart

The default Thumbrella client provides asyncronous requests.

```bash
cargo add thumbrella-client
```

```rust
use thumbrella_client as thumbrella;

#[tokio::main]
async fn main() -> Result<(), thumbrella::Error> {
    let tbr = thumbrella::Client::new(None);
    tbr.verify().await?;

    let result = tbr.thumb("https://demo.thumbrella.dev/media/game-level.png").await?;
    let media = &result.media;
    println!("{} bytes  {}", media.thumbnail.len(), media.kind);
    std::fs::write("thumb.jpg", media.thumbnail.bytes())?;

    Ok(())
}
```

A feature allows a synchronous interface for simpler or limited environments.

```bash
cargo add thumbrella-client --features blocking
```

```rust
use thumbrella_client as thumbrella;

fn main() -> Result<(), thumbrella::Error> {
    let tbr = thumbrella::blocking::BlockingClient::new(None);
    tbr.verify()?;
    let result = tbr.thumb("https://demo.thumbrella.dev/media/packing-boxes.avi")?;
    println!("{} bytes", result.media.thumbnail.len());
    Ok(())
}
```

## Streaming

`stream()` yields results as the server renders them, including intermediate
results while slower thumbnails are still processing:

```rust
use futures_util::{pin_mut, StreamExt};
use thumbrella_client as thumbrella;

#[tokio::main]
async fn main() -> Result<(), thumbrella::Error> {
    let tbr = thumbrella::Client::new(None);
    tbr.verify().await?;

    let urls = ["https://example.com/a.jpg", "https://example.com/b.png"];
    let stream = tbr.stream(&urls);
    pin_mut!(stream);
    while let Some(result) = stream.next().await {
        println!("{} {}", result.url, result.status);
    }

    Ok(())
}
```

## Result and media

### ResultData

```rust
result.url           // String - the requested URL
result.status        // String - "success" | "failed" | "overloaded" | "intermediate" | ...
result.source        // Option<String> - "render" | "cache" | "fallback" | "placeholder" | ...
result.media         // Media - source metadata and thumbnail, including failure placeholders
result.duration      // f64 - server processing time (ms)
result.download_size // u64 - bytes downloaded while processing
result.http_status   // Option<u16> - source HTTP status, when available
result.message       // Option<String> - error or informational message
result.pin           // Option<String> - absolute URL to fetch the pinned JPEG
result.raw           // serde_json::Value - raw JSON storage; Null unless populated

result.is_success()  // true when status is "success"
result.is_fresh()    // true when the media cache token has not expired
```

The client resolves `pin` against the HTTP request URL. It remains `None` when
pinning is unavailable or an older server omits the field. Unlike the Python
and TypeScript clients, `media` is not optional: missing or null media uses
a default failure placeholder. Use `Client::thumb()` to return an error for
an unsuccessful result; `ResultData` has no `verify()` method.

See the [result documentation](https://thumbrella.dev/docs/client/#result)
for more details.

### Media

```rust
media.url          // String - the original media URL
media.mime         // String - "image/jpeg" | "application/pdf" | ...
media.kind         // String - "image" | "video" | "document" | "geometry" | ...
media.extension    // String - canonical extension without a dot
media.file_size    // u64 - original file size in bytes (0 if unknown)
media.properties   // serde_json::Value - optional format-specific metadata
media.thumbnail    // Thumbnail - the thumbnail JPEG payload
media.cache        // String - opaque cache token used for revalidation
media.placeholder  // String - placeholder identifier, or empty for a real thumbnail
```

See the [media documentation](https://thumbrella.dev/docs/client/#media)
for more details.

### Thumbnail

```rust
jpeg.bytes()       // &[u8] - raw JPEG bytes
jpeg.reader()      // std::io::Cursor<&[u8]> - zero-copy, seekable reader
jpeg.len()         // usize - byte count
jpeg.is_empty()    // bool - whether the payload is empty
jpeg.key()         // u64 - content hash, useful for deduplication
```

Cloning a `Thumbnail` shares its JPEG bytes rather than copying the payload.

## Image libraries

The JPEG payload is a plain `&[u8]`, so it loads into common image libraries
without copying:

```rust
use thumbrella_client as thumbrella;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tbr = thumbrella::Client::new(None);
    let result = tbr.thumb("https://demo.thumbrella.dev/media/game-level.png").await?;

    // Decode directly from the shared bytes (zero copy).
    let img = image::load_from_memory(result.media.thumbnail.bytes())?;

    Ok(())
}
```

The `image` crate is a dependency of your own application, not of this client.

## Servers

This client works with self-hosted Thumbrella servers and the online Thumbrella
Cloud service. Both are configured using the `$TBR_CONNECT` environment variable.
Alternatively, pass a connect string to the `Client` constructor:

```rust
Client::new(Some("http://localhost:3114"));                         // local dev
Client::new(Some("https://cloud.thumbrella.dev,tbr_s_..."));        // cloud token
```

Thumbrella provides a [demo gallery](https://demo.thumbrella.dev) and server
that can be used for free; no account, no signup, immediate access.

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).
