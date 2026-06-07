//! Async Thumbrella client.

use reqwest::{Client as HttpClient, RequestBuilder};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::cache::{Cache, MemoryCache};
use crate::types::*;

const DEFAULT_BASE: &str = "http://api.thumbrella.dev/";

// ── connect string parsing ───────────────────────────────────────────────

struct ConnectConfig {
    base_url: String,
    headers: HashMap<String, String>,
}

fn parse_connect(connect: Option<&str>) -> ConnectConfig {
    let raw: String = connect.map(String::from)
        .or_else(|| std::env::var("TBR_CONNECT").ok())
        .or_else(|| std::env::var("TBR_SERVER").ok())
        .unwrap_or_else(|| DEFAULT_BASE.to_string());
    let raw = raw.as_str();

    // Bearer token — no scheme.
    if !raw.contains("://") {
        let mut headers = HashMap::new();
        headers.insert("Authorization".into(), format!("Bearer {raw}"));
        return ConnectConfig { base_url: DEFAULT_BASE.into(), headers };
    }

    // URL with optional fragment headers.
    let (base, fragment) = raw.split_once('#').unwrap_or((raw, ""));
    let base_url = base.trim_end_matches('/').to_string();
    let mut headers = HashMap::new();

    for seg in fragment.split('&').filter(|s| !s.is_empty()) {
        let seg = seg.trim();
        if let Some((k, v)) = seg.split_once('=') {
            headers.insert(k.trim().to_string(), v.trim().to_string());
        } else if seg.starts_with("tbr_") {
            headers.insert("Authorization".into(), format!("Bearer {seg}"));
        } else {
            headers.insert("x-tbr-handshake".into(), seg.to_string());
        }
    }

    ConnectConfig { base_url, headers }
}

// ── Client ────────────────────────────────────────────────────────────────

/// Thumbrella API client — async-first.
///
/// ```no_run
/// # async fn example() -> Result<(), thumbrella::Error> {
/// let tbr = thumbrella::Client::new(None).verify().await?;
/// let result = tbr.thumb("https://example.com/photo.jpg").await?;
/// println!("{} bytes", result.thumbnail.len());
/// # Ok(())
/// # }
/// ```
pub struct Client {
    base_url: String,
    http: HttpClient,
    caches: Vec<Box<dyn Cache>>,
    results: Mutex<HashMap<String, Arc<Mutex<ResultData>>>>,
}

impl Client {
    /// Create a new client with a default in-memory cache (256 entries).
    pub fn new(connect: Option<&str>) -> Self {
        Self::with_caches(connect, vec![Box::new(MemoryCache::default())])
    }

    /// Create a client with custom caches.  Pass an empty vec for no caching.
    pub fn with_caches(connect: Option<&str>, caches: Vec<Box<dyn Cache>>) -> Self {
        let cfg = parse_connect(connect);
        let mut default_headers = reqwest::header::HeaderMap::new();
        default_headers.insert(
            reqwest::header::USER_AGENT,
            "thumbrella-client/0.1".parse().unwrap(),
        );
        for (k, v) in &cfg.headers {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                default_headers.insert(name, val);
            }
        }

