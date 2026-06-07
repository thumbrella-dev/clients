//! Blocking (synchronous) client — gated behind the `blocking` feature.

use crate::client::Client as AsyncClient;
use crate::types::{Error, ResultData};

/// Synchronous Thumbrella client — wraps the async client with a tokio
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

    pub fn thumb(&self, url: &str) -> Result<ResultData, Error> {
        self.rt.block_on(self.inner.thumb(url))
    }

    pub fn batch(&self, urls: &[&str]) -> Result<Vec<ResultData>, Error> {
        self.rt.block_on(self.inner.batch(urls))
    }

    pub fn stream(&self, urls: &[&str]) -> Result<Vec<ResultData>, Error> {
        self.rt.block_on(self.inner.stream(urls))
    }

    pub fn base_url(&self) -> &str {
        self.inner.base_url()
    }
}
