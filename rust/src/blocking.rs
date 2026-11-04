//! Blocking (synchronous) client, gated behind the `blocking` feature.

use crate::client::Client as AsyncClient;
use crate::types::{Error, ResultData, ThumbRequest};

/// Synchronous Thumbrella client, wraps the async client with a tokio
/// runtime so callers never see `.await`.
pub struct Client {
    inner: AsyncClient,
    rt: tokio::runtime::Runtime,
}

impl Client {
    pub fn new(connect: Option<&str>) -> Self {
        Self {
            inner: AsyncClient::new(connect),
            rt: tokio::runtime::Runtime::new().expect("tokio runtime"),
        }
    }

    pub fn verify(&self) -> Result<(), Error> {
        self.rt.block_on(self.inner.verify())
    }

    pub fn thumb(&self, request: impl Into<ThumbRequest>) -> Result<ResultData, Error> {
        self.rt.block_on(self.inner.thumb(request))
    }

    pub fn batch<I, R>(&self, requests: I) -> Result<Vec<ResultData>, Error>
    where
        I: IntoIterator<Item = R>,
        R: Into<ThumbRequest>,
    {
        self.rt.block_on(self.inner.batch(requests))
    }

    pub fn stream<I, R>(&self, requests: I) -> Result<Vec<ResultData>, Error>
    where
        I: IntoIterator<Item = R>,
        R: Into<ThumbRequest>,
    {
        use futures_util::StreamExt;
        Ok(self.rt.block_on(async { self.inner.stream(requests).collect::<Vec<_>>().await }))
    }

    pub fn base_url(&self) -> &str {
        self.inner.base_url()
    }

    /// The full effective connection string, including tokens or custom headers.
    pub fn connect(&self) -> &str {
        self.inner.connect()
    }
}
