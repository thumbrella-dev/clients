import asyncio
import time
import unittest
from unittest.mock import AsyncMock, patch

from thumbrella import Client, Media, MemoryCache, Source
from thumbrella.cache import canonical_url
from thumbrella.client import _preflight_urls, _result_from_server


class CacheTests(unittest.TestCase):
    def test_canonical_keys(self):
        for raw, expected in [
            ("HTTPS://MEDIA.test/a?size=large&TOKEN=one#part", "https://media.test/a?size=large"),
            ("https://media.test/a?X-Amz-Signature=a&X-Amz-Date=b&v=2", "https://media.test/a?v=2"),
            ("https://media.test/a?X-Goog-Credential=a&X-Goog-Expires=1&v=2", "https://media.test/a?v=2"),
            ("https://media.test/a?AWSAccessKeyId=a&Signature=b&Expires=1", "https://media.test/a"),
            ("https://media.test/a?sv=1&sp=r&sig=a&se=tomorrow&width=2", "https://media.test/a?width=2"),
            ("https://media.test/a?sv=1&width=2", "https://media.test/a?sv=1&width=2"),
            ("https://media.test/a?token=a&token=b&v=2&v=3&empty=", "https://media.test/a?v=2&v=3&empty="),
            ("https://media.test/a?%74oken=a&v=2", "https://media.test/a?v=2"),
            ("https://media.test/a?b=2&a=1", "https://media.test/a?b=2&a=1"),
            ("https://media.test/a?q=a%20b&token=one", "https://media.test/a?q=a+b"),
            ("https://media.test/a?q=a%20b", "https://media.test/a?q=a+b"),
            ("https://MEDIA.test:443?token=one", "https://media.test/"),
            ("file:///tmp/a?token=keep#part", "file:///tmp/a?token=keep#part"),
            ("/tmp/a?token=keep", "/tmp/a?token=keep"),
            ("https://[invalid", "https://[invalid"),
            ("https://media.test:invalid/a", "https://media.test:invalid/a"),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(canonical_url(raw), expected)
                self.assertEqual(canonical_url(canonical_url(raw)), expected)

    def test_memory_cache_lookup_and_removal(self):
        cache = MemoryCache()
        media = Media({"url": "https://media.test/a?v=2&token=one"})
        cache.put(media)
        self.assertIs(cache.get("https://media.test/a?v=2&token=two"), media)
        self.assertIsNone(cache.get("https://media.test/a?v=3"))
        cache.remove("https://media.test/a?v=2&token=three")
        self.assertEqual(len(cache), 0)

    def test_batch_and_stream_keep_full_urls_and_revalidation_hints(self):
        first = "https://media.test/a?v=2&token=one#part"
        second = "https://media.test/a?v=2&token=two"
        different = "https://media.test/a?v=3&token=three"
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                client = Client("https://server.test")
                client._asession = AsyncMock()
                requests = []
                token = f"{int(time.time()) + 3600:x}:test"
                revalidate = False

                def response(*args, **kwargs):
                    items = kwargs["json"]["items"]
                    requests.append(items)
                    return {"items": [{
                        "url": item["url"], "status": "success",
                        "source": Source.NOT_MODIFIED if revalidate else Source.RENDER,
                        **({} if revalidate else {"media": {
                            "url": "https://media.test/a", "cache": token,
                            "thumbnail": "AQID", "properties": {"width": 42},
                        }}),
                    } for item in items]}

                async def ndjson(*args, **kwargs):
                    for item in response(*args, **kwargs)["items"]:
                        yield item

                async def run():
                    async def thumb(url):
                        if streaming:
                            return [result async for result in client.stream([url])][0]
                        return client.thumb(url)

                    nonlocal token, revalidate
                    try:
                        rendered = await thumb(first)
                        hit = await thumb(second)
                        self.assertEqual(rendered.url, first)
                        self.assertEqual(hit.url, second)
                        self.assertEqual(requests, [[{"url": first}]])
                        self.assertIs(hit.media, rendered.media)
                        self.assertEqual(hit.media.thumbnail.bytes, b"\x01\x02\x03")
                        self.assertEqual(hit.media.properties, {"width": 42})
                        await thumb(different)
                        self.assertEqual(requests[-1], [{"url": different}])
                        client.reset_caches()
                        token = "1:stale"
                        stale = await thumb(first)
                        revalidate = True
                        checked = await thumb(second)
                        self.assertEqual(requests[-1], [{"url": second, "cache": token}])
                        self.assertEqual(checked.source, Source.NOT_MODIFIED)
                        self.assertIs(checked.media, stale.media)
                    finally:
                        await client.close()
                        client.session.close()

                with patch("thumbrella.client.requests_json", side_effect=response), \
                        patch("thumbrella.client.aio_ndjson", side_effect=ndjson):
                    asyncio.run(run())

    def test_custom_caches_receive_canonical_keys_without_mutating_media(self):
        class ExactCache:
            def __init__(self):
                self.store = {}
                self.lookups = []

            def get(self, url):
                self.lookups.append(url)
                return self.store.get(url)

            def put(self, media):
                self.store[media.url] = media

        cache = ExactCache()
        first = "https://media.test/a?v=2&token=one"
        second = "https://media.test/a?v=2&token=two"
        result = _result_from_server(
            {"url": first, "status": "success", "media": {
                "url": "https://media.test/a", "cache": f"{int(time.time()) + 3600:x}:test",
            }},
            caches=[cache], server_key="server", request_url="https://server.test/batch",
        )
        self.assertEqual(result.media.url, "https://media.test/a")
        self.assertEqual(list(cache.store), ["https://media.test/a?v=2"])
        done, stale = _preflight_urls([second], [cache])
        self.assertEqual(stale, [])
        self.assertEqual(done[second].url, second)
        self.assertEqual(cache.lookups, ["https://media.test/a?v=2"])
