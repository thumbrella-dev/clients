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

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::types::Media;

/// Canonical cache key for a URL.
///
/// HTTP(S) URLs drop the query and fragment and lowercase the scheme and host,
/// so signed variants of one object share an entry. Other values are used
/// unchanged.
fn cache_key(url: &str) -> Cow<'_, str> {
    let Some(sep) = url.find("://") else {
        return Cow::Borrowed(url);
    };
    let scheme = &url[..sep];
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Cow::Borrowed(url);
    }

    let rest = &url[sep + 3..];
    let rest = rest.split('#').next().unwrap_or(rest);
    let rest = rest.split('?').next().unwrap_or(rest);
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    Cow::Owned(format!("{}://{}{}", scheme.to_ascii_lowercase(), host.to_ascii_lowercase(), path))
}

/// Abstract base for result caches, stores [`Media`] entries under opaque keys.
pub trait Cache: Send + Sync {
    /// Get media stored under `key`.
    fn get(&self, key: &str) -> Option<Media>;
    /// Store `media` under `key`.
    fn put(&self, key: &str, media: &Media);
    /// Remove the entry stored under `key`.
    fn remove(&self, key: &str);
    /// Clear all entries and reset statistics.
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
    fn get(&self, key: &str) -> Option<Media> {
        let store = self.store.lock().unwrap();
        match store.get(key) {
            Some(media) => {
                *self.hits_count.lock().unwrap() += 1;
                let mut order = self.order.lock().unwrap();
                order.retain(|u| u != key);
                order.insert(0, key.to_string());
                Some(media.clone())
            }
            None => {
                *self.misses_count.lock().unwrap() += 1;
                None
            }
        }
    }

    fn put(&self, key: &str, media: &Media) {
        let mut store = self.store.lock().unwrap();
        let mut order = self.order.lock().unwrap();

        if store.contains_key(key) {
            order.retain(|u| u != key);
        } else if store.len() >= self.max_items
            && let Some(stale) = order.pop()
        {
            store.remove(&stale);
        }
        store.insert(key.to_string(), media.clone());
        order.insert(0, key.to_string());
    }

    fn remove(&self, key: &str) {
        self.store.lock().unwrap().remove(key);
        self.order.lock().unwrap().retain(|u| u != key);
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

/// Get cached media for a raw URL from a stack of caches.
///
/// The URL is canonicalised once, so every cache in the stack sees the same
/// key. A fresh entry wins over a stale one; otherwise the first entry found
/// is returned so its `cache` token can be used for revalidation.
pub fn media_from_caches(caches: &[Box<dyn Cache>], url: &str) -> Option<Media> {
    let key = cache_key(url);
    let mut stale = None;
    for cache in caches {
        if let Some(media) = cache.get(key.as_ref()) {
            if media.is_fresh() {
                return Some(media);
            }
            if stale.is_none() {
                stale = Some(media);
            }
        }
    }
    stale
}

/// Store media in every cache under the raw URL's canonical key.
pub fn put_all_caches(caches: &[Box<dyn Cache>], url: &str, media: &Media) {
    let key = cache_key(url);
    for cache in caches {
        cache.put(key.as_ref(), media);
    }
}

/// Remove a raw URL from every cache in a stack.
pub fn remove_from_caches(caches: &[Box<dyn Cache>], url: &str) {
    let key = cache_key(url);
    for cache in caches {
        cache.remove(key.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_follows_the_shared_rules() {
        assert_eq!(cache_key("HTTP://Host").as_ref(), "http://host");
        assert_eq!(
            cache_key("https://CDN.Example.com/Path/File.JPG?x=1#frag").as_ref(),
            "https://cdn.example.com/Path/File.JPG"
        );
        assert_eq!(cache_key("ftp://Host/Path?x#frag").as_ref(), "ftp://Host/Path?x#frag");
        assert_eq!(cache_key("/local/path").as_ref(), "/local/path");
    }

    #[test]
    fn signed_variants_share_one_entry() {
        let caches: Vec<Box<dyn Cache>> = vec![Box::new(MemoryCache::default())];
        let a = "https://CDN.Example.com/path/File.JPG?X-Amz-Signature=aaa#frag";
        let b = "https://cdn.example.com/path/File.JPG?X-Amz-Signature=bbb";
        let media = Media {
            url: a.to_string(),
            cache: "1:tok".to_string(),
            ..Default::default()
        };

        put_all_caches(&caches, a, &media);
        assert_eq!(caches[0].len(), 1);
        assert!(media_from_caches(&caches, b).is_some());

        remove_from_caches(&caches, b);
        assert_eq!(caches[0].len(), 0);
    }
}
