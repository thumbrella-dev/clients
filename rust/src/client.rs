//! Async Thumbrella client.

use async_stream::stream;
use futures_core::Stream;
use futures_util::StreamExt;
use reqwest::Client as HttpClient;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use crate::cache::{Cache, MemoryCache};
use crate::types::*;

const DEFAULT_BASE: &str = "https://cloud.thumbrella.dev";
const HTTP_TIMEOUT_SECS: u64 = 12;
const MAX_BACKOFF_SECS: u64 = 60;
const BATCH_MAX_ITEMS: usize = 12;

//  global backoff

struct Backoff {
    hosts: Mutex<HashMap<String, (std::time::Instant, u32)>>,
}

impl Backoff {
    fn new() -> Self {
        Self { hosts: Mutex::new(HashMap::new()) }
    }

    fn check(&self, host: &str) -> Result<(), Error> {
        let map = self.hosts.lock().unwrap();
        if let Some(&(until, _)) = map.get(host)
            && std::time::Instant::now() < until {
                return Err(Error::Connection(format!("{host} is throttled, retry later")));
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

//  connect string parsing

struct ConnectConfig {
    base_url: String,
    host: String,
    headers: HashMap<String, String>,
}

fn is_auth_token(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 6 && b.starts_with(b"tbr_") && b[4].is_ascii_lowercase() && b[5] == b'_'
}

/// Extract host from a URL like "https://cloud.thumbrella.dev".
fn host_from_url(url: &str) -> &str {
    url.split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
}

fn parse_connect(connect: Option<&str>) -> ConnectConfig {
    let raw: String = connect.map(String::from)
        .or_else(|| std::env::var("TBR_CONNECT").ok())
        .unwrap_or_else(|| DEFAULT_BASE.to_string());

    // Bare value, no scheme.  Only auth tokens are valid without a URL.
    if !raw.contains("://") {
        if is_auth_token(&raw) {
            let mut headers = HashMap::new();
            headers.insert("Authorization".into(), format!("Bearer {raw}"));
            return ConnectConfig {
                base_url: DEFAULT_BASE.into(),
                host: host_from_url(DEFAULT_BASE).to_string(),
                headers,
            };
        }
        // Bare non-auth values are not valid connect strings.
        return ConnectConfig {
            base_url: DEFAULT_BASE.into(),
            host: host_from_url(DEFAULT_BASE).to_string(),
            headers: HashMap::new(),
        };
    }

    // Split on first comma to separate URL from optional suffix.
    let (url_part, suffix) = raw.split_once(',').unwrap_or((&raw, ""));
    let base_url = url_part.trim_end_matches('/').to_string();

    let host = host_from_url(url_part).to_string();

    let mut headers = HashMap::new();
    for seg in suffix.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if let Some((k, v)) = seg.split_once('=') {
            headers.insert(k.trim().to_string(), v.trim().to_string());
        } else if is_auth_token(seg) {
            headers.insert("Authorization".into(), format!("Bearer {seg}"));
        } else {
            headers.insert("x-tbr-handshake".into(), seg.to_string());
        }
    }

    ConnectConfig { base_url, host, headers }
}

//  Client 

/// Thumbrella API client, async-first.
///
/// A centralized configuration for a Thumbrella server and client-side caches.
/// The connection is described by a "connect string". By default this uses the
/// `$TBR_CONNECT` environment variable.
///
/// Most thumbnails will be handled in batches with the [`batch`](Self::batch) or
/// [`stream`](Self::stream) methods. These return a set of [`ResultData`]
/// values, which can individually succeed, fail, or reuse cached contents.
/// All result objects will have a placeholder or failure image, even if one
/// could not be rendered.
///
/// Creating the client makes no immediate connection to the server. Use
/// [`verify`](Self::verify) to ensure the configuration is good, which will
/// return an error if there are server-side or client-side issues.
///
/// A collection of caches can be passed to the client via
/// [`with_caches`](Self::with_caches). By default the client uses a single
/// [`MemoryCache`] with the default settings. Pass an empty vec for no caching.
///
/// See <https://thumbrella.dev/docs/client> for full documentation.
///
/// ```no_run
/// # async fn example() -> Result<(), thumbrella_client::Error> {
/// let tbr = thumbrella_client::Client::new(None);
/// tbr.verify().await?;
/// let result = tbr.thumb("https://example.com/photo.jpg").await?;
/// println!("{} bytes", result.media.thumbnail.len());
/// # Ok(())
/// # }
/// ```
pub struct Client {
    base_url: String,
    host: String,
    http: HttpClient,
    stream_http: HttpClient,
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
            concat!(
                "thumbrella-rust/",
                env!("CARGO_PKG_VERSION_MAJOR"),
                ".",
                env!("CARGO_PKG_VERSION_MINOR"),
            )
            .parse()
            .unwrap(),
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
                .default_headers(default_headers.clone())
                .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
                .build()
                .expect("reqwest client"),
            stream_http: HttpClient::builder()
                .default_headers(default_headers)
                .connect_timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
                .read_timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
                .build()
                .expect("reqwest stream client"),
            caches,
            backoff: Backoff::new(),
        }
    }

