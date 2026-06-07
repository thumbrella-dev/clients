//! stream.rs — show progress on thumbnail rendering (batch mode).
//!
//! Usage:
//!     cargo run --example stream https://www.python.org/static/img/python-logo.png https://docs.github.com/en/get-started/git-basics/setting-your-username-in-git

use std::env;
use std::time::Instant;
use thumbrella::Client;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    let urls: Vec<&str> = args[1..].iter().map(|s| s.as_str()).collect();
    if urls.is_empty() {
        eprintln!("usage: {} <url> [url...]", args[0]);
        std::process::exit(2);
    }

    let tbr = Client::new(None);
    if let Err(e) = tbr.verify().await {
        eprintln!("{e}");
        std::process::exit(1);
    }

    // Print index
    for (i, url) in urls.iter().enumerate() {
        println!("{:03}: {url}", i + 1);
    }

    let start = Instant::now();
    match tbr.stream(&urls).await {
        Ok(results) => {
            for result in &results {
                let elapsed = start.elapsed().as_millis();
                let kind = result.media.as_ref()
                    .map(|m| format!("{}({})", m.kind, m.extension))
                    .unwrap_or_else(|| "<nomedia>".to_string());
                println!(
                    "{elapsed}ms {} - {} {} {} {}",
                    result.url.split('/').next_back().unwrap_or(&result.url),
                    result.status,
                    kind,
                    result.source.as_deref().unwrap_or(""),
                    result.message.as_deref().unwrap_or(""),
                );
            }
        }
        Err(e) => {
            eprintln!("stream error: {e}");
            std::process::exit(1);
        }
    }
}
