//! Thumbrella Rust client — async-first thumbnail generation.
//!
//! ```no_run
//! # async fn example() -> Result<(), thumbrella::Error> {
//! let tbr = thumbrella::Client::new(None);
//! tbr.verify().await?;
//! let result = tbr.thumb("https://example.com/photo.jpg").await?;
//! let guard = result.lock().unwrap();
//! println!("{} bytes  {}", guard.thumbnail.len(), guard.kind.as_deref().unwrap_or("?"));
//! # Ok(())
//! # }
//! ```

mod cache;
mod client;
mod types;

#[cfg(feature = "blocking")]
pub mod blocking;

pub use cache::{Cache, MemoryCache};
pub use client::Client;
pub use types::{Error, ResultData, Thumbnail, status, source};