        Self {
            base_url: cfg.base_url,
            http: HttpClient::builder()
                .default_headers(default_headers)
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            caches,
            results: Mutex::new(HashMap::new()),
        }
    }

    /// Registered cache backends.
    pub fn caches(&self) -> &[Box<dyn Cache>] {
        &self.caches
    }

    /// Remove all entries from all caches.
    pub fn clear_caches(&self) {
        for c in &self.caches {
            c.clear();
        }
    }

    /// The server base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    // ── public API ───────────────────────────────────────────────────────

    /// Check connectivity.
    pub async fn verify(&self) -> Result<(), Error> {
        let path = if self.base_url == DEFAULT_BASE { "/token" } else { "/health" };
        let resp = self.request("GET", path).send().await.map_err(|e| {
            Error::Connection(format!("{self}: {e}", self = self.base_url))
        })?;
        let status = resp.status();
        let data: HealthResponse = resp.json().await.map_err(|e| {
            Error::Http(status.as_u16(), e.to_string())
        })?;
        if data.status != "ok" {
            return Err(Error::Verify(format!("unexpected response: {data:?}")));
        }
        Ok(())
    }

    /// Fetch a thumbnail for a single URL.  Returns `Err` on failure.
    pub async fn thumb(&self, url: &str) -> Result<Arc<Mutex<ResultData>>, Error> {
        let results = self.batch(&[url]).await?;
        let result = results.into_iter().next().unwrap();
        let guard = result.lock().unwrap();
        if guard.status != status::SUCCESS {
            return Err(Error::Thumb {
                url: url.to_string(),
                status: guard.status.clone(),
                msg: guard.message.clone(),
            });
        }
        drop(guard);
        Ok(result)
    }

    /// Fetch thumbnails for multiple URLs in one request.
    pub async fn batch(&self, urls: &[&str]) -> Result<Vec<Arc<Mutex<ResultData>>>, Error> {
        let results: Vec<Arc<Mutex<ResultData>>> = urls
            .iter()
            .map(|u| self.get_or_create(u))
            .collect();

        let mut items = Vec::new();
        let mut fetch_indices = Vec::new();

        for (i, r_arc) in results.iter().enumerate() {
            let mut r = r_arc.lock().unwrap();

            // Check caches for existing data.
            for cache in &self.caches {
                if let Some(cached) = cache.get(&r.url) {
                    let cached_guard = cached.lock().unwrap();
                    if !Arc::ptr_eq(&cached, r_arc) {
                        r.clone_fields_from(&cached_guard);
                    }
                }
            }

            if r.is_fresh() {
                r.source = Some(source::CLIENT.to_string());
                continue;
            }
            fetch_indices.push(i);
            let mut item = serde_json::json!({ "url": r.url });
            if let Some(ref cache) = r.cache {
                item["cache"] = serde_json::Value::String(cache.clone());
            }
            items.push(item);
        }

        if items.is_empty() {
            return Ok(results);
        }

        let body = serde_json::json!({ "items": items });
        let resp = match self.request("POST", "/batch").json(&body).send().await {
            Ok(r) => r,
            Err(_) => {
                for &i in &fetch_indices {
                    results[i].lock().unwrap().set_client_error("server unreachable");
                }
                return Ok(results);
            }
        };

        let status_code = resp.status().as_u16();
        if !resp.status().is_success() {
            for r in &results {
                r.lock().unwrap().set_client_error(&format!("server returned {status_code}"));
            }
            return Ok(results);
        }

        let batch: BatchResponse = resp.json().await.map_err(|e| {
            Error::Http(status_code, e.to_string())
        })?;

        for (i, item) in batch.items.into_iter().enumerate() {
            if i < results.len() {
                let mut r = results[i].lock().unwrap();
                r.update_from_json(serde_json::to_value(item).unwrap_or_default());
            }
        }

        // Store results in caches.
        for r in &results {
            for cache in &self.caches {
                cache.put(r);
            }
        }

        Ok(results)
    }

    /// Stream thumbnail results as they complete.
    ///
    /// Note: streaming requires the `stream` feature (not yet implemented).
    #[allow(unused_variables)]
    pub async fn stream(
        &self,
        urls: &[&str],
    ) -> Result<Vec<Arc<Mutex<ResultData>>>, Error> {
        Err(Error::Http(0, "stream not yet implemented — use batch()".into()))
    }

    /// Low-level HTTP request builder.  Prefer `thumb()` / `batch()`.
    pub fn request(&self, method: &str, path: &str) -> RequestBuilder {
        let url = format!("{}{path}", self.base_url);
        self.http.request(method.parse().unwrap(), &url)
    }

    // ── internal ─────────────────────────────────────────────────────────

    fn get_or_create(&self, url: &str) -> Arc<Mutex<ResultData>> {
        let mut map = self.results.lock().unwrap();
        if let Some(existing) = map.get(url) {
            return Arc::clone(existing);
        }
        let result = Arc::new(Mutex::new(ResultData::new(url.to_string())));
        map.insert(url.to_string(), Arc::clone(&result));
        result
    }
}
