//! Result caches — reduce server round-trips for repeated URLs.
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

/// Abstract base for result caches — stores [`Media`] entries keyed by URL.
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
        let store = self.store.lock().unwrap();
        match store.get(url) {
            Some(media) => {
                *self.hits_count.lock().unwrap() += 1;
                let mut order = self.order.lock().unwrap();
                order.retain(|u| u != url);
                order.insert(0, url.to_string());
                Some(media.clone())
            }
            None => {
                *self.misses_count.lock().unwrap() += 1;
                None
            }
        }
    }

    fn put(&self, media: &Media) {
        let url = media.url.clone();
        let mut store = self.store.lock().unwrap();
        let mut order = self.order.lock().unwrap();

        if store.contains_key(&url) {
            order.retain(|u| u != &url);
        } else if store.len() >= self.max_items {
            if let Some(stale) = order.pop() {
                store.remove(&stale);
            }
        }
        store.insert(url.clone(), media.clone());
        order.insert(0, url);
    }

    fn remove(&self, url: &str) {
        self.store.lock().unwrap().remove(url);
        self.order.lock().unwrap().retain(|u| u != url);
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
