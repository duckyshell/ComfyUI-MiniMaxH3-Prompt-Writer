import asyncio
import json
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


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


class _MultipartField:
    def __init__(self, name, *, text=None, filename=None, content=b"", content_type="application/octet-stream", on_read=None):
        self.name = name
        self.filename = filename
        self.headers = {"Content-Type": content_type}
        self._text = text
        self._chunks = [content] if content else []
        self._on_read = on_read

    async def text(self):
        return self._text or ""

    async def read_chunk(self, _size):
        chunk = self._chunks.pop(0) if self._chunks else b""
        if chunk and self._on_read:
            self._on_read()
        return chunk


class _MultipartReader:
    def __init__(self, fields):
        self._fields = list(fields)

    async def next(self):
        return self._fields.pop(0) if self._fields else None


class _MultipartRequest(_Request):
    def __init__(self, fields, *, query=None):
        super().__init__(query=query)
        self._reader = _MultipartReader(fields)

    async def multipart(self):
        return self._reader


class RouteStabilityTests(unittest.IsolatedAsyncioTestCase):
    session_id = "11111111-2222-4333-8444-555555555555"

    def setUp(self):
        routes.STATE.update({
            "phase": "idle",
            "active_request_id": None,
            "selected_model_id": None,
            "selected_model_family": None,
            "cancel_requested": False,
            "pending_unload_family": None,
            "media_mutation_active": False,
        })
        routes.GENERATION_CACHE.clear()
        routes.GENERATION_CACHE_ACCESS.clear()

    def tearDown(self):
        routes.STATE.update({
            "phase": "idle",
            "active_request_id": None,
            "selected_model_id": None,
            "selected_model_family": None,
            "cancel_requested": False,
            "pending_unload_family": None,
            "media_mutation_active": False,
        })
        routes.GENERATION_CACHE.clear()
        routes.GENERATION_CACHE_ACCESS.clear()

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

    async def test_generate_claims_busy_state_before_model_resolution_awaits(self):
        body = self.generation_body("Use <Video 1>.")
        assembled = {"input": {"duration_seconds": 10, "aspect_ratio": "16:9", "creative_brief": body["creative_brief"]}}
        resolution_started = asyncio.Event()
        allow_resolution = asyncio.Event()

        async def delayed_resolution(_body):
            resolution_started.set()
            await allow_resolution.wait()
            return None

        with (
            patch.object(routes, "assemble_request", return_value=assembled),
            patch.object(routes, "_resolve_model", side_effect=delayed_resolution) as resolve_model,
        ):
            first = asyncio.create_task(routes.generate(_Request(body=body)))
            await resolution_started.wait()
            second = await routes.generate(_Request(body=body))
            self.assertEqual(second.status, 409)
            self.assertEqual(self.payload(second)["error"]["code"], "GENERATION_BUSY")
            self.assertIsNotNone(routes.STATE["active_request_id"])
            allow_resolution.set()
            first_response = await first

        self.assertEqual(first_response.status, 404)
        self.assertEqual(resolve_model.await_count, 1)
        self.assertIsNone(routes.STATE["active_request_id"])

    async def test_cancel_during_model_resolution_is_applied_before_preflight(self):
        body = self.generation_body("Use <Video 1>.")
        assembled = {"input": {"duration_seconds": 10, "aspect_ratio": "16:9", "creative_brief": body["creative_brief"]}}
        model = {"id": "test-model", "name": "Test", "family": "test"}
        backend = MagicMock(manages_gpu_memory=False)
        backend.cancel.return_value = True
        resolution_started = asyncio.Event()
        allow_resolution = asyncio.Event()

        async def delayed_resolution(_body):
            resolution_started.set()
            await allow_resolution.wait()
            return model

        with (
            patch.object(routes, "assemble_request", return_value=assembled),
            patch.object(routes, "_resolve_model", side_effect=delayed_resolution),
            patch.dict(routes.BACKENDS, {"test": backend}),
        ):
            generation = asyncio.create_task(routes.generate(_Request(body=body)))
            await resolution_started.wait()
            cancelled = await routes.cancel(_Request())
            self.assertEqual(self.payload(cancelled), {"cancelled": True, "pending": True})
            allow_resolution.set()
            response = await generation

        self.assertEqual(response.status, 499)
        self.assertEqual(self.payload(response)["error"]["code"], "GENERATION_CANCELLED")
        backend.prepare_request.assert_called_once()
        backend.cancel.assert_called_once()
        backend.preflight.assert_not_called()
        self.assertIsNone(routes.STATE["active_request_id"])

    async def test_unload_during_model_resolution_is_deferred_to_selected_backend(self):
        body = self.generation_body("Use <Video 1>.")
        assembled = {"input": {"duration_seconds": 10, "aspect_ratio": "16:9", "creative_brief": body["creative_brief"]}}
        model = {"id": "test-model", "name": "Test", "family": "test"}
        backend = MagicMock(manages_gpu_memory=False)
        backend.request_unload.return_value = True
        resolution_started = asyncio.Event()
        allow_resolution = asyncio.Event()

        async def delayed_resolution(_body):
            resolution_started.set()
            await allow_resolution.wait()
            return model

        with (
            patch.object(routes, "assemble_request", return_value=assembled),
            patch.object(routes, "_resolve_model", side_effect=delayed_resolution),
            patch.dict(routes.BACKENDS, {"test": backend}),
        ):
            generation = asyncio.create_task(routes.generate(_Request(body=body)))
            await resolution_started.wait()
            unloaded = await routes.unload(_Request(body={"family": "test"}))
            self.assertEqual(self.payload(unloaded), {"unload_requested": True, "deferred": True})
            allow_resolution.set()
            response = await generation

        self.assertEqual(response.status, 499)
        backend.prepare_request.assert_called_once()
        backend.request_unload.assert_called_once()
        backend.preflight.assert_not_called()
        self.assertIsNone(routes.STATE["active_request_id"])

    async def test_generate_and_refine_return_guide_load_json_errors(self):
        generate_body = self.generation_body("Use <Video 1>.")
        with patch.object(routes, "assemble_request", side_effect=RuntimeError("guide integrity failed")):
            generated = await routes.generate(_Request(body=generate_body))
        self.assertEqual(generated.status, 500)
        self.assertEqual(self.payload(generated)["error"], {
            "code": "GUIDE_LOAD_FAILED",
            "message": "guide integrity failed",
        })

        refine_body = {
            **generate_body,
            "current_prompt": "Current prompt",
            "instruction": "Make it slower.",
        }
        with patch.object(routes, "assemble_refinement", side_effect=RuntimeError("guide integrity failed")):
            refined = await routes.refine(_Request(body=refine_body))
        self.assertEqual(refined.status, 500)
        self.assertEqual(self.payload(refined)["error"], {
            "code": "GUIDE_LOAD_FAILED",
            "message": "guide integrity failed",
        })
        self.assertIsNone(routes.STATE["active_request_id"])

    async def test_destructive_media_endpoints_return_409_while_generation_is_active(self):
        routes.STATE["active_request_id"] = "request"
        requests = [
            routes.remove_media(_Request(query={"session_id": self.session_id}, match_info={"asset_id": "asset"})),
            routes.clear_media(_Request(query={"session_id": self.session_id, "mode": "Reference"})),
            routes.resample_media(_Request(match_info={"asset_id": "asset"}, body={"session_id": self.session_id})),
            routes.upload_media(_Request()),
            routes.reorder_media(_Request(body={
                "session_id": self.session_id,
                "mode": "Reference",
                "asset_ids": [],
            })),
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

    async def test_expired_media_and_generation_cache_are_cleaned_off_loop(self):
        stale_key = ("stale-session", "Reference")
        fresh_key = ("fresh-session", "Reference")
        routes.GENERATION_CACHE.update({stale_key: {"prompt": "old"}, fresh_key: {"prompt": "new"}})
        routes.GENERATION_CACHE_ACCESS.update({stale_key: 10.0, fresh_key: 90.0})
        with tempfile.TemporaryDirectory() as directory:
            stale_dir = Path(directory) / "stale-session"
            stale_dir.mkdir()
            (stale_dir / "asset.bin").write_bytes(b"old")
            with (
                patch.object(routes, "SESSION_TTL_SECONDS", 60.0),
                patch.object(routes.STORE, "expire_sessions", return_value=[stale_dir]) as expire_sessions,
            ):
                await routes._cleanup_expired_state(now=100.0)
            self.assertFalse(stale_dir.exists())

        expire_sessions.assert_called_once_with(now=100.0, max_age_seconds=60.0)
        self.assertNotIn(stale_key, routes.GENERATION_CACHE)
        self.assertIn(fresh_key, routes.GENERATION_CACHE)
        self.assertFalse(routes.STATE["media_mutation_active"])

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

    async def test_upload_and_replace_preserve_their_http_response_contracts(self):
        uploaded = {"id": "new", "mode": "Reference"}
        replacement = {"id": "old", "mode": "Reference", "filename": "replacement.png"}
        reference_key = (self.session_id, "Reference")
        text_key = (self.session_id, "T2VA")
        routes.GENERATION_CACHE.update({reference_key: {"prompt": "reference"}, text_key: {"prompt": "text"}})
        fields = [
            _MultipartField("session_id", text=self.session_id),
            _MultipartField("mode", text="Reference"),
            _MultipartField("file", filename="image.png", content=b"image", content_type="image/png"),
        ]
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(routes, "CACHE_ROOT", Path(directory)),
            patch.object(routes.STORE, "prepare_add", return_value={"type": "image"}),
            patch.object(routes.STORE, "commit_add", return_value=uploaded),
        ):
            response = await routes.upload_media(_MultipartRequest(fields))
        self.assertEqual(response.status, 201)
        self.assertEqual(self.payload(response), {"session_id": self.session_id, "assets": [uploaded]})
        self.assertNotIn(reference_key, routes.GENERATION_CACHE)
        self.assertIn(text_key, routes.GENERATION_CACHE)

        routes.GENERATION_CACHE[reference_key] = {"prompt": "reference"}
        replace_fields = [
            _MultipartField("session_id", text=self.session_id),
            _MultipartField("mode", text="Reference"),
            _MultipartField("file", filename="replacement.png", content=b"replacement", content_type="image/png"),
        ]
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(routes, "CACHE_ROOT", Path(directory)),
            patch.object(routes.STORE, "get", return_value={"id": "old", "mode": "Reference"}),
            patch.object(routes.STORE, "prepare_replace", return_value={"type": "image", "mode": "Reference"}),
            patch.object(routes.STORE, "commit_replace", return_value=replacement),
            patch.object(routes.STORE, "list", return_value=[replacement]),
        ):
            response = await routes.upload_media(_MultipartRequest(replace_fields, query={"replace_asset_id": "old"}))
        self.assertEqual(response.status, 201)
        self.assertEqual(self.payload(response), {
            "session_id": self.session_id,
            "asset": replacement,
            "assets": [replacement],
        })
        self.assertNotIn(reference_key, routes.GENERATION_CACHE)
        self.assertIn(text_key, routes.GENERATION_CACHE)

    async def test_upload_rechecks_busy_state_after_multipart_streaming(self):
        fields = [
            _MultipartField("session_id", text=self.session_id),
            _MultipartField("mode", text="Reference"),
            _MultipartField(
                "file",
                filename="image.png",
                content=b"image",
                content_type="image/png",
                on_read=lambda: routes.STATE.update({"active_request_id": "request"}),
            ),
        ]
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(routes, "CACHE_ROOT", Path(directory)),
            patch.object(routes.STORE, "prepare_add") as prepare_add,
            patch.object(routes.STORE, "commit_add") as commit_add,
        ):
            response = await routes.upload_media(_MultipartRequest(fields))

        self.assertEqual(response.status, 409)
        self.assertEqual(self.payload(response)["error"]["code"], "GENERATION_BUSY")
        prepare_add.assert_not_called()
        commit_add.assert_not_called()

    async def test_upload_processing_runs_off_loop_and_blocks_generation_admission(self):
        fields = [
            _MultipartField("session_id", text=self.session_id),
            _MultipartField("mode", text="Reference"),
            _MultipartField("file", filename="image.png", content=b"image", content_type="image/png"),
        ]
        prepared = {"id": "new", "type": "image", "mode": "Reference"}
        uploaded = {"id": "new", "type": "image", "mode": "Reference"}
        worker_started = threading.Event()
        allow_worker = threading.Event()
        main_thread = threading.get_ident()
        worker_threads = []

        def prepare_add(*_args):
            worker_threads.append(threading.get_ident())
            worker_started.set()
            allow_worker.wait(timeout=2)
            return prepared

        def commit_add(*_args):
            self.assertEqual(threading.get_ident(), main_thread)
            return uploaded

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(routes, "CACHE_ROOT", Path(directory)),
            patch.object(routes.STORE, "prepare_add", side_effect=prepare_add),
            patch.object(routes.STORE, "commit_add", side_effect=commit_add),
        ):
            upload = asyncio.create_task(routes.upload_media(_MultipartRequest(fields)))
            started = await asyncio.to_thread(worker_started.wait, 2)
            self.assertTrue(started)
            self.assertIsNone(routes._claim_generation_request())
            allow_worker.set()
            response = await upload

        self.assertEqual(response.status, 201)
        self.assertEqual(len(worker_threads), 1)
        self.assertNotEqual(worker_threads[0], main_thread)
        self.assertFalse(routes.STATE["media_mutation_active"])

    async def test_resample_processing_runs_off_loop_and_commits_on_event_loop(self):
        main_thread = threading.get_ident()
        worker_threads = []
        prepared = {"derived_dir": Path("derived")}
        resampled = {"id": "video", "mode": "Reference"}

        def prepare_resample(*_args):
            worker_threads.append(threading.get_ident())
            return prepared

        def commit_resample(*_args):
            self.assertEqual(threading.get_ident(), main_thread)
            return resampled

        with (
            patch.object(routes.STORE, "get", return_value={"mode": "Reference"}),
            patch.object(routes.STORE, "prepare_resample", side_effect=prepare_resample),
            patch.object(routes.STORE, "commit_resample", side_effect=commit_resample),
        ):
            response = await routes.resample_media(_Request(
                match_info={"asset_id": "video"},
                body={"session_id": self.session_id, "frame_count": "4"},
            ))

        self.assertEqual(response.status, 200)
        self.assertEqual(self.payload(response), {"asset": resampled})
        self.assertEqual(len(worker_threads), 1)
        self.assertNotEqual(worker_threads[0], main_thread)
        self.assertFalse(routes.STATE["media_mutation_active"])

    async def test_generate_success_caches_only_task_context_and_always_returns_to_idle(self):
        body = self.generation_body("Use <Video 1>.")
        assembled = {"input": {"duration_seconds": 10, "aspect_ratio": "16:9", "creative_brief": body["creative_brief"]}}
        model = {"id": "test-model", "name": "Test", "family": "test"}
        backend = MagicMock(manages_gpu_memory=False)
        backend.preflight.return_value = {"context_profile": "auto", "kv_cache": "auto"}
        backend.generate.return_value = {"prompt": "Generated prompt"}
        monitor = MagicMock()
        monitor.stop.return_value = 0
        with (
            patch.object(routes, "assemble_request", return_value=assembled),
            patch.object(routes, "_resolve_model", new_callable=AsyncMock, return_value=model),
            patch.dict(routes.BACKENDS, {"test": backend}),
            patch.object(routes, "PeakVRAMMonitor", return_value=monitor),
            patch.object(routes, "write_event"),
        ):
            response = await routes.generate(_Request(body=body))

        self.assertEqual(response.status, 200)
        self.assertEqual(self.payload(response)["prompt"], "Generated prompt")
        self.assertEqual(routes.GENERATION_CACHE[(self.session_id, "Reference")], {
            "mode": "Reference",
            "duration_seconds": 10,
            "aspect_ratio": "16:9",
            "creative_brief": "Use <Video 1>.",
            "lyrics": "",
        })
        self.assertEqual(routes.STATE["phase"], "idle")
        self.assertIsNone(routes.STATE["active_request_id"])

    async def test_refine_failure_does_not_overwrite_cache_and_returns_to_idle(self):
        body = {
            **self.generation_body("Use <Video 1>."),
            "current_prompt": "Current prompt",
            "instruction": "Make it slower.",
        }
        cache_key = (self.session_id, "Reference")
        routes.GENERATION_CACHE[cache_key] = {"prompt": "Current prompt"}
        assembled = {"input": {"instruction": body["instruction"]}}
        model = {"id": "test-model", "name": "Test", "family": "test"}
        backend = MagicMock(manages_gpu_memory=False)
        backend.preflight.return_value = {"context_profile": "auto", "kv_cache": "auto"}
        backend.generate.side_effect = routes.ModelError("GENERATION_FAILED", "Generation failed.")
        monitor = MagicMock()
        monitor.stop.return_value = 0
        with (
            patch.object(routes, "assemble_refinement", return_value=assembled),
            patch.object(routes, "_resolve_model", new_callable=AsyncMock, return_value=model),
            patch.dict(routes.BACKENDS, {"test": backend}),
            patch.object(routes, "PeakVRAMMonitor", return_value=monitor),
            patch.object(routes, "write_event"),
        ):
            response = await routes.refine(_Request(body=body))

        self.assertEqual(response.status, 400)
        self.assertEqual(self.payload(response)["error"]["code"], "GENERATION_FAILED")
        self.assertEqual(routes.GENERATION_CACHE[cache_key]["prompt"], "Current prompt")
        self.assertEqual(routes.STATE["phase"], "idle")
        self.assertIsNone(routes.STATE["active_request_id"])

    async def test_lyrics_refine_uses_its_assembly_and_does_not_change_caption_cache(self):
        body = {
            "session_id": self.session_id,
            "mode": "Music3",
            "target": "lyrics",
            "model_id": "test-model",
            "creative_brief": "A compact soul arrangement.",
            "current_lyrics": "",
            "instruction": "Create a verse and chorus.",
            "use_music_brief": True,
        }
        cache_key = (self.session_id, "Music3")
        routes.GENERATION_CACHE[cache_key] = {"prompt": "Existing caption"}
        assembled = {"input": {"target": "lyrics"}}
        model = {"id": "test-model", "name": "Test", "family": "test"}
        backend = MagicMock(manages_gpu_memory=False)
        backend.preflight.return_value = {"context_profile": "auto", "kv_cache": "auto"}
        backend.generate.return_value = {"prompt": "[Verse]\nNew Lyrics"}
        monitor = MagicMock()
        monitor.stop.return_value = 0
        with (
            patch.object(routes, "assemble_lyrics_request", return_value=assembled) as assemble_lyrics,
            patch.object(routes, "assemble_refinement") as assemble_caption,
            patch.object(routes, "_resolve_model", new_callable=AsyncMock, return_value=model),
            patch.dict(routes.BACKENDS, {"test": backend}),
            patch.object(routes, "PeakVRAMMonitor", return_value=monitor),
            patch.object(routes, "write_event"),
        ):
            response = await routes.refine(_Request(body=body))

        self.assertEqual(response.status, 200)
        self.assertEqual(self.payload(response)["prompt"], "[Verse]\nNew Lyrics")
        assemble_lyrics.assert_called_once_with(body)
        assemble_caption.assert_not_called()
        self.assertEqual(routes.GENERATION_CACHE[cache_key], {"prompt": "Existing caption"})

    async def test_lyrics_refine_rejects_oversized_complete_output(self):
        body = {
            "session_id": self.session_id,
            "mode": "Music3",
            "target": "lyrics",
            "model_id": "test-model",
            "creative_brief": "",
            "current_lyrics": "",
            "instruction": "Create Lyrics.",
            "use_music_brief": False,
        }
        model = {"id": "test-model", "name": "Test", "family": "test"}
        backend = MagicMock(manages_gpu_memory=False)
        backend.preflight.return_value = {"context_profile": "auto", "kv_cache": "auto"}
        backend.generate.return_value = {"prompt": "x" * 4001}
        monitor = MagicMock()
        monitor.stop.return_value = 0
        with (
            patch.object(routes, "assemble_lyrics_request", return_value={"input": {"target": "lyrics"}}),
            patch.object(routes, "_resolve_model", new_callable=AsyncMock, return_value=model),
            patch.dict(routes.BACKENDS, {"test": backend}),
            patch.object(routes, "PeakVRAMMonitor", return_value=monitor),
            patch.object(routes, "write_event"),
        ):
            response = await routes.refine(_Request(body=body))

        self.assertEqual(response.status, 400)
        self.assertEqual(self.payload(response)["error"]["code"], "LYRICS_TOO_LONG")
        self.assertEqual(routes.STATE["phase"], "idle")

    async def test_successful_media_mutations_return_updated_assets(self):
        assets = [{"id": "second"}, {"id": "first"}]
        reference_key = (self.session_id, "Reference")
        text_key = (self.session_id, "T2VA")
        routes.GENERATION_CACHE.update({reference_key: {"prompt": "reference"}, text_key: {"prompt": "text"}})
        with (
            patch.object(routes.STORE, "get", return_value={"mode": "Reference"}),
            patch.object(routes.STORE, "remove"),
            patch.object(routes.STORE, "list", return_value=assets),
        ):
            response = await routes.remove_media(_Request(
                query={"session_id": self.session_id},
                match_info={"asset_id": "first"},
            ))
        self.assertEqual(self.payload(response), {"removed": True, "assets": assets})
        self.assertNotIn(reference_key, routes.GENERATION_CACHE)
        self.assertIn(text_key, routes.GENERATION_CACHE)

        resampled = {"id": "video", "frames": [{"index": 0}]}
        routes.GENERATION_CACHE[reference_key] = {"prompt": "reference"}
        with (
            patch.object(routes.STORE, "get", return_value={"mode": "Reference"}),
            patch.object(routes.STORE, "prepare_resample", return_value={"derived_dir": Path("derived")}),
            patch.object(routes.STORE, "commit_resample", return_value=resampled),
        ):
            response = await routes.resample_media(_Request(
                match_info={"asset_id": "video"},
                body={"session_id": self.session_id, "frame_count": 1},
            ))
        self.assertEqual(self.payload(response), {"asset": resampled})
        self.assertNotIn(reference_key, routes.GENERATION_CACHE)
        self.assertIn(text_key, routes.GENERATION_CACHE)

        routes.GENERATION_CACHE[reference_key] = {"prompt": "reference"}
        with patch.object(routes.STORE, "reorder", return_value=assets):
            response = await routes.reorder_media(_Request(body={
                "session_id": self.session_id,
                "mode": "Reference",
                "asset_ids": ["second", "first"],
            }))
        self.assertEqual(self.payload(response), {"assets": assets})
        self.assertNotIn(reference_key, routes.GENERATION_CACHE)
        self.assertIn(text_key, routes.GENERATION_CACHE)


if __name__ == "__main__":
    unittest.main()
