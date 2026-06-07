//! basic.rs — download one thumbnail to a file.
//!
//! Usage:
//!     cargo run --example basic https://www.python.org/static/img/python-logo.png thumb.jpg

use std::env;
use std::fs;
use thumbrella::Client;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: {} <url> <out.jpg>", args[0]);
        std::process::exit(2);
    }
    let url = &args[1];
    let path = &args[2];

    if let Err(err) = thumbnail(url, path).await {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

async fn thumbnail(url: &str, path: &str) -> Result<(), Box<dyn std::error::Error>> {
    // Client reads TBR_CONNECT env var for server URL or cloud token.
    // verify() ensures the connection is good before proceeding.
    let tbr = Client::new(None);
    tbr.verify().await?;

    // thumb() auto-verifies — returns Err on failure instead of a
    // placeholder like batch() or stream() would.
    let result = tbr.thumb(url).await?;
    let guard = result.lock().unwrap();

    fs::write(path, guard.thumbnail.bytes())?;
    println!(
        "{}  {:>8}  ->  {:>5} bytes  ({})  {path}",
        guard.kind.as_deref().unwrap_or("?"),
        guard.file_size.map_or("?".into(), |s| s.to_string()),
        guard.thumbnail.len(),
        guard.source.as_deref().unwrap_or("render"),
    );

    Ok(())
}
