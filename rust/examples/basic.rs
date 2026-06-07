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
    let tbr = Client::new(None);
    tbr.verify().await?;

    let result = tbr.thumb(url).await?;
    if let Some(media) = &result.media {
        fs::write(path, media.thumbnail.bytes())?;
        println!(
            "{} {:>8}  ->  {:>5} bytes  ({})  {path}",
            media.kind,
            media.file_size,
            media.thumbnail.len(),
            result.source.as_deref().unwrap_or("render"),
        );
    } else {
        eprintln!("No media in result (status: {})", result.status);
    }

    Ok(())
}