    /// Registered cache backends.
    pub fn caches(&self) -> &[Box<dyn Cache>] {
        &self.caches
    }

    /// Reset all attached caches.
    ///
    /// The cache reset is intended to clear the cache contents and reset
    /// statistics and tracking information.
    pub fn reset_caches(&self) {
        for c in &self.caches {
            c.reset();
        }
    }

    /// The server base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    //  public API

    /// Check configuration and server connectivity.
    ///
    /// Check that the server is operational and the configuration string is
    /// valid. If the connection string defines tokens or custom HTTP headers
    /// those will also be validated.
    ///
    /// Returns `Ok(())` on success.
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

    /// Get a single URL result and fail if unsuccessful.
    ///
    /// This is a shortcut to regular [`batch`](Self::batch) for simple use
    /// cases. If there is any problem generating a thumbnail this will result
    /// in an error, instead of a placeholder [`ResultData`].
    ///
    /// Individual results can get the same effect by checking
    /// `result.status == status::SUCCESS`.
    ///
    /// This call waits for the result to complete before returning.
    ///
    /// See <https://thumbrella.dev/docs/api/batch.html> for server details.
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

    /// Generate multiple thumbnail results.
    ///
    /// Generate a list of [`ResultData`] values for the given URLs. The
    /// returned results are provided in the same order as the input URLs.
    ///
    /// This call waits for all results to complete before returning. For
    /// incremental results, see the [`stream`](Self::stream) method.
    ///
    /// This call won't return errors for individual URL failures. On errors,
    /// results will be marked with a failure status, but will still contain
    /// placeholder thumbnails.
    ///
    /// See <https://thumbrella.dev/docs/api/batch.html> for server details.
    pub async fn batch(&self, urls: &[&str]) -> Result<Vec<ResultData>, Error> {
        let (mut done, stale_items) = self.preflight(urls);

        if stale_items.is_empty() {
            return Ok(self.collect_results(urls, &done, |url| {
                let mut r = ResultData::new(url.to_string());
                r.set_client_error("no result");
                r
            }));
        }

        self.backoff.check(&self.host)?;

        // Split into server-sized chunks.
        for chunk in stale_items.chunks(BATCH_MAX_ITEMS) {
            let body = serde_json::json!({ "items": chunk });
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
                for cache in &self.caches {
                    cache.put(&item.media);
                }
                done.insert(item.url.clone(), item);
            }
        }

