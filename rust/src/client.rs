//! Async Thumbrella client.

use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use crate::cache::{Cache, MemoryCache};
use crate::types::*;

const DEFAULT_BASE: &str = "http://api.thumbrella.dev/";
const HTTP_TIMEOUT_SECS: u64 = 12;
const MAX_BACKOFF_SECS: u64 = 60;

// ── global backoff ───────────────────────────────────────────────────────

struct Backoff {
    hosts: Mutex<HashMap<String, (std::time::Instant, u32)>>,
}

impl Backoff {
    fn new() -> Self {
        Self { hosts: Mutex::new(HashMap::new()) }
    }

    fn check(&self, host: &str) -> Result<(), Error> {
        let map = self.hosts.lock().unwrap();
        if let Some(&(until, _)) = map.get(host) {
            if std::time::Instant::now() < until {
                return Err(Error::Connection(format!("{host} is throttled, retry later")));
            }
        }
        Ok(())
    }

    fn record(&self, host: &str, throttled: bool) {
        let mut map = self.hosts.lock().unwrap();
        if throttled {
            let failures = map.get(host).map_or(1, |&(_, f)| f + 1);
            let delay = Duration::from_secs((2u64.pow(failures)).min(MAX_BACKOFF_SECS));
            map.insert(host.to_string(), (std::time::Instant::now() + delay, failures));
        } else {
            map.remove(host);
        }
    }
}

// ── connect string parsing ───────────────────────────────────────────────

struct ConnectConfig {
    base_url: String,
    host: String,
    headers: HashMap<String, String>,
}

fn parse_connect(connect: Option<&str>) -> ConnectConfig {
    let raw: String = connect.map(String::from)
        .or_else(|| std::env::var("TBR_CONNECT").ok())
        .unwrap_or_else(|| DEFAULT_BASE.to_string());

    // Bare token — no scheme.
    if !raw.contains("://") {
        let mut headers = HashMap::new();
        headers.insert("Authorization".into(), format!("Bearer {raw}"));
        return ConnectConfig {
            base_url: DEFAULT_BASE.into(),
            host: "api.thumbrella.dev".into(),
            headers,
        };
    }

    // Split on first comma to separate URL from optional suffix.
    let (url_part, suffix) = raw.split_once(',').unwrap_or((&raw, ""));
    let base_url = url_part.trim_end_matches('/').to_string();

    let host = url_part
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();

    let mut headers = HashMap::new();
    for seg in suffix.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if let Some((k, v)) = seg.split_once('=') {
            headers.insert(k.trim().to_string(), v.trim().to_string());
        } else {
            headers.insert("Authorization".into(), format!("Bearer {seg}"));
        }
    }

    ConnectConfig { base_url, host, headers }
}

// ── Client ────────────────────────────────────────────────────────────────

/// Thumbrella API client — async-first.
///
/// ```no_run
/// # async fn example() -> Result<(), thumbrella::Error> {
/// let tbr = thumbrella::Client::new(None);
/// tbr.verify().await?;
/// let result = tbr.thumb("https://example.com/photo.jpg").await?;
/// if let Some(media) = &result.media {
///     println!("{} bytes", media.thumbnail.len());
/// }
/// # Ok(())
/// # }
/// ```
pub struct Client {
    base_url: String,
    host: String,
    http: HttpClient,
    caches: Vec<Box<dyn Cache>>,
    backoff: Backoff,
}

impl Client {
    /// Create a new client with a default in-memory cache (256 entries).
    pub fn new(connect: Option<&str>) -> Self {
        Self::with_caches(connect, vec![Box::new(MemoryCache::default())])
    }

    /// Create a client with custom caches. Pass an empty vec for no caching.
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
            host: cfg.host,
            http: HttpClient::builder()
                .default_headers(default_headers)
                .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
                .build()
                .expect("reqwest client"),
            caches,
            backoff: Backoff::new(),
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

    /// Check connectivity. Returns `Ok(())` on success.
    pub async fn verify(&self) -> Result<(), Error> {
        let path = if self.base_url == DEFAULT_BASE { "/token" } else { "/health" };
        let resp = self.request("GET", path).send().await.map_err(|e| {
            Error::Connection(format!("{}: {e}", self.base_url))
        })?;
        let code = resp.status().as_u16();
        self.backoff.record(&self.host, code == 429 || code == 503);

        let data: HealthResponse = resp.json().await.map_err(|e| {
            Error::Http(code, e.to_string())
        })?;
        if data.status != "ok" {
            return Err(Error::Verify(format!("unexpected response: {data:?}")));
        }
        Ok(())
    }

