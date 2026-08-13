import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class _FakeRoutes:
    def get(self, _path):
        return lambda function: function

    post = get
    delete = get


sys.modules["server"] = types.SimpleNamespace(
    PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=_FakeRoutes()))
)

from backend import routes  # noqa: E402


class _Request:
    def __init__(self, *, query=None, match_info=None, body=None):
        self.query = query or {}
        self.match_info = match_info or {}
        self._body = body

    async def json(self):
        return self._body

    async def multipart(self):
        return object()


class RouteStabilityTests(unittest.IsolatedAsyncioTestCase):
    session_id = "11111111-2222-4333-8444-555555555555"

    def setUp(self):
        routes.STATE["active_request_id"] = None
        routes.GENERATION_CACHE.clear()

    def tearDown(self):
        routes.STATE["active_request_id"] = None
        routes.GENERATION_CACHE.clear()

    @staticmethod
    def payload(response):
        return json.loads(response.body.decode("utf-8"))

    async def test_destructive_media_endpoints_return_409_while_generation_is_active(self):
        routes.STATE["active_request_id"] = "request"
        requests = [
            routes.remove_media(_Request(query={"session_id": self.session_id}, match_info={"asset_id": "asset"})),
            routes.clear_media(_Request(query={"session_id": self.session_id, "mode": "Reference"})),
            routes.resample_media(_Request(match_info={"asset_id": "asset"}, body={"session_id": self.session_id})),
            routes.upload_media(_Request(query={"replace_asset_id": "asset"})),
        ]
        for response in await __import__("asyncio").gather(*requests):
            self.assertEqual(response.status, 409)
            self.assertEqual(self.payload(response)["error"]["code"], "GENERATION_BUSY")

    async def test_read_only_media_listing_remains_available_while_busy(self):
        routes.STATE["active_request_id"] = "request"
        with patch.object(routes.STORE, "list", return_value=[{"id": "asset"}]):
            response = await routes.list_media(_Request(query={"session_id": self.session_id}))
        self.assertEqual(response.status, 200)
        self.assertEqual(self.payload(response)["assets"], [{"id": "asset"}])

    async def test_read_only_media_content_remains_available_while_busy(self):
        routes.STATE["active_request_id"] = "request"
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "original.png"
            original.touch()
            with patch.object(routes.STORE, "get", return_value={"_original_path": str(original)}):
                response = await routes.media_content(_Request(
                    query={"session_id": self.session_id},
                    match_info={"asset_id": "asset"},
                ))
        self.assertEqual(response.status, 200)

    async def test_mode_clear_invalidates_only_its_generation_cache_entry(self):
        reference_key = (self.session_id, "Reference")
        text_key = (self.session_id, "T2VA")
        routes.GENERATION_CACHE.update({reference_key: {"prompt": "reference"}, text_key: {"prompt": "text"}})
        with patch.object(routes.STORE, "clear_mode", return_value=[{"id": "text-asset"}]):
            response = await routes.clear_media(_Request(query={"session_id": self.session_id, "mode": "Reference"}))
        self.assertEqual(response.status, 200)
        self.assertNotIn(reference_key, routes.GENERATION_CACHE)
        self.assertIn(text_key, routes.GENERATION_CACHE)
        self.assertEqual(self.payload(response)["assets"], [{"id": "text-asset"}])


if __name__ == "__main__":
    unittest.main()
