use futures_util::StreamExt;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{SystemTime, UNIX_EPOCH};
use thumbrella_client::{
    Client, Media, MemoryCache, ResultData, Thumbnail, media_from_caches, put_all_caches, source,
    status,
};

const URL: &str = "https://media.test/image.svg?signature=first";

fn server(item: Value, streaming: bool, cached: bool) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
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
        assert!(headers.starts_with("POST /batch "));
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
        let payload: Value = serde_json::from_slice(&request[header_end..header_end + length]).unwrap();
        assert_eq!(payload["items"][0]["url"], URL);
        assert_eq!(payload["items"][0]["cache"], if cached { json!("1:old") } else { Value::Null });
        let body = if streaming {
            format!("{item}\n")
        } else {
            json!({"items": [item]}).to_string()
        };
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        )
        .unwrap();
    });
    (base, thread)
}

fn cached_media() -> Media {
    Media {
        url: URL.split('?').next().unwrap().into(),
        cache: "1:old".into(),
        thumbnail: Thumbnail::from(b"ABC".to_vec()),
        placeholder: "vector".into(),
        mime: "image/svg+xml".into(),
        kind: "image".into(),
        extension: "svg".into(),
        file_size: 1234,
        properties: json!({"width": 640}),
    }
}

async fn results(client: &Client, url: &str, streaming: bool) -> Vec<ResultData> {
    let urls = [url];
    if streaming {
        client.stream(&urls).collect().await
    } else {
        client.batch(&urls).await.unwrap()
    }
}

#[tokio::test]
async fn not_modified_preserves_metadata_and_adopts_only_explicit_tokens() {
    let epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() + 3600;
    let renewed = format!("{epoch:x}:new");
    for streaming in [false, true] {
        for server_media in [
            None,
            Some(Value::Null),
            Some(json!({"url": ""})),
            Some(json!({"url": "", "cache": ""})),
            Some(json!({
                "url": "", "cache": renewed, "thumbnail": "", "placeholder": "",
                "mime": "", "kind": "", "extension": "", "file_size": 0, "properties": {},
            })),
        ] {
            let token = server_media.as_ref().and_then(|m| m.get("cache")).and_then(Value::as_str);
            let mut item = json!({
                "url": URL, "status": "success", "source": "not_modified", "pin": "pin/example.jpeg",
            });
            if let Some(media) = &server_media {
                item["media"] = media.clone();
            }
            let (base, thread) = server(item, streaming, true);
            let client = Client::with_caches(
                Some(&base),
                vec![
                    Box::new(MemoryCache::default()),
                    Box::new(MemoryCache::default()),
                ],
            );
            let original = cached_media();
            put_all_caches(client.caches(), URL, &original);
            let result = results(&client, URL, streaming).await.remove(0);
            thread.join().unwrap();
            assert_eq!(result.status, status::SUCCESS);
            assert_eq!(result.media.cache, token.unwrap_or("1:old"));
            assert_eq!(result.media.thumbnail, original.thumbnail);
            assert_eq!(result.media.url, original.url);
            assert_eq!(result.media.placeholder, original.placeholder);
            assert_eq!(result.media.mime, original.mime);
            assert_eq!(result.media.kind, original.kind);
            assert_eq!(result.media.extension, original.extension);
            assert_eq!(result.media.file_size, original.file_size);
            assert_eq!(result.media.properties, original.properties);
            assert_eq!(result.pin.as_deref(), Some(format!("{base}/pin/example.jpeg").as_str()));
            for cache in client.caches() {
                let stored = cache.get(URL.split('?').next().unwrap());
                if token == Some("") {
                    assert!(stored.is_none(), "empty token must evict every cache");
                } else {
                    assert_eq!(stored.unwrap().cache, token.unwrap_or("1:old"));
                }
            }
            if token == Some(renewed.as_str()) {
                assert!(result.is_fresh());
                let variant = URL.replace("first", "second");
                // The listener has closed: any regression that sends another request fails.
                for next_streaming in [false, true] {
                    let hit = results(&client, &variant, next_streaming).await.remove(0);
                    assert_eq!(hit.source.as_deref(), Some(source::CACHE));
                    assert_eq!(hit.media.cache, renewed);
                }
            }
        }
    }
}

#[tokio::test]
async fn not_modified_without_cached_media_does_not_seed_caches() {
    for streaming in [false, true] {
        for media in [None, Some(json!({"url": "", "cache": "1:server"}))] {
            let mut item = json!({"url": URL, "status": "success", "source": "not_modified"});
            if let Some(media) = media {
                item["media"] = media;
            }
            let (base, thread) = server(item, streaming, false);
            let client = Client::new(Some(&base));
            let result = results(&client, URL, streaming).await.remove(0);
            thread.join().unwrap();
            assert_eq!(result.source.as_deref(), Some(source::NOT_MODIFIED));
            assert!(media_from_caches(client.caches(), URL).is_none());
        }
    }
}
