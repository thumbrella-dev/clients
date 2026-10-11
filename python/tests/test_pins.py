import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from thumbrella import Client
from thumbrella.client import _result_from_server


class PinTests(unittest.TestCase):
    def test_resolution_preserves_raw_and_optional_pins(self):
        for pin, expected in [
            ("pin/i123456789012.jpeg", "https://server.test/api/pin/i123456789012.jpeg"),
            ("/pin/i123456789012.jpeg", "https://server.test/pin/i123456789012.jpeg"),
            ("https://other.test/pin.jpeg", "https://other.test/pin.jpeg"),
            (None, None),
        ]:
            item = {"url": "https://media.test/image.jpeg", "pin": pin}
            result = _result_from_server(
                item, caches=[], server_key="server",
                request_url="https://server.test/api/batch",
            )
            self.assertEqual(result.pin, expected)
            self.assertEqual(result.raw["pin"], pin)
        old = _result_from_server(
            {"url": "https://media.test/old.jpeg"},
            caches=[], server_key="server", request_url="https://server.test/batch",
        )
        self.assertIsNone(old.pin)

    def test_resolution_applies_to_revalidated_and_placeholder_results(self):
        for source, extra in [
            ("not_modified", {}),
            ("placeholder", {"placeholder": "image", "media": {"thumbnail": ""}}),
            ("render", {"status": "intermediate"}),
        ]:
            result = _result_from_server(
                {"url": "https://media.test/image.jpeg", "source": source,
                 "pin": "pin/i123456789012.jpeg", **extra},
                caches=[], server_key="server", request_url="https://server.test/batch",
            )
            self.assertEqual(result.pin, "https://server.test/pin/i123456789012.jpeg")

    def test_batch_and_stream(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                items = [
                    {"url": item["url"], "status": "success", **pin}
                    for item, pin in zip(body["items"], [
                        {"pin": "pin/i123456789012.jpeg"}, {"pin": None}, {},
                    ])
                ]
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
        urls = [f"https://media.test/{i}.jpeg" for i in range(3)]
        client = Client(base, caches=[])
        try:
            async def streamed():
                async with client:
                    return [result async for result in client.stream(urls)]

            for results in [client.batch(urls), asyncio.run(streamed())]:
                self.assertEqual(
                    [result.pin for result in results],
                    [base + "/pin/i123456789012.jpeg", None, None],
                )
        finally:
            client.session.close()
            server.shutdown()
            server.server_close()
            thread.join()
