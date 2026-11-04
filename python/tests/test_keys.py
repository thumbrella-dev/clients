import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from thumbrella import Client, MemoryCache
from thumbrella.cache import media_from_caches, put_all_caches
from thumbrella.client import _result_from_server
from thumbrella.result import Media


class KeyTests(unittest.TestCase):
    def test_result_reports_effective_key(self):
        result = _result_from_server(
            {"key": "avatar/1", "url": "https://media.test/a.png", "status": "success"},
            caches=[], server_key="server",
            request_url="https://server.test/batch",
        )
        self.assertEqual(result.key, "avatar/1")
        # Older servers omit the key.
        legacy = _result_from_server(
            {"url": "https://media.test/a.png"},
            caches=[], server_key="server",
            request_url="https://server.test/batch",
        )
        self.assertEqual(legacy.key, "")

    def test_caller_key_controls_the_cache_entry(self):
        url = "https://media.test/avatar.png?signature=one"
        cache = MemoryCache()
        media = Media({"url": url, "cache": "1:tok"})

        put_all_caches([cache], url, media, "avatar/1")
        self.assertEqual(len(cache), 1)
        self.assertIsNotNone(media_from_caches([cache], url, "avatar/1"))
        self.assertIsNone(media_from_caches([cache], url, "avatar/2"))
        self.assertIsNone(media_from_caches([cache], url))

    def test_batch_and_stream_send_keys_and_echo_them(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.extend(body["items"])
                items = []
                for item in body["items"]:
                    canonical = item["url"].split("?")[0]
                    items.append({
                        "key": item.get("key") or canonical,
                        "url": item["url"],
                        "status": "success",
                        "media": {"url": canonical},
                    })
                streaming = self.headers["Accept"] == "application/x-ndjson"
                data = (
                    "\n".join(json.dumps(item) for item in items)
                    if streaming else json.dumps({"items": items})
                ).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        url = "https://media.test/avatar.png?signature=one"
        canonical = "https://media.test/avatar.png"
        requests = [
            {"url": url, "key": "avatar/1", "future_option": 7},
            {"url": url, "key": "avatar/2"},
            url,
        ]
        client = Client(base, caches=[])
        try:
            async def streamed():
                async with client:
                    return [result async for result in client.stream(requests)]

            for results in [client.batch(requests), asyncio.run(streamed())]:
                self.assertEqual(
                    [result.key for result in results],
                    ["avatar/1", "avatar/2", canonical],
                )
                self.assertEqual(
                    [result.url for result in results],
                    [url, url, url],
                )
        finally:
            client.session.close()
            server.shutdown()
            server.server_close()
            thread.join()

        self.assertEqual(
            seen,
            [
                {"url": url, "key": "avatar/1", "future_option": 7},
                {"url": url, "key": "avatar/2"},
                {"url": url},
                {"url": url, "key": "avatar/1", "future_option": 7},
                {"url": url, "key": "avatar/2"},
                {"url": url},
            ],
        )


if __name__ == "__main__":
    unittest.main()
