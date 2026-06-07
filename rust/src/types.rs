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
    /// Server returned a placeholder icon — format not renderable.
    pub const PLACEHOLDER: &str = "placeholder";
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
    /// Server fell back to a placeholder icon.
    pub const FALLBACK: &str = "fallback";
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

/// Lazy-decoded JPEG thumbnail data.  Hashable by content so it can be
/// used as a key in collections for client-side image caching.
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

/// Stable media identity — reusable, cacheable payload.
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

/// A single thumbnail request outcome — process fields + media sub-object.
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
