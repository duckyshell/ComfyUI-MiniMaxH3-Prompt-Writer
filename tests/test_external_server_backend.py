import base64
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
    normalize_chat_messages,
    normalize_chat_options,
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
        if payload.get("model") == "incomplete":
            body = b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
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

    def test_partial_stream_without_terminal_is_rejected(self):
        with self.assertRaises(ModelError) as error:
            self.backend._request_chat_completion_stream(self.url, {"model": "incomplete"})
        self.assertEqual(error.exception.code, "EXTERNAL_STREAM_INTERRUPTED")

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
        self.assertFalse(model["lifecycle_supported"])
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
        self.assertFalse(model["lifecycle_supported"])
        with self.assertRaises(ModelError):
            self.backend.unload(model["id"])
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

    def test_stream_chat_emits_status_and_streamed_content(self):
        model = self.backend.probe_model({"url": self.url})
        events = []

        result = self.backend.stream_chat(
            model,
            [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hello"}],
            temperature=0.8,
            top_p=0.95,
            top_k=40,
            max_tokens=256,
            seed=7,
            thinking=True,
            on_event=lambda kind, payload: events.append((kind, payload)),
        )

        self.assertEqual([kind for kind, _ in events], ["status", "content", "content"])
        self.assertEqual(events[0][1], {"phase": "generating"})
        self.assertEqual(
            "".join(payload["text"] for kind, payload in events if kind == "content"),
            "SERVER_OK",
        )
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(result["usage"], {"prompt_tokens": 12, "completion_tokens": 3})
        self.assertFalse(result["reasoning"])
        self.assertGreaterEqual(result["elapsed_seconds"], 0)
        self.assertGreater(result["tokens_per_second"], 0)
        payload = _FakeLlamaHandler.last_completion
        self.assertEqual(payload["model"], "gemma-test.gguf")
        self.assertEqual(payload["messages"][-1], {"role": "user", "content": "hello"})
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["stream_options"], {"include_usage": True})
        self.assertEqual(payload["max_tokens"], 256)
        self.assertEqual(payload["seed"], 7)
        self.assertEqual(payload["top_k"], 40)
        self.assertEqual(payload["chat_template_kwargs"], {"enable_thinking": True})

    def test_stream_chat_can_disable_thinking(self):
        model = self.backend.probe_model({"url": self.url})
        events = []

        result = self.backend.stream_chat(
            model,
            [{"role": "user", "content": "hello"}],
            temperature=0.8,
            top_p=0.95,
            top_k=40,
            max_tokens=None,
            seed=None,
            thinking=False,
            on_event=lambda kind, payload: events.append((kind, payload)),
        )

        self.assertEqual(_FakeLlamaHandler.last_completion["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(result["finish_reason"], "stop")

    def test_stream_chat_splits_embedded_think_reasoning(self):
        _FakeLlamaHandler.reasoning_mode = "embedded"
        model = self.backend.probe_model({"url": self.url})
        events = []

        result = self.backend.stream_chat(
            model,
            [{"role": "user", "content": "think first"}],
            temperature=0.8,
            top_p=0.95,
            top_k=40,
            max_tokens=None,
            seed=None,
            thinking=True,
            on_event=lambda kind, payload: events.append((kind, payload)),
        )

        reasoning = "".join(payload["text"] for kind, payload in events if kind == "reasoning")
        content = "".join(payload["text"] for kind, payload in events if kind == "content")
        self.assertEqual(reasoning, "PRIVATE_THOUGHT")
        self.assertEqual(content, "PUBLIC")
        self.assertNotIn("<think>", content)
        self.assertTrue(result["reasoning"])
        self.assertEqual(result["usage"], {"prompt_tokens": 12, "completion_tokens": 5})
        self.assertNotIn("max_tokens", _FakeLlamaHandler.last_completion)
        self.assertNotIn("seed", _FakeLlamaHandler.last_completion)

    def test_stream_chat_unloads_router_managed_model_after_use(self):
        model = dict(self.backend.probe_model({"url": self.url}), lifecycle_supported=True)
        transitions = []

        def transition(model_id, load, *_args):
            transitions.append((model_id, load))

        with patch.object(self.backend.router, "transition", side_effect=transition):
            result = self.backend.stream_chat(
                model,
                [{"role": "user", "content": "hello"}],
                temperature=0.8,
                top_p=0.95,
                top_k=40,
                max_tokens=None,
                seed=None,
                thinking=True,
                on_event=lambda _kind, _payload: None,
            )

        self.assertEqual(transitions, [(model["id"], True), (model["id"], False)])
        self.assertEqual(result["finish_reason"], "stop")

    def test_stream_chat_keeps_router_managed_model_loaded_when_requested(self):
        model = dict(self.backend.probe_model({"url": self.url}), lifecycle_supported=True)
        transitions = []

        def transition(model_id, load, *_args):
            transitions.append((model_id, load))

        with patch.object(self.backend.router, "transition", side_effect=transition):
            result = self.backend.stream_chat(
                model,
                [{"role": "user", "content": "hello"}],
                temperature=0.8,
                top_p=0.95,
                top_k=40,
                max_tokens=None,
                seed=None,
                thinking=True,
                on_event=lambda _kind, _payload: None,
                keep_loaded=True,
            )

        self.assertEqual(transitions, [(model["id"], True)])
        self.assertEqual(result["finish_reason"], "stop")

    def test_stream_chat_warns_when_unload_is_not_confirmed(self):
        model = dict(self.backend.probe_model({"url": self.url}), lifecycle_supported=True)
        events = []

        def transition(_model_id, load, *_args):
            if not load:
                raise ModelError("EXTERNAL_ROUTER_UNAVAILABLE", "router went away")

        with patch.object(self.backend.router, "transition", side_effect=transition):
            result = self.backend.stream_chat(
                model,
                [{"role": "user", "content": "hello"}],
                temperature=0.8,
                top_p=0.95,
                top_k=40,
                max_tokens=None,
                seed=None,
                thinking=True,
                on_event=lambda kind, payload: events.append((kind, payload)),
            )

        warnings = [payload for kind, payload in events if kind == "warning"]
        self.assertEqual([warning["code"] for warning in warnings], ["EXTERNAL_UNLOAD_FAILED"])
        self.assertIn("not confirmed", warnings[0]["message"])
        content = "".join(payload["text"] for kind, payload in events if kind == "content")
        self.assertEqual(content, "SERVER_OK")
        self.assertEqual(result["finish_reason"], "stop")

    def test_stream_chat_cancellation_interrupts_the_stream(self):
        model = self.backend.probe_model({"url": self.url})
        result: dict[str, object] = {}

        def run_request():
            try:
                self.backend.stream_chat(
                    model,
                    [{"role": "user", "content": "slow"}],
                    temperature=0.8,
                    top_p=0.95,
                    top_k=999,
                    max_tokens=None,
                    seed=None,
                    thinking=True,
                    on_event=lambda _kind, _payload: None,
                )
            except ModelError as error:
                result["error"] = error

        thread = threading.Thread(target=run_request)
        thread.start()
        self.assertTrue(_FakeLlamaHandler.slow_started.wait(timeout=2))
        self.backend.cancel_chat()
        thread.join(timeout=2)

        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result.get("error"), ModelError)
        self.assertEqual(result["error"].code, "GENERATION_CANCELLED")

    def test_chat_message_normalization_requires_valid_history(self):
        self.assertEqual(
            normalize_chat_messages([{"role": "user", "content": "hi"}]),
            [{"role": "user", "content": "hi"}],
        )
        for messages in (
            [],
            [{"role": "system", "content": "no user turn"}],
            [{"role": "tool", "content": "hi"}],
            [{"role": "user", "content": 42}],
            [{"role": "user"}],
            "not a list",
        ):
            with self.subTest(messages=messages):
                with self.assertRaises(ModelError) as error:
                    normalize_chat_messages(messages)
                self.assertEqual(error.exception.code, "INVALID_REQUEST")

    def test_chat_message_normalization_accepts_inline_images_and_videos(self):
        image = "data:image/png;base64," + base64.b64encode(b"png-bytes").decode("ascii")
        video = "data:video/mp4;base64," + base64.b64encode(b"mp4-bytes").decode("ascii")
        content = [
            {"type": "text", "text": "describe these"},
            {"type": "image_url", "image_url": {"url": image}},
            {"type": "video_url", "video_url": {"url": video}},
        ]
        normalized = normalize_chat_messages([{"role": "user", "content": content}])
        self.assertEqual(normalized, [{"role": "user", "content": content}])

    def test_chat_message_normalization_rejects_unsafe_media(self):
        image = "data:image/png;base64," + base64.b64encode(b"png-bytes").decode("ascii")
        video = "data:video/mp4;base64," + base64.b64encode(b"mp4-bytes").decode("ascii")
        oversized_image = "data:image/png;base64," + base64.b64encode(b"x" * (4 * 1024 * 1024 + 1)).decode("ascii")
        cases = {
            "remote image URL": {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}],
            },
            "unsupported image type": {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "data:image/gif;base64,AAAA"}}],
            },
            "invalid base64": {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,%%%"}}],
            },
            "oversized image": {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": oversized_image}}],
            },
            "unsupported video type": {
                "role": "user",
                "content": [{"type": "video_url", "video_url": {"url": "data:video/quicktime;base64,AAAA"}}],
            },
            "too many images": {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": image}}] * 5,
            },
            "too many videos": {
                "role": "user",
                "content": [{"type": "video_url", "video_url": {"url": video}}] * 2,
            },
            "unknown part": {
                "role": "user",
                "content": [{"type": "audio_url", "audio_url": {"url": image}}],
            },
            "empty parts": {"role": "user", "content": [{"type": "text", "text": ""}]},
        }
        for label, message in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(ModelError) as error:
                    normalize_chat_messages([message])
                self.assertEqual(error.exception.code, "INVALID_REQUEST")

    def test_chat_options_are_bounded_and_defaulted(self):
        self.assertEqual(
            normalize_chat_options({}),
            {
                "temperature": 0.8,
                "top_p": 0.95,
                "top_k": 40,
                "max_tokens": None,
                "seed": None,
                "thinking": True,
                "keep_loaded": False,
            },
        )
        self.assertEqual(normalize_chat_options({"top_k": 0})["top_k"], 0)
        self.assertEqual(normalize_chat_options({"top_k": None})["top_k"], 40)
        self.assertFalse(normalize_chat_options({"thinking": False})["thinking"])
        self.assertTrue(normalize_chat_options({"keep_loaded": True})["keep_loaded"])
        self.assertFalse(normalize_chat_options({"keep_loaded": False})["keep_loaded"])
        for payload in (
            {"temperature": 9},
            {"temperature": True},
            {"top_p": -0.1},
            {"top_k": 501},
            {"top_k": 2.5},
            {"max_tokens": 0},
            {"seed": -1},
            {"thinking": "yes"},
            {"keep_loaded": "yes"},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ModelError) as error:
                    normalize_chat_options(payload)
                self.assertEqual(error.exception.code, "INVALID_REQUEST")


if __name__ == "__main__":
    unittest.main()
