//! Result caches — reduce server round-trips for repeated URLs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::types::ResultData;

/// Abstract result cache.
pub trait Cache: Send + Sync {
    fn get(&self, url: &str) -> Option<Arc<Mutex<ResultData>>>;
    fn put(&self, result: &Arc<Mutex<ResultData>>);
    fn remove(&self, url: &str);
    fn clear(&self);
    fn len(&self) -> usize;
    fn hits(&self) -> u64;
    fn misses(&self) -> u64;
}

/// In-memory LRU-ish cache with a size limit.
pub struct MemoryCache {
    max_items: usize,
    store: Mutex<HashMap<String, Arc<Mutex<ResultData>>>>,
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
    fn get(&self, url: &str) -> Option<Arc<Mutex<ResultData>>> {
        let store = self.store.lock().unwrap();
        match store.get(url) {
            Some(result) => {
                *self.hits_count.lock().unwrap() += 1;
                let mut order = self.order.lock().unwrap();
                order.retain(|u| u != url);
                order.insert(0, url.to_string());
                Some(Arc::clone(result))
            }
            None => {
                *self.misses_count.lock().unwrap() += 1;
                None
            }
        }
    }

    fn put(&self, result: &Arc<Mutex<ResultData>>) {
        let url = result.lock().unwrap().url.clone();
        let mut store = self.store.lock().unwrap();
        let mut order = self.order.lock().unwrap();

        if store.contains_key(&url) {
            order.retain(|u| u != &url);
        } else if store.len() >= self.max_items {
            if let Some(stale) = order.pop() {
                store.remove(&stale);
            }
        }
        store.insert(url.clone(), Arc::clone(result));
        order.insert(0, url);
    }

    fn remove(&self, url: &str) {
        self.store.lock().unwrap().remove(url);
        self.order.lock().unwrap().retain(|u| u != url);
    }

    fn clear(&self) {
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
