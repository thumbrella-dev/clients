use std::io::{Read, Write};
use std::net::TcpListener;

use thumbrella_client::{Client, ThumbRequest, ThumbRequestItem};

#[tokio::test]
async fn batch_sends_and_echoes_caller_keys() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let url = "https://media.test/avatar.png?signature=one";
    let canonical = "https://media.test/avatar.png";

    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        let mut request = Vec::new();
        let mut buf = [0; 1024];
        let header_end = loop {
            let read = socket.read(&mut buf).unwrap();
            assert!(read > 0);
            request.extend_from_slice(&buf[..read]);
            if let Some(pos) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let length: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
            })
            .unwrap();
        while request.len() < header_end + length {
            let read = socket.read(&mut buf).unwrap();
            assert!(read > 0);
            request.extend_from_slice(&buf[..read]);
        }
        let payload: serde_json::Value =
            serde_json::from_slice(&request[header_end..header_end + length]).unwrap();
        assert_eq!(payload["items"][0]["key"], "avatar/1");
        assert_eq!(payload["items"][0]["future_option"], 7);
        assert_eq!(payload["items"][1]["key"], "avatar/2");
        assert_eq!(payload["items"][2]["url"], url);
        assert!(payload["items"][2].get("key").is_none());

        let items = [
            serde_json::json!({"key": "avatar/1", "url": url, "status": "success", "media": {"url": canonical}}),
            serde_json::json!({"key": "avatar/2", "url": url, "status": "success", "media": {"url": canonical}}),
            serde_json::json!({"key": canonical, "url": url, "status": "success", "media": {"url": canonical}}),
        ];
        let body = serde_json::json!({ "items": items }).to_string();
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });

    let client = Client::with_caches(Some(&format!("{base}/api")), vec![]);
    let results = client
        .batch([
            ThumbRequest::from(
                ThumbRequestItem::new(url).with_key("avatar/1").with_option("future_option", 7),
            ),
            ThumbRequest::keyed(url, "avatar/2"),
            ThumbRequest::url(url),
        ])
        .await
        .unwrap();

    assert_eq!(results.len(), 3);
    assert_eq!(
        results.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        ["avatar/1", "avatar/2", canonical]
    );
    assert!(results.iter().all(|r| r.url == url));
    server.join().unwrap();
}

#[test]
fn request_identity_prefers_the_caller_key() {
    let url = "https://EXAMPLE.com/A.PNG?signature=one#frag";
    let plain = ThumbRequest::url(url);
    assert_eq!(plain.identity().as_ref(), "https://example.com/A.PNG");

    let keyed = ThumbRequest::keyed(url, "avatar/1");
    assert_eq!(keyed.identity().as_ref(), "avatar/1");

    let from_slice: ThumbRequest = (&"https://example.com/a.png").into();
    assert_eq!(from_slice.as_url(), "https://example.com/a.png");
}
