//! Result caches, reduce server round-trips for repeated URLs.
//!
//! Caches are passed to the [`Client`](crate::Client) when constructed.
//! Each client works with a stack of cache objects, and will use a small
//! [`MemoryCache`] by default.
//!
//! The caches offer limited management methods and simple statistics tracking
//! (`hits` / `misses`). A cache can be used with multiple clients at the
//! same time.
//!
//! See <https://thumbrella.dev/docs/cache> for full documentation.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::types::Media;

/// Stable HTTP cache identity; non-HTTP and malformed URLs are unchanged.
pub(crate) fn canonical_url(raw: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(raw) else {
        return raw.to_string();
    };
    if !matches!(url.scheme(), "http" | "https") || !raw.contains("://") {
        return raw.to_string();
    }
    let mut pairs: Vec<(String, String)> =
        url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
    let sas = pairs.iter().any(|(key, _)| key.eq_ignore_ascii_case("sig"));
    pairs.retain(|(key, _)| {
        let key = key.to_ascii_lowercase();
        !matches!(
            key.as_str(),
            "auth"
                | "authorization"
                | "token"
                | "access_token"
                | "auth_token"
                | "api_key"
                | "apikey"
                | "signature"
                | "sig"
                | "credential"
                | "security_token"
                | "expires"
                | "expiry"
                | "awsaccesskeyid"
                | "googleaccessid"
                | "policy"
                | "key-pair-id"
        ) && !key.starts_with("x-amz-")
            && !key.starts_with("x-goog-")
            && !(sas
                && matches!(
                    key.as_str(),
                    "sv" | "ss"
                        | "srt"
                        | "sp"
                        | "se"
                        | "st"
                        | "spr"
                        | "sip"
                        | "sr"
                        | "si"
                        | "skoid"
                        | "sktid"
                        | "skt"
                        | "ske"
                        | "sks"
                        | "skv"
                        | "saoid"
                        | "suoid"
                        | "scid"
                ))
    });
    url.set_fragment(None);
    url.set_query(None);
    if !pairs.is_empty() {
        url.query_pairs_mut().extend_pairs(pairs);
    }
    url.to_string()
}

/// Abstract base for result caches, stores [`Media`] entries keyed by URL.
pub trait Cache: Send + Sync {
    /// Get the possible cached media for a URL.
    fn get(&self, url: &str) -> Option<Media>;
    /// Store cached media for a URL.
    fn put(&self, media: &Media);
    /// Remove possible cached media for a URL.
    fn remove(&self, url: &str);
    /// Clear all cached URLs and reset statistics.
    fn reset(&self);
    /// Number of cached entries.
    fn len(&self) -> usize;
    /// True when the cache has no entries.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Number of cache hits since creation or last reset.
    fn hits(&self) -> u64;
    /// Number of cache misses since creation or last reset.
    fn misses(&self) -> u64;
}

/// A small temporary cache for the current process.
///
/// The default cache stores a small amount of thumbnails in memory. Nothing
/// is stored after the cache is removed.
///
/// Each Thumbrella [`Client`](crate::Client) works with a stack of cache
/// objects, assigned at construction time. By default the client creates and
/// uses this `MemoryCache` with the default arguments.
///
/// This cache uses an LRU strategy to keep the number of thumbnails within
/// the specified `max_items` limit.
///
/// Most thumbnails will use approximately 5 KB worth of data each.
pub struct MemoryCache {
    max_items: usize,
    store: Mutex<HashMap<String, Media>>,
    order: Mutex<Vec<String>>,
    hits_count: Mutex<u64>,
    misses_count: Mutex<u64>,
}

impl MemoryCache {
    pub fn new(max_items: usize) -> Self {
        Self {
            max_items,
            store: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            hits_count: Mutex::new(0),
            misses_count: Mutex::new(0),
        }
    }
}

impl Default for MemoryCache {
    fn default() -> Self {
        Self::new(256)
    }
}

