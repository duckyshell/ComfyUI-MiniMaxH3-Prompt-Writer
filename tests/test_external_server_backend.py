import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from backend.models.contract import ModelError
from backend.models.external_server_backend import (
    ExternalServerBackend,
    _RemoteChatHandler,
    normalize_server_url,
)
from backend.models.gguf_backend import GGUFBackend


class _FakeLlamaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    last_completion = None
    slow_started = threading.Event()
    vision = True
    reasoning_mode = "off"
    completion_count = 0

    def log_message(self, *_args):
        return

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok"})
        elif self.path == "/props":
            self._json({"n_ctx": 16384, "modalities": {"vision": type(self).vision, "audio": False}})
        elif self.path == "/v1/models":
            capabilities = ["completion", "multimodal"] if type(self).vision else ["completion"]
            self._json({"data": [{"id": "gemma-test.gguf", "capabilities": capabilities}]})
        else:
            self._json({"error": {"message": "not found"}}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        if self.path != "/v1/chat/completions":
            self._json({"error": {"message": "not found"}}, 404)
            return
        type(self).last_completion = payload
        type(self).completion_count += 1
        if type(self).reasoning_mode == "separate":
            reasoning_chunks = [
                {"choices": [{"delta": {"reasoning_content": "PRIVATE_"}, "finish_reason": None}]},
                {"choices": [{"delta": {"reasoning_content": "THOUGHT", "content": "PUBLIC"}, "finish_reason": "stop"}]},
                {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 5}},
            ]
            body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in reasoning_chunks) + "data: [DONE]\n\n"
            encoded = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        if type(self).reasoning_mode == "embedded":
            reasoning_chunks = [
                {"choices": [{"delta": {"content": "<think>PRIVATE_"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "THOUGHT</think>PUBLIC"}, "finish_reason": "stop"}]},
                {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 5}},
            ]
            body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in reasoning_chunks) + "data: [DONE]\n\n"
            encoded = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        if payload.get("top_k") == 999:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            type(self).slow_started.set()
            try:
                for index in range(50):
                    chunk = {"choices": [{"delta": {"content": str(index)}, "finish_reason": None}]}
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    time.sleep(0.05)
            except OSError:
                pass
            return
        if payload.get("top_k") == 998:
            delayed_chunks = [
                {"choices": [{"delta": {"content": "SERVER_"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "OK"}, "finish_reason": "stop"}]},
                {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 3}},
            ]
            delayed_body = "".join(
                f"data: {json.dumps(chunk)}\n\n" for chunk in delayed_chunks
            ) + "data: [DONE]\n\n"
            delayed_encoded = delayed_body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(delayed_encoded)))
            self.end_headers()
            self.wfile.flush()
            time.sleep(0.4)
            self.wfile.write(delayed_encoded)
            return
        if payload.get("top_k") == 997:
            reasoning_chunks = [
                {"choices": [{"delta": {"reasoning_content": "PRIVATE_"}, "finish_reason": None}]},
                {"choices": [{"delta": {"reasoning_content": "THOUGHT", "content": "PUBLIC"}, "finish_reason": "stop"}]},
                {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 5}},
            ]
            body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in reasoning_chunks) + "data: [DONE]\n\n"
            encoded = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        chunks = [
            {"choices": [{"delta": {"content": "SERVER_"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": "OK"}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 3}},
        ]
        body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        encoded = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class ExternalServerBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeLlamaHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        _FakeLlamaHandler.last_completion = None
        _FakeLlamaHandler.slow_started.clear()
        _FakeLlamaHandler.vision = True
        _FakeLlamaHandler.reasoning_mode = "off"
        _FakeLlamaHandler.completion_count = 0
        self.backend = ExternalServerBackend()

    def test_only_loopback_root_urls_are_accepted(self):
        self.assertEqual(normalize_server_url("http://localhost:8080/v1"), "http://localhost:8080")
        with self.assertRaises(ModelError) as remote:
            normalize_server_url("http://example.com:8080")
        self.assertEqual(remote.exception.code, "EXTERNAL_SERVER_NOT_LOCAL")
        with self.assertRaises(ModelError):
            normalize_server_url("http://127.0.0.1:8080/custom/path")

    def test_probe_returns_external_multimodal_model(self):
        model = self.backend.probe_model({"url": self.url})
        self.assertEqual(model["family"], "external")
        self.assertEqual(model["remote_model"], "gemma-test.gguf")
        self.assertEqual(model["server_context_tokens"], 16384)
        self.assertTrue(model["capabilities"]["images"])
        self.assertTrue(model["externally_managed"])
        self.assertTrue(model["thinking_managed_by_server"])

    def test_probe_accepts_external_text_only_model(self):
        _FakeLlamaHandler.vision = False

        model = self.backend.probe_model({"url": self.url})

        self.assertTrue(model["runtime_ready"])
        self.assertFalse(model["capabilities"]["images"])
        self.assertFalse(model["capabilities"]["video_frames"])

    def test_stream_preserves_separate_reasoning_without_mixing_or_double_counting(self):
        response = self.backend._request_chat_completion_stream(self.url, {
            "model": "gemma-test.gguf",
            "messages": [],
            "top_k": 997,
            "stream": True,
        })

        self.assertEqual(response["choices"][0]["message"]["content"], "PUBLIC")
        self.assertEqual(response["choices"][0]["message"]["reasoning_content"], "PRIVATE_THOUGHT")
        self.assertEqual(response["usage"]["completion_tokens"], 5)

    def test_text_only_external_model_generates_without_media(self):
        _FakeLlamaHandler.vision = False
        model = self.backend.probe_model({"url": self.url})
        assembled = {
            "messages": [{"role": "system", "content": "guide"}, {"role": "user", "content": "brief"}],
            "media_inputs": [],
            "input": {"mode": "T2VA", "duration_seconds": 5, "creative_brief": "brief"},
        }
        plan = self.backend.preflight(
            model,
            assembled,
            context_profile="auto",
            kv_cache="auto",
            thinking=False,
        )

        self.backend.prepare_request()
        result = self.backend.generate(
            model,
            assembled,
            "external-text-test-session",
            thinking=False,
            seed=42,
            unload_after=True,
            runtime_plan=plan,
        )

        self.assertEqual(result["prompt"], "SERVER_OK")

    def test_text_only_external_model_rejects_visual_media_with_actionable_error(self):
        _FakeLlamaHandler.vision = False
        model = self.backend.probe_model({"url": self.url})
        assembled = {
            "messages": [{"role": "user", "content": "brief"}],
            "media_inputs": [{"requires_capability": "images"}],
        }

        with self.assertRaises(ModelError) as raised:
            self.backend.generate(
                model,
                assembled,
                "external-vision-test-session",
                thinking=False,
                seed=42,
                unload_after=True,
            )

        self.assertEqual(raised.exception.code, "EXTERNAL_VISION_REQUIRED")
        self.assertIn("text-only mode", raised.exception.message)
        self.assertIn("matching mmproj", raised.exception.details["suggestion"])

    def test_remote_handler_uses_openai_multimodal_messages_without_reasoning_override(self):
        handler = _RemoteChatHandler(self.backend, self.url, "gemma-test.gguf")
        messages = [{
            "role": "user",
            "content": [
                {"type": "text", "text": "<Picture 1>: image reference."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
        }]
        response = handler(
            messages=messages,
            temperature=1.0,
            top_p=0.95,
            top_k=64,
            max_tokens=1536,
            seed=42,
        )
        self.assertEqual(response["choices"][0]["message"]["content"], "SERVER_OK")
        payload = _FakeLlamaHandler.last_completion
        self.assertEqual(payload["messages"], messages)
        self.assertEqual(payload["seed"], 42)
        self.assertNotIn("chat_template_kwargs", payload)
        self.assertNotIn("max_tokens", payload)

    def test_writer_thinking_request_does_not_override_server_reasoning_off(self):
        model = self.backend.probe_model({"url": self.url})
        assembled = {
            "messages": [{"role": "user", "content": "brief"}],
            "media_inputs": [],
            "input": {"mode": "T2VA", "duration_seconds": 5, "creative_brief": "brief"},
        }
        plan = self.backend.preflight(
            model,
            assembled,
            context_profile="auto",
            kv_cache="auto",
            thinking=True,
        )

        result = self.backend.generate(
            model,
            assembled,
            "external-reasoning-off",
            thinking=True,
            seed=42,
            unload_after=True,
            runtime_plan=plan,
        )

        self.assertFalse(plan["thinking"])
        self.assertEqual(result["prompt"], "SERVER_OK")
        self.assertEqual(result["reasoning_tokens"], 0)
        self.assertEqual(_FakeLlamaHandler.completion_count, 1)
        self.assertNotIn("chat_template_kwargs", _FakeLlamaHandler.last_completion)

    def test_managed_adapter_can_retain_request_reasoning(self):
        payloads = []

        class Handler:
            def __call__(
                self, *, messages, temperature, top_p, top_k, max_tokens,
                seed, enable_thinking,
            ):
                payloads.append({"enable_thinking": enable_thinking})
                return {
                    "choices": [{"message": {"content": "PROMPT"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                }

        class ManagedBackend(ExternalServerBackend):
            reasoning_managed_by_server = False

            def _connect(self, model_info):
                self.chat_handler = Handler()
                self.model_id = model_info["id"]

        backend = ManagedBackend()
        model = {
            "id": "managed",
            "endpoint": "http://127.0.0.1:1",
            "remote_model": "managed",
            "capabilities": {"images": False, "video_frames": False, "audio": False},
        }
        runtime_plan = {
            "context_profile": "standard",
            "context_tokens": 16_384,
            "kv_cache": "server",
            "max_output_tokens": 2_048,
            "thinking_budget_reduced": False,
        }

        def pipeline(_model, _assembled, _session, _plan, *, complete, thinking, **_options):
            response = complete(
                messages=[], temperature=1.0, top_p=.95, top_k=64,
                max_tokens=2_048, seed=None, thinking=thinking, purpose="generation",
            )
            return {"prompt": response["choices"][0]["message"]["content"]}

        for thinking in (False, True):
            with self.subTest(thinking=thinking):
                payloads.clear()
                with patch("backend.models.external_server_backend.run_h3_pipeline", side_effect=pipeline):
                    result = backend.generate(
                        model,
                        {"messages": [], "media_inputs": []},
                        "managed-local",
                        thinking=thinking,
                        seed=None,
                        unload_after=False,
                        runtime_plan=runtime_plan,
                    )
                self.assertEqual(result["prompt"], "PROMPT")
                self.assertEqual(payloads, [{"enable_thinking": thinking}])

    def test_server_reasoning_on_is_separated_without_writer_control(self):
        model = self.backend.probe_model({"url": self.url})
        assembled = {
            "messages": [{"role": "user", "content": "brief"}],
            "media_inputs": [],
            "input": {"mode": "T2VA", "duration_seconds": 5, "creative_brief": "brief"},
        }

        for mode in ("separate", "embedded"):
            with self.subTest(mode=mode):
                _FakeLlamaHandler.reasoning_mode = mode
                _FakeLlamaHandler.completion_count = 0
                self.backend.prepare_request()
                plan = self.backend.preflight(
                    model,
                    assembled,
                    context_profile="auto",
                    kv_cache="auto",
                    thinking=False,
                )
                result = self.backend.generate(
                    model,
                    assembled,
                    f"external-reasoning-{mode}",
                    thinking=False,
                    seed=42,
                    unload_after=True,
                    runtime_plan=plan,
                )

                self.assertEqual(result["prompt"], "PUBLIC")
                self.assertGreater(result["reasoning_tokens"], 0)
                self.assertEqual(_FakeLlamaHandler.completion_count, 1)
                self.assertNotIn("chat_template_kwargs", _FakeLlamaHandler.last_completion)

    def test_external_preflight_uses_server_context_and_rejects_local_runtime_controls(self):
        model = self.backend.probe_model({"url": self.url})
        assembled = {
            "messages": [{"role": "system", "content": "guide"}, {"role": "user", "content": "brief"}],
            "media_inputs": [],
        }
        plan = self.backend.preflight(
            model,
            assembled,
            context_profile="auto",
            kv_cache="auto",
            thinking=False,
        )
        self.assertEqual(plan["context_tokens"], 16384)
        self.assertEqual(plan["kv_cache"], "server")
        self.assertIsNone(plan["max_output_tokens"])
        self.assertEqual(plan["reserved_output_tokens"], 512)
        self.assertTrue(plan["output_tokens_managed_by_server"])
        music_plan = self.backend.preflight(
            model,
            {**assembled, "input": {"mode": "Music3"}},
            context_profile="auto",
            kv_cache="auto",
            thinking=False,
        )
        self.assertIsNone(music_plan["max_output_tokens"])
        with self.assertRaises(ModelError) as overflow:
            self.backend.preflight(
                model,
                {
                    "messages": [{"role": "user", "content": "x" * 70_000}],
                    "media_inputs": [],
                    "input": {"mode": "T2VA"},
                },
                context_profile="auto",
                kv_cache="auto",
                thinking=False,
            )
        self.assertEqual(overflow.exception.code, "CONTEXT_BUDGET_EXCEEDED")
        with self.assertRaises(ModelError) as manual:
            self.backend.preflight(
                model,
                assembled,
                context_profile="low",
                kv_cache="auto",
                thinking=False,
            )
        self.assertEqual(manual.exception.code, "EXTERNAL_RUNTIME_MANAGED")

    def test_external_lifecycle_is_server_managed_without_local_unload_hook(self):
        model = self.backend.probe_model({"url": self.url})
        self.assertFalse(issubclass(ExternalServerBackend, GGUFBackend))
        self.assertTrue(self.backend.externally_managed)
        self.assertTrue(model["externally_managed"])
        self.assertFalse(hasattr(self.backend, "unload"))
        self.assertEqual(self.backend.probe_model({"url": self.url})["remote_model"], "gemma-test.gguf")

    def test_cancel_interrupts_stream_without_stopping_remote_server(self):
        handler = _RemoteChatHandler(self.backend, self.url, "gemma-test.gguf")
        result: dict[str, object] = {}

        def run_request():
            try:
                handler(
                    messages=[{"role": "user", "content": "slow"}],
                    temperature=1.0,
                    top_p=0.95,
                    top_k=999,
                    max_tokens=1536,
                    seed=42,
                )
            except Exception as error:  # Captured for assertion in the test thread.
                result["error"] = error

        self.backend.prepare_request()
        thread = threading.Thread(target=run_request)
        thread.start()
        self.assertTrue(_FakeLlamaHandler.slow_started.wait(timeout=2))
        self.backend.cancel()
        thread.join(timeout=2)

        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result.get("error"), ModelError)
        self.assertEqual(result["error"].code, "GENERATION_CANCELLED")
        self.assertEqual(self.backend.probe_model({"url": self.url})["remote_model"], "gemma-test.gguf")

    def test_stream_tolerates_delayed_first_event(self):
        handler = _RemoteChatHandler(self.backend, self.url, "gemma-test.gguf")

        response = handler(
            messages=[{"role": "user", "content": "delayed first token"}],
            temperature=1.0,
            top_p=0.95,
            top_k=998,
            max_tokens=1536,
            seed=42,
        )

        self.assertEqual(response["choices"][0]["message"]["content"], "SERVER_OK")
        self.assertEqual(response["usage"], {"prompt_tokens": 12, "completion_tokens": 3})

    def test_external_generation_does_not_import_local_llama_cpp(self):
        model = self.backend.probe_model({"url": self.url})
        assembled = {
            "messages": [
                {"role": "system", "content": "Return a concise video prompt."},
                {"role": "user", "content": "Create a simple static scene."},
            ],
            "media_inputs": [],
            "input": {
                "mode": "T2VA",
                "duration_seconds": 5,
                "creative_brief": "Create a simple static scene.",
            },
        }
        plan = self.backend.preflight(
            model,
            assembled,
            context_profile="auto",
            kv_cache="auto",
            thinking=False,
        )
        original_import = __import__

        def guarded_import(name, *args, **kwargs):
            if name == "llama_cpp" or name.startswith("llama_cpp."):
                raise AssertionError("external generation imported llama_cpp")
            return original_import(name, *args, **kwargs)

        self.backend.prepare_request()
        with patch("builtins.__import__", side_effect=guarded_import):
            result = self.backend.generate(
                model,
                assembled,
                "external-test-session",
                thinking=False,
                seed=42,
                unload_after=True,
                runtime_plan=plan,
            )

        self.assertEqual(result["prompt"], "SERVER_OK")
        self.assertTrue(result["external_server"])
        self.assertIsNone(result["cold_start"])
        self.assertIsNone(result["model_load_seconds"])


if __name__ == "__main__":
    unittest.main()
