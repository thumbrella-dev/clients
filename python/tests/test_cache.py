import unittest

from thumbrella import Media, MemoryCache, Result
from thumbrella.cache import media_from_caches, put_all_caches, remove_from_caches
from thumbrella.client import _result_from_server
from thumbrella.constants import Status


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


if __name__ == "__main__":
    unittest.main()