impl Cache for MemoryCache {
    fn get(&self, url: &str) -> Option<Media> {
        let url = canonical_url(url);
        let store = self.store.lock().unwrap();
        match store.get(&url) {
            Some(media) => {
                *self.hits_count.lock().unwrap() += 1;
                let mut order = self.order.lock().unwrap();
                order.retain(|u| u != &url);
                order.insert(0, url);
                Some(media.clone())
            }
            None => {
                *self.misses_count.lock().unwrap() += 1;
                None
            }
        }
    }

    fn put(&self, media: &Media) {
        let url = canonical_url(&media.url);
        let mut store = self.store.lock().unwrap();
        let mut order = self.order.lock().unwrap();

        if store.contains_key(&url) {
            order.retain(|u| u != &url);
        } else if store.len() >= self.max_items
            && let Some(stale) = order.pop()
        {
            store.remove(&stale);
        }
        store.insert(url.clone(), media.clone());
        order.insert(0, url);
    }

    fn remove(&self, url: &str) {
        let url = canonical_url(url);
        self.store.lock().unwrap().remove(&url);
        self.order.lock().unwrap().retain(|u| u != &url);
    }

    fn reset(&self) {
        self.store.lock().unwrap().clear();
        self.order.lock().unwrap().clear();
        *self.hits_count.lock().unwrap() = 0;
        *self.misses_count.lock().unwrap() = 0;
    }

    fn len(&self) -> usize {
        self.store.lock().unwrap().len()
    }

    fn hits(&self) -> u64 {
        *self.hits_count.lock().unwrap()
    }

    fn misses(&self) -> u64 {
        *self.misses_count.lock().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_keys() {
        for (raw, expected) in [
            ("HTTPS://MEDIA.test/a?size=large&TOKEN=one#part", "https://media.test/a?size=large"),
            ("https://media.test/a?X-Amz-Signature=a&X-Amz-Date=b&v=2", "https://media.test/a?v=2"),
            (
                "https://media.test/a?X-Goog-Credential=a&X-Goog-Expires=1&v=2",
                "https://media.test/a?v=2",
            ),
            ("https://media.test/a?AWSAccessKeyId=a&Signature=b&Expires=1", "https://media.test/a"),
            (
                "https://media.test/a?sv=1&sp=r&sig=a&se=tomorrow&width=2",
                "https://media.test/a?width=2",
            ),
            ("https://media.test/a?sv=1&width=2", "https://media.test/a?sv=1&width=2"),
            (
                "https://media.test/a?token=a&token=b&v=2&v=3&empty=",
                "https://media.test/a?v=2&v=3&empty=",
            ),
            ("https://media.test/a?%74oken=a&v=2", "https://media.test/a?v=2"),
            ("https://media.test/a?b=2&a=1", "https://media.test/a?b=2&a=1"),
            ("https://media.test/a?q=a%20b&token=one", "https://media.test/a?q=a+b"),
            ("https://media.test/a?q=a%20b", "https://media.test/a?q=a+b"),
            ("https://MEDIA.test:443?token=one", "https://media.test/"),
            ("file:///tmp/a?token=keep#part", "file:///tmp/a?token=keep#part"),
            ("/tmp/a?token=keep", "/tmp/a?token=keep"),
            ("https://[invalid", "https://[invalid"),
            ("https://media.test:invalid/a", "https://media.test:invalid/a"),
        ] {
            assert_eq!(canonical_url(raw), expected, "{raw}");
            assert_eq!(canonical_url(&canonical_url(raw)), expected, "{raw}");
        }
    }

    #[test]
    fn memory_cache_lookup_and_removal() {
        let cache = MemoryCache::default();
        let media = Media {
            url: "https://media.test/a?v=2&token=one".into(),
            ..Media::default()
        };
        cache.put(&media);
        assert_eq!(cache.get("https://media.test/a?v=2&token=two").unwrap().url, media.url);
        assert!(cache.get("https://media.test/a?v=3").is_none());
        cache.remove("https://media.test/a?v=2&token=three");
        assert!(cache.is_empty());
    }
}
