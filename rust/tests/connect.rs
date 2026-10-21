use thumbrella_client::{Client, Error};

#[test]
fn full_connect_string_is_preserved() {
    let connect = "https://server.test/,x-custom=value";
    let client = Client::new(Some(connect));
    assert_eq!(client.connect(), connect);
    assert_eq!(client.base_url(), "https://server.test");
    let token = Client::new(Some("tbr_a_test"));
    assert_eq!(token.connect(), "tbr_a_test");
    assert_eq!(token.base_url(), "https://cloud.thumbrella.dev");
}

#[test]
fn omitted_connect_uses_defaults() {
    let expected = std::env::var("TBR_CONNECT")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://cloud.thumbrella.dev".into());
    assert_eq!(Client::new(None).connect(), expected);
}

#[tokio::test]
async fn empty_connect_fails_without_request() {
    use futures_util::FutureExt;

    for connect in ["", " \t\n"] {
        let client = Client::new(Some(connect));
        assert_eq!(client.connect(), connect);
        let result = client.verify().now_or_never().expect("verification must finish without I/O");
        assert!(
            matches!(result, Err(Error::Verify(message)) if message == "Connection string is empty")
        );
    }
}

#[cfg(feature = "blocking")]
#[test]
fn blocking_client_exposes_connect_and_rejects_empty() {
    for connect in ["", " \t\n"] {
        let client = thumbrella_client::blocking::Client::new(Some(connect));
        assert_eq!(client.connect(), connect);
        assert!(
            matches!(client.verify(), Err(Error::Verify(message)) if message == "Connection string is empty")
        );
    }
    let client = thumbrella_client::blocking::Client::new(Some("https://server.test"));
    assert_eq!(client.connect(), "https://server.test");
}