        Ok(self.collect_results(urls, &done, |url| {
            let mut r = ResultData::new(url.to_string());
            r.set_client_error("no result from server");
            r
        }))
    }

    /// Stream thumbnail results as they complete.
    ///
    /// Yields [`ResultData`] values as the server produces them, so callers can
    /// show placeholders and intermediate results while slower thumbnails are
    /// still rendering. Every URL will receive at least one result, on success
    /// or failure. Some media also receive intermediate results while they are
    /// being processed, which can be detected by checking
    /// `result.status == status::INTERMEDIATE`.
    ///
    /// Individual failures are reported as results with a failure status, never
    /// as stream errors. URLs are automatically split into server-sized chunks
    /// to respect the server's per-request item limit.
    ///
    /// The returned stream borrows the client and the URL slice, so both must
    /// outlive the stream.
    ///
    /// ```no_run
    /// # async fn example() -> Result<(), thumbrella_client::Error> {
    /// # use futures_util::{pin_mut, StreamExt};
    /// let tbr = thumbrella_client::Client::new(None);
    /// let urls = ["https://example.com/a.jpg", "https://example.com/b.png"];
    /// let stream = tbr.stream(&urls);
    /// pin_mut!(stream);
    /// while let Some(result) = stream.next().await {
    ///     println!("{} {}", result.url, result.status);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub fn stream<'a, 'u>(
        &'a self,
        urls: &'u [&'u str],
    ) -> impl Stream<Item = ResultData> + 'u
    where
        'a: 'u,
    {
        stream! {
            let urls: Vec<String> = urls.iter().map(|s| s.to_string()).collect();
            let url_refs: Vec<&str> = urls.iter().map(String::as_str).collect();
            let (done, stale) = self.preflight(&url_refs);

            // Resolved (cached or invalid) results first, in input order.
            for url in &urls {
                if let Some(r) = done.get(url) {
                    yield r.clone();
                }
            }

            if stale.is_empty() {
                // nothing left to do
            } else if let Err(e) = self.backoff.check(&self.host) {
                for item in &stale {
                    let url = item["url"].as_str().unwrap_or("").to_string();
                    let mut r = ResultData::new(url);
                    r.set_client_error(&e.to_string());
                    yield r;
                }
            } else {
                for chunk in stale.chunks(BATCH_MAX_ITEMS) {
                    let mut pending: HashSet<String> = chunk
                        .iter()
                        .map(|item| item["url"].as_str().unwrap_or("").to_string())
                        .collect();

                    let body = serde_json::json!({ "items": chunk });
                    let resp = match self.stream_request("POST", "/batch")
                        .header("Accept", "application/x-ndjson")
                        .json(&body)
                        .send()
                        .await
                    {
                        Ok(r) => r,
                        Err(e) => {
                            for url in pending.drain() {
                                let mut r = ResultData::new(url);
                                r.set_client_error(&format!("server unreachable: {e}"));
                                yield r;
                            }
                            continue;
                        }
                    };

                    let code = resp.status().as_u16();
                    self.backoff.record(&self.host, code == 429 || code == 503);

                    if !resp.status().is_success() {
                        for url in pending.drain() {
                            let mut r = ResultData::new(url);
                            r.set_client_error(&format!("server returned {code}"));
                            yield r;
                        }
                        continue;
                    }

                    // Read the NDJSON response body incrementally, yielding
                    // each result as its line arrives.
                    let mut buf: Vec<u8> = Vec::new();
                    let mut body_stream = resp.bytes_stream();
                    loop {
                        let chunk = match StreamExt::next(&mut body_stream).await {
                            Some(Ok(c)) => c,
                            Some(Err(_)) | None => break,
                        };
                        buf.extend_from_slice(&chunk);
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let text = String::from_utf8_lossy(&line);
                            let text = text.trim();
                            if text.is_empty() {
                                continue;
                            }
                            if let Ok(result) = serde_json::from_str::<ResultData>(text)
                                && let Some(r) = self.finish_stream_result(result, &mut pending) {
                                    yield r;
                            }
                        }
                    }

                    // Flush any trailing line without a final newline.
                    if !buf.is_empty() {
                        let text = String::from_utf8_lossy(&buf);
                        let text = text.trim();
                        if !text.is_empty()
                            && let Ok(result) = serde_json::from_str::<ResultData>(text)
                            && let Some(r) = self.finish_stream_result(result, &mut pending) {
                                yield r;
                        }
                    }

                    // Anything still pending never completed; the connection
                    // was interrupted before the server sent its result.
                    for url in pending.drain() {
                        let mut r = ResultData::new(url);
                        r.set_client_error("stream connection lost");
                        yield r;
                    }
                }
            }
        }
    }

    //  helpers 

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

    /// Check caches and validate URLs, without making any server calls.
    ///
    /// Returns `(done, stale)`: `done` maps each URL resolved locally (invalid
    /// URL or fresh cache entry) to its result, and `stale` holds the request
    /// items that still need a server call.
    fn preflight(
        &self,
        urls: &[&str],
    ) -> (HashMap<String, ResultData>, Vec<serde_json::Value>) {
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
                if let Some(cached) = cache.get(url)
                    && cached.is_fresh() {
                        let mut r = ResultData::new(url.to_string());
                        r.status = status::SUCCESS.to_string();
                        r.source = Some(source::CACHE.to_string());
                        r.media = cached.clone();
                        done.insert(url.to_string(), r);
                        fresh = true;
                        break;
                    }
            }
            if fresh {
                continue;
            }

            let mut item = serde_json::json!({ "url": url });
            for cache in &self.caches {
                if let Some(cached) = cache.get(url) && !cached.cache.is_empty() {
                    item["cache"] = serde_json::Value::String(cached.cache.clone());
                    break;
                }
            }
            stale_items.push(item);
        }

        (done, stale_items)
    }

    /// Finalize a single result parsed from an NDJSON stream line.
    ///
    /// Drops intermediate results out of `pending` tracking, stores any media
    /// in the attached caches, and returns the result to yield.
    fn finish_stream_result(
        &self,
        result: ResultData,
        pending: &mut HashSet<String>,
    ) -> Option<ResultData> {
        if result.url.is_empty() {
            return None;
        }
        if result.status != status::INTERMEDIATE {
            pending.remove(&result.url);
        }
        for cache in &self.caches {
            cache.put(&result.media);
        }
        Some(result)
    }

    fn build_request(
        &self,
        client: &HttpClient,
        method: &str,
        path: &str,
    ) -> reqwest::RequestBuilder {
        let url = format!("{}{path}", self.base_url);
        client.request(method.parse().unwrap(), &url)
    }

    /// Low-level HTTP request builder (bounded total timeout).
    pub fn request(
        &self,
        method: &str,
        path: &str,
    ) -> reqwest::RequestBuilder {
        self.build_request(&self.http, method, path)
    }

    /// Low-level HTTP request builder for streaming responses.
    ///
    /// Uses a client with connect and read timeouts instead of a total
    /// timeout, so long-running NDJSON responses are not cut short.
    fn stream_request(&self, method: &str, path: &str) -> reqwest::RequestBuilder {
        self.build_request(&self.stream_http, method, path)
    }
}
