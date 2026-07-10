# thumbrella-client

Rust client for [Thumbrella](https://thumbrella.dev), a fast thumbnail server
for images, video, documents, and more.

[![Crates.io](https://img.shields.io/crates/v/thumbrella-client)](https://crates.io/crates/thumbrella-client)
[![docs.rs](https://img.shields.io/docsrs/thumbrella-client)](https://docs.rs/thumbrella-client)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

> Thumbrella is still in prerelease. The server functionality is operational,
> but several production components have yet to appear. Recommended for early
> evaluation only.

The [client git repository](https://github.com/thumbrella-dev/clients) also has
packages for other languages and environments. See
[TypeScript](https://www.npmjs.com/package/@thumbrella/client),
[Python](https://pypi.org/project/thumbrella-client/),
[React](https://www.npmjs.com/package/@thumbrella/react),
[Astro](https://www.npmjs.com/package/@thumbrella/astro), and more coming soon.

## Features

- Async-first with [reqwest](https://crates.io/crates/reqwest) (rustls TLS)
- Optional `blocking` feature provides a sync wrapper
- Minimal dependency tree — `reqwest`, `serde`, `base64`, `thiserror`
- Stream results as the server renders thumbnails (coming soon)
- In-memory LRU cache takes full advantage of HTTP cache headers
- The client and server always provide placeholder images, even when disconnected
- Typed results with media classification and metadata
- Thumbrella server supports hundreds of formats

## Quickstart

The default Thumbrella client provides asyncronous requests.

```bash
cargo add thumbrella-client
```

```rust
use thumbrella_client::Client;

#[tokio::main]
async fn main() -> Result<(), thumbrella_client::Error> {
    let tbr = Client::new(None);
    tbr.verify().await?;

    let result = tbr.thumb("https://example.com/photo.jpg").await?;
    if let Some(media) = &result.media {
        println!("{} bytes  {}", media.thumbnail.len(), media.kind);
        std::fs::write("thumb.jpg", media.thumbnail.bytes())?;
    }

    Ok(())
}
```

A feature allows a synchronous interface for simpler or limited environments.

```bash
cargo add thumbrella-client --features blocking
```

```rust
use thumbrella_client::blocking::Client as BlockingClient;

fn main() -> Result<(), thumbrella_client::Error> {
    let tbr = BlockingClient::new(None);
    tbr.verify()?;
    let result = tbr.thumb("https://example.com/photo.jpg")?;
    println!("{} bytes", result.media.unwrap().thumbnail.len());
    Ok(())
}
```

## Servers

This client works with self-hosted Thumbrella servers and the online Thumbrella
Cloud service. Both are configured using the `$TBR_CONNECT` environment variable.
Alternatively, pass a connect string to the `Client` constructor:

```rust
Client::new(Some("http://localhost:3114"));                         // local dev
Client::new(Some("https://cloud.thumbrella.dev,tbr_s_..."));        // cloud token
```

Thumbrella provides a [demo gallery](https://demo.thumbrella.dev) and server
that can be used for free — no account, no signup, immediate access.

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).
