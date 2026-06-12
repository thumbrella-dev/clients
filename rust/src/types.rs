//! Types and constants — mirror the server wire format.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

// ── status constants ─────────────────────────────────────────────────────

pub mod status {
    pub const SUCCESS: &str = "success";
    pub const FAILED: &str = "failed";
    pub const OVERLOADED: &str = "overloaded";
    pub const INTERMEDIATE: &str = "intermediate";
    /// Client-side synthetic (server unreachable).
    pub const UNAVAILABLE: &str = "unavailable";
}

// ── source constants ─────────────────────────────────────────────────────

pub mod source {
    pub const RENDER: &str = "render";
    pub const SHORTCUT: &str = "shortcut";
    pub const CACHE: &str = "cache";
    /// Client cache hints were valid — no new thumbnail needed.
    pub const NOT_MODIFIED: &str = "not_modified";
    /// A registered renderer tried but could not handle this format.
    pub const FALLBACK: &str = "fallback";
    /// No renderer was registered for this format at all.
    pub const PLACEHOLDER: &str = "placeholder";
    /// Client-side synthetic (no network call).
    pub const CLIENT: &str = "client";
}

// ── errors ───────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not reach server at {0}")]
    Connection(String),
    #[error("request timed out")]
    Timeout,
    #[error("verify failed: {0}")]
    Verify(String),
    #[error("thumbnail failed for {url}: {status}{}", msg.as_deref().map_or(String::new(), |m| format!(" — {m}")))]
    Thumb {
        url: String,
        status: String,
        msg: Option<String>,
    },
    #[error("http {0}: {1}")]
    Http(u16, String),
}

// ── Thumbnail ────────────────────────────────────────────────────────────

/// Binary JPEG thumbnail data.
///
/// This represents the encoded JPEG data stream — not pixel data.  It can
/// be shared across multiple `Media` objects via `Arc` to make placeholder
/// images more efficient.
///
/// Each Thumbrella thumbnail is approximately 5 KB of JPEG data. When the
/// server encodes the image into JSON it uses a base64 encoding, handled
/// transparently by the `From<String>` / `Into<String>` impls.
///
/// See <https://thumbrella.dev/docs/result> for full documentation.
#[derive(Clone, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub struct Thumbnail {
    /// Shared JPEG bytes — cloning is cheap (Arc).
    data: Arc<Vec<u8>>,
    /// Pre-computed content hash for fast Map lookups.
    hash: u64,
}

impl Default for Thumbnail {
    fn default() -> Self {
        Vec::new().into()
    }
}

impl Thumbnail {
    /// The raw JPEG bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.data
    }

    /// Number of bytes in the JPEG payload.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Stable content hash for use as a collection key.
    pub fn key(&self) -> u64 {
        self.hash
    }

    fn hash_bytes(data: &[u8]) -> u64 {
        let mut h: u64 = 0;
        for &b in data {
            h = h.wrapping_mul(31).wrapping_add(b as u64);
        }
        h
    }
}

impl Hash for Thumbnail {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u64(self.hash);
    }
}

impl PartialEq for Thumbnail {
    fn eq(&self, other: &Self) -> bool {
        self.hash == other.hash && self.data == other.data
    }
}

impl Eq for Thumbnail {}

impl From<Vec<u8>> for Thumbnail {
    fn from(data: Vec<u8>) -> Self {
        let hash = Self::hash_bytes(&data);
        Self { data: Arc::new(data), hash }
    }
}

impl From<String> for Thumbnail {
    fn from(b64: String) -> Self {
        base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .map(Vec::from)
            .unwrap_or_default()
            .into()
    }
}

impl From<Thumbnail> for String {
    fn from(t: Thumbnail) -> String {
        base64::engine::general_purpose::STANDARD.encode(t.bytes())
    }
}

impl From<Thumbnail> for Vec<u8> {
    fn from(t: Thumbnail) -> Vec<u8> {
        t.data.to_vec()
    }
}

impl std::fmt::Debug for Thumbnail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Thumbnail({} bytes)", self.data.len())
    }
}

// ── Media ────────────────────────────────────────────────────────────────

/// Data from the [`ResultData`] that describes the source media.
///
/// Any two results from the same URL that were cached (by either the client
/// or the server) will share a `Clone` of the same stable `Media` value.
///
/// The `properties` represent optional additional information Thumbrella
/// provides to describe the media. Each `kind` has a different schema for
/// what could be included. For example, images will come with
/// `width_pixels`, `height_pixels` and `color_bpp`. But these properties
/// are still optional and may not always be included.
///
/// The `thumbnail` attribute will always be valid.
///
/// See <https://thumbrella.dev/docs/result> for full documentation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Media {
    pub url: String,
    #[serde(default)]
    pub thumbnail: Thumbnail,
    #[serde(default)]
    pub mime: String,
    #[serde(default, rename = "file_size")]
    pub file_size: u64,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub extension: String,
    #[serde(default)]
    pub properties: serde_json::Value,
    #[serde(default)]
    pub cache: Option<String>,
}

impl Media {
    pub fn is_fresh(&self) -> bool {
        if let Some(ref cache) = self.cache {
            if let Some((epoch_hex, _)) = cache.split_once(':') {
                if let Ok(expires) = u64::from_str_radix(epoch_hex, 16) {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    return expires > 0 && expires > now;
                }
            }
        }
        false
    }
}

// ── Result ───────────────────────────────────────────────────────────────

/// Result for every URL.
///
/// The result describes the operation for every thumbnail URL. It handles both
/// successes and failures.
///
/// The `status` field determines how this result should be handled. All
/// statuses will still include a thumbnail image, even for failures.
/// Comparing against the [`status`] constants is the best way to branch on
/// outcome.
///
/// The top-level fields represent the process of generating the result —
/// whether the operation was successful, how caching was involved, and the
/// operations used by either the client or server.
///
/// The `media` field holds all data collected about the source media in a
/// [`Media`] value. When requesting data that has been cached by either the
/// client or the server, the result will reuse a clone of the same media
/// value that was returned previously.
///
/// The `raw` field holds the raw JSON returned by the server, though the
/// thumbnail binary data is stripped for efficiency.
///
/// See <https://thumbrella.dev/docs/result> for full documentation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultData {
    pub url: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default, rename = "download_size")]
    pub download_size: u64,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub media: Option<Media>,
    /// Raw server JSON.
    #[serde(skip)]
    pub raw: serde_json::Value,
}

impl ResultData {
    pub fn new(url: String) -> Self {
        Self {
            url,
            status: status::UNAVAILABLE.to_string(),
            duration: 0.0,
            download_size: 0,
            message: None,
            placeholder: None,
            source: Some(source::CLIENT.to_string()),
            media: None,
            raw: serde_json::Value::Null,
        }
    }

    pub fn is_fresh(&self) -> bool {
        self.media.as_ref().map_or(false, |m| m.is_fresh())
    }

    pub fn is_success(&self) -> bool {
        self.status == status::SUCCESS
    }

    pub fn set_client_error(&mut self, msg: &str) {
        self.status = status::UNAVAILABLE.to_string();
        self.source = Some(source::CLIENT.to_string());
        self.message = Some(msg.to_string());
    }
}

// ── Wire helpers ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub(crate) struct BatchResponse {
    #[serde(default)]
    pub items: Vec<ResultData>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct HealthResponse {
    #[serde(default)]
    pub status: String,
}