    /// Fetch a thumbnail for a single URL. Returns `Err` on failure.
    pub async fn thumb(&self, url: &str) -> Result<ResultData, Error> {
        let results = self.batch(&[url]).await?;
        let result = results.into_iter().next().unwrap();
        if result.status != status::SUCCESS {
            return Err(Error::Thumb {
                url: url.to_string(),
                status: result.status.clone(),
                msg: result.message.clone(),
            });
        }
        Ok(result)
    }

    /// Fetch thumbnails for multiple URLs in one request.
    pub async fn batch(&self, urls: &[&str]) -> Result<Vec<ResultData>, Error> {
        let mut done: HashMap<String, ResultData> = HashMap::new();
        let mut stale_items: Vec<serde_json::Value> = Vec::new();

        for &url in urls {
            if !url.contains("://") {
                let mut r = ResultData::new(url.to_string());
                r.set_client_error("invalid URL");
                done.insert(url.to_string(), r);
                continue;
            }

            // Check caches for a fresh entry.
            let mut fresh = false;
            for cache in &self.caches {
                if let Some(cached) = cache.get(url) {
                    if cached.is_fresh() {
                        let mut r = ResultData::new(url.to_string());
                        r.status = status::SUCCESS.to_string();
                        r.source = Some(source::CACHE.to_string());
                        r.media = Some(cached.clone());
                        done.insert(url.to_string(), r);
                        fresh = true;
                        break;
                    }
                }
            }
            if fresh {
                continue;
            }

            let mut item = serde_json::json!({ "url": url });
            for cache in &self.caches {
                if let Some(cached) = cache.get(url) {
                    if let Some(ref cache_str) = cached.cache {
                        item["cache"] = serde_json::Value::String(cache_str.clone());
                        break;
                    }
                }
            }
            stale_items.push(item);
        }

        if stale_items.is_empty() {
            return Ok(urls.iter().map(|u| done.remove(*u).unwrap()).collect());
        }

        self.backoff.check(&self.host)?;

        let body = serde_json::json!({ "items": stale_items });
        let resp = match self.request("POST", "/batch")
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return Ok(self.collect_results(urls, &done, |url| {
                    let mut r = ResultData::new(url.to_string());
                    r.set_client_error(&format!("server unreachable: {e}"));
                    r
                }));
            }
        };

        let code = resp.status().as_u16();
        self.backoff.record(&self.host, code == 429 || code == 503);

        if !resp.status().is_success() {
            return Ok(self.collect_results(urls, &done, |url| {
                let mut r = ResultData::new(url.to_string());
                r.set_client_error(&format!("server returned {code}"));
                r
            }));
        }

        let batch: BatchResponse = resp.json().await.map_err(|e| {
            Error::Http(code, e.to_string())
        })?;

        for item in batch.items {
            if let Some(ref media) = item.media {
                for cache in &self.caches {
                    cache.put(media);
                }
            }
            done.insert(item.url.clone(), item);
        }

        Ok(self.collect_results(urls, &done, |url| {
            let mut r = ResultData::new(url.to_string());
            r.set_client_error("no result from server");
            r
        }))
    }

    /// Stream thumbnail results as they complete.
    ///
    /// Currently delegates to [`batch`] — true NDJSON streaming is not yet
    /// implemented. Results are still collected and returned in order.
    pub async fn stream(&self, urls: &[&str]) -> Result<Vec<ResultData>, Error> {
        self.batch(urls).await
    }

    // ── helpers ──────────────────────────────────────────────────────────

    fn collect_results<F>(
        &self,
        urls: &[&str],
        done: &HashMap<String, ResultData>,
        fallback: F,
    ) -> Vec<ResultData>
    where
        F: Fn(&str) -> ResultData,
    {
        urls.iter()
            .map(|&u| done.get(u).cloned().unwrap_or_else(|| fallback(u)))
            .collect()
    }

    /// Low-level HTTP request builder.
    pub fn request(
        &self,
        method: &str,
        path: &str,
    ) -> reqwest::RequestBuilder {
        let url = format!("{}{path}", self.base_url);
        self.http.request(method.parse().unwrap(), &url)
    }
}
