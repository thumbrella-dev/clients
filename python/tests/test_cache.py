import asyncio
import time
import unittest
from unittest.mock import patch

from thumbrella import Client, Media, MemoryCache, Result
from thumbrella.cache import media_from_caches, put_all_caches, remove_from_caches
from thumbrella.client import _result_from_server
from thumbrella.constants import Source, Status


class CacheKeyTests(unittest.TestCase):
    def test_signed_variants_share_one_entry(self):
        a = "https://CDN.Example.com/path/File.JPG?X-Amz-Signature=aaa#frag"
        b = "https://cdn.example.com/path/File.JPG?X-Amz-Signature=bbb"
        cache = MemoryCache()
        media = Media({"url": a, "cache": "1:tok"})

        put_all_caches([cache], a, media)
        self.assertEqual(len(cache), 1)
        self.assertIs(media_from_caches([cache], b), media)

        remove_from_caches([cache], b)
        self.assertEqual(len(cache), 0)

    def test_non_http_urls_are_used_unchanged(self):
        cache = MemoryCache()
        url = "/local/path/file.jpeg"
        media = Media({"url": url})

        put_all_caches([cache], url, media)
        self.assertIs(media_from_caches([cache], url), media)

    def test_intermediate_frames_are_not_cached(self):
        cache = MemoryCache()
        url = "https://media.test/pic.svg?X-Amz-Signature=abc"

        _result_from_server(
            {
                "url": url,
                "status": Status.INTERMEDIATE,
                "media": {"thumbnail": "", "placeholder": "vector"},
            },
            caches=[cache],
            server_key="server",
            request_url="https://server.test/batch",
        )
        self.assertEqual(len(cache), 0)

        _result_from_server(
            {
                "url": url,
                "status": Status.SUCCESS,
                "media": {"thumbnail": "REVGRw==", "cache": "1:tok"},
            },
            caches=[cache],
            server_key="server",
            request_url="https://server.test/batch",
        )
        self.assertEqual(len(cache), 1)
        cached = media_from_caches([cache], url)
        self.assertIsNotNone(cached)
        self.assertEqual(cached.thumbnail.bytes, b"DEFG")

    def test_failed_thumbnail_is_shared(self):
        a = Result.client_fail("https://a.test/x.jpg", "boom")
        b = Result.client_fail("https://b.test/y.jpg", "boom")
        self.assertIs(a.media.thumbnail, b.media.thumbnail)
        self.assertEqual(len(a.media.thumbnail.bytes), 2593)


class RevalidationTests(unittest.TestCase):
    url = "https://media.test/image.svg?signature=first"

    def cached_media(self):
        return Media({
            "url": self.url.split("?")[0], "cache": "1:old", "thumbnail": "QUJD",
            "placeholder": "vector", "mime": "image/svg+xml", "kind": "image",
            "extension": "svg", "file_size": 1234, "properties": {"width": 640},
        })

    def response(self, **extra):
        return {
            "url": self.url, "status": Status.SUCCESS,
            "source": Source.NOT_MODIFIED, "pin": "pin/example.jpeg", **extra,
        }

    def parse(self, item, caches):
        return _result_from_server(
            item, caches=caches, server_key="server",
            request_url="https://server.test/api/batch",
        )

    def test_renewed_token_preserves_bytes_metadata_and_identity(self):
        caches = [MemoryCache(), MemoryCache()]
        original = self.cached_media()
        put_all_caches(caches, self.url, original)
        renewed = f"{int(time.time()) + 3600:x}:new"
        result = self.parse(self.response(media={
            "cache": renewed, "thumbnail": "", "placeholder": "", "mime": "",
            "kind": "", "extension": "", "file_size": 0, "properties": {},
        }), caches)
        self.assertIs(result.media, original)
        self.assertEqual(result.media.cache, renewed)
        self.assertTrue(result.media.is_fresh())
        self.assertEqual(result.media.thumbnail.bytes, b"ABC")
        self.assertEqual(result.media.placeholder, "vector")
        self.assertEqual(result.media.mime, "image/svg+xml")
        self.assertEqual(result.media.kind, "image")
        self.assertEqual(result.media.extension, "svg")
        self.assertEqual(result.media.file_size, 1234)
        self.assertEqual(result.media.properties, {"width": 640})
        self.assertEqual(result.pin, "https://server.test/api/pin/example.jpeg")
        for cache in caches:
            self.assertIs(media_from_caches([cache], self.url), original)
            self.assertEqual(media_from_caches([cache], self.url).cache, renewed)

    def test_missing_token_preserves_old_and_empty_token_evicts(self):
        for extra in ({}, {"media": None}, {"media": {}}, {"media": {"cache": ""}}):
            with self.subTest(extra=extra):
                caches = [MemoryCache(), MemoryCache()]
                original = self.cached_media()
                put_all_caches(caches, self.url, original)
                result = self.parse(self.response(**extra), caches)
                empty = extra == {"media": {"cache": ""}}
                self.assertIs(result.media, original)
                self.assertEqual(result.media.cache, "" if empty else "1:old")
                self.assertEqual(result.media.placeholder, "vector")
                self.assertEqual(result.media.thumbnail.bytes, b"ABC")
                for cache in caches:
                    if empty:
                        self.assertIsNone(media_from_caches([cache], self.url))
                    else:
                        self.assertIs(media_from_caches([cache], self.url), original)

    def test_missing_cached_media_does_not_seed_cache(self):
        for extra in ({}, {"media": {"cache": "1:server"}}):
            with self.subTest(extra=extra):
                caches = [MemoryCache(), MemoryCache()]
                item = self.response(**extra)
                result = self.parse(item, caches)
                self.assertEqual(result.raw, item)
                self.assertEqual(result.pin, "https://server.test/api/pin/example.jpeg")
                self.assertTrue(all(len(cache) == 0 for cache in caches))

    def test_batch_and_stream_renewal_prevents_further_requests(self):
        renewed = f"{int(time.time()) + 3600:x}:new"
        item = self.response(media={"cache": renewed})
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                caches = [MemoryCache()]
                put_all_caches(caches, self.url, self.cached_media())
                client = Client("https://server.test/api", caches=caches)

                async def ndjson(*args, **kwargs):
                    yield item

                async def collect(url):
                    async with client:
                        return [result async for result in client.stream([url])]

                try:
                    with patch("thumbrella.client.requests_json", return_value={"items": [item]}) as batch, \
                         patch("thumbrella.client.aio_ndjson", side_effect=ndjson) as stream:
                        results = asyncio.run(collect(self.url)) if streaming else client.batch([self.url])
                        self.assertTrue(results[0].media.is_fresh())
                        variant = self.url.replace("first", "second")
                        self.assertIs(client.batch([variant])[0].media, results[0].media)
                        self.assertIs(asyncio.run(collect(variant))[0].media, results[0].media)
                        self.assertEqual(batch.call_count + stream.call_count, 1)
                finally:
                    client.session.close()


if __name__ == "__main__":
    unittest.main()
