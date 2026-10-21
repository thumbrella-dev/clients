import os
import unittest
from unittest.mock import patch

from thumbrella import Client, VerifyError
from thumbrella.constants import DEFAULT_BASE


class ConnectTests(unittest.TestCase):
    def test_full_connect_string(self):
        connect = "https://server.test/,x-custom=value"
        client = Client(connect)
        self.assertEqual(client.connect, connect)
        self.assertEqual(client.base_url, "https://server.test")
        token = Client("tbr_a_test")
        self.assertEqual(token.connect, "tbr_a_test")
        self.assertEqual(token.base_url, DEFAULT_BASE)

    def test_omitted_connect_uses_defaults(self):
        with patch.dict(os.environ, {"TBR_CONNECT": "https://environment.test"}):
            self.assertEqual(Client().connect, "https://environment.test")
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(Client().connect, DEFAULT_BASE)

    def test_empty_connect_fails_without_request(self):
        for environment in ("", "https://environment.test"):
            with patch.dict(os.environ, {"TBR_CONNECT": environment}):
                for connect in ("", " \t\n"):
                    with self.subTest(environment=environment, connect=connect):
                        client = Client(connect)
                        self.assertEqual(client.connect, connect)
                        with patch.object(client.session, "request") as request:
                            with self.assertRaisesRegex(VerifyError, "^Connection string is empty$"):
                                client.verify()
                            request.assert_not_called()

    def test_valid_connect_still_verifies(self):
        client = Client("https://server.test")
        with patch.object(client.session, "request") as request:
            request.return_value.json.return_value = {
                "status": "ok", "thumbrella": 2, "token": True,
            }
            self.assertIs(client.verify(), client)
            request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
