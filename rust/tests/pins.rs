use futures_util::{StreamExt, pin_mut};
use std::io::{Read, Write};
use std::net::TcpListener;
use thumbrella_client::Client;

#[tokio::test]
async fn batch_and_stream_resolve_pins_and_accept_old_servers() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for streaming in [false, true] {
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
            assert!(headers.starts_with("POST /api/batch "));
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
            let items = [
                serde_json::json!({"url": "https://media.test/a", "status": "success", "pin": "pin/i123456789012.jpeg"}),
                serde_json::json!({"url": "https://media.test/b", "status": "success", "pin": null}),
                serde_json::json!({"url": "https://media.test/c", "status": "success"}),
            ];
            let body = if streaming {
                items.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n")
            } else {
                serde_json::json!({"items": items}).to_string()
            };
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    let client = Client::with_caches(Some(&format!("{base}/api")), vec![]);
    let urls = [
        "https://media.test/a",
        "https://media.test/b",
        "https://media.test/c",
    ];
    let batch = client.batch(&urls).await.unwrap();
    let stream = client.stream(&urls);
    pin_mut!(stream);
    let streamed: Vec<_> = stream.collect().await;
    for results in [batch, streamed] {
        assert_eq!(
            results[0].pin.as_deref(),
            Some(format!("{base}/api/pin/i123456789012.jpeg").as_str())
        );
        assert!(results[1].pin.is_none());
        assert!(results[2].pin.is_none());
    }
    server.join().unwrap();
}
