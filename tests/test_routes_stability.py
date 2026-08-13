import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


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

    def reference_manifest(self):
        return {
            "session_id": self.session_id,
            "mode": "Reference",
            "assets": [{
                "id": "video-one",
                "type": "video",
                "reference": "<Video 1>",
                "filename": "video.mp4",
                "content_url": "/video",
                "frames": [],
            }],
            "counts": {"image": 0, "video": 1, "audio": 0},
            "violations": [],
            "valid": True,
        }

    def generation_body(self, brief):
        return {
            "session_id": self.session_id,
            "mode": "Reference",
            "creative_brief": brief,
            "duration_seconds": 10,
            "aspect_ratio": "16:9",
            "model_id": "ollama::test-model",
        }

    async def test_invalid_canonical_tag_stops_generate_before_provider_resolution_or_backend_calls(self):
        body = self.generation_body("Use <Video 9> for the camera motion.")
        with (
            patch.object(routes.STORE, "manifest", return_value=self.reference_manifest()),
            patch.object(routes, "_resolve_model", new_callable=AsyncMock) as resolve_model,
            patch.object(routes.OLLAMA_BACKEND, "preflight") as preflight,
            patch.object(routes.OLLAMA_BACKEND, "generate") as generate,
        ):
            response = await routes.generate(_Request(body=body))

        self.assertEqual(response.status, 400)
        self.assertEqual(self.payload(response)["error"], {
            "code": "REFERENCE_NOT_FOUND",
            "message": "<Video 9> doesn't exist. Add the reference or remove the tag from the Creative Brief.",
            "details": {"reference": "<Video 9>"},
        })
        resolve_model.assert_not_awaited()
        preflight.assert_not_called()
        generate.assert_not_called()

    async def test_invalid_canonical_tag_stops_refine_before_provider_resolution_or_backend_calls(self):
        body = {
            **self.generation_body("A restrained shot."),
            "current_prompt": "Current prompt",
            "instruction": "zibble <Audio 1> frobnitz quux",
        }
        with (
            patch.object(routes.STORE, "manifest", return_value=self.reference_manifest()),
            patch.object(routes, "_resolve_model", new_callable=AsyncMock) as resolve_model,
            patch.object(routes.OLLAMA_BACKEND, "preflight") as preflight,
            patch.object(routes.OLLAMA_BACKEND, "generate") as generate,
        ):
            response = await routes.refine(_Request(body=body))

        self.assertEqual(response.status, 400)
        self.assertEqual(self.payload(response)["error"], {
            "code": "REFERENCE_NOT_FOUND",
            "message": "<Audio 1> doesn't exist. Add the reference or remove the tag from the Revision instruction.",
            "details": {"reference": "<Audio 1>"},
        })
        resolve_model.assert_not_awaited()
        preflight.assert_not_called()
        generate.assert_not_called()

    async def test_noncanonical_reference_text_is_not_preflight_validated(self):
        body = self.generation_body("Video 9, video 9, and zibble-nine are ordinary text.")
        with (
            patch.object(routes.STORE, "manifest", return_value=self.reference_manifest()),
            patch.object(routes, "_resolve_model", new_callable=AsyncMock, return_value=None) as resolve_model,
        ):
            response = await routes.generate(_Request(body=body))

        self.assertEqual(response.status, 404)
        self.assertEqual(self.payload(response)["error"]["code"], "MODEL_NOT_FOUND")
        resolve_model.assert_awaited_once()

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
