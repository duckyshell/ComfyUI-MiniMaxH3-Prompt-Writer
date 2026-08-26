import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from backend.models.contract import ModelError
from backend.models.ollama_backend import (
    OLLAMA_MODEL_TIERS,
    RECOMMENDED_OLLAMA_MODEL,
    TESTED_OLLAMA_TAGS,
    OllamaBackend,
    _ollama_cli_installed,
    _ollama_messages,
    normalize_ollama_url,
)


class _FakeOllamaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests = []
    running_models = []
    slow_started = threading.Event()
    stream_error = False

    def log_message(self, *_args):
        return

    @classmethod
    def reset(cls):
        cls.requests = []
        cls.running_models = []
        cls.slow_started.clear()
        cls.stream_error = False

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        type(self).requests.append(("GET", self.path, None))
        if self.path == "/api/version":
            self._json({"version": "0.test"})
        elif self.path == "/api/tags":
            self._json({
                "models": [
                    {
                        "name": "gemma4:test",
                        "model": "gemma4:test",
                        "digest": "vision-digest",
                        "size": 1234,
                        "details": {"parameter_size": "12B", "quantization_level": "Q4_K_M"},
                    },
                    {
                        "name": "text:test",
                        "model": "text:test",
                        "digest": "text-digest",
                        "size": 456,
                    },
                    {"name": "cloud:model", "digest": "", "size": 0},
                ],
            })
        elif self.path == "/api/ps":
            self._json({"models": type(self).running_models})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        type(self).requests.append(("POST", self.path, payload))
        if self.path == "/api/show":
            if payload.get("model") == "gemma4:test":
                self._json({
                    "capabilities": ["completion", "vision", "thinking"],
                    "model_info": {"gemma4.context_length": 12288},
                    "details": {"parameter_size": "12B", "quantization_level": "Q4_K_M"},
                })
            else:
                self._json({"capabilities": ["completion"], "model_info": {"test.context_length": 8192}})
        elif self.path == "/api/generate":
            type(self).running_models = []
            self._json({"done": True})
        elif self.path == "/api/chat":
            if payload.get("options", {}).get("top_k") == 999:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                type(self).slow_started.set()
                try:
                    for index in range(100):
                        chunk = {"message": {"content": str(index)}, "done": False}
                        self.wfile.write((json.dumps(chunk) + "\n").encode("utf-8"))
                        self.wfile.flush()
                        time.sleep(0.03)
                except OSError:
                    pass
                return
            events = [{"message": {"content": "OLLAMA_"}, "done": False}]
            if type(self).stream_error:
                events.append({"error": "runner stopped"})
            else:
                events.append({
                    "message": {"content": "OK"},
                    "done": True,
                    "done_reason": "stop",
                    "prompt_eval_count": 21,
                    "eval_count": 4,
                    "load_duration": 2_000_000_000,
                })
            body = b"".join((json.dumps(event) + "\n").encode("utf-8") for event in events)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json({"error": "not found"}, 404)


class _QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, _request, _client_address):
        return


class _SecondFakeOllamaHandler(_FakeOllamaHandler):
    requests = []
    running_models = []
    slow_started = threading.Event()
    stream_error = False


class OllamaBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _QuietThreadingHTTPServer(("127.0.0.1", 0), _FakeOllamaHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.second_server = _QuietThreadingHTTPServer(("127.0.0.1", 0), _SecondFakeOllamaHandler)
        cls.second_thread = threading.Thread(target=cls.second_server.serve_forever, daemon=True)
        cls.second_thread.start()
        cls.second_url = f"http://127.0.0.1:{cls.second_server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.second_server.shutdown()
        cls.second_server.server_close()
        cls.second_thread.join(timeout=2)

    def setUp(self):
        _FakeOllamaHandler.reset()
        _SecondFakeOllamaHandler.reset()
        self.backend = OllamaBackend(self.url)

    def _model(self):
        return self.backend.probe_model("gemma4:test")

    def _assembled(self):
        return {
            "messages": [
                {"role": "system", "content": "Return only the final prompt."},
                {"role": "user", "content": "Describe a quiet static scene."},
            ],
            "media_inputs": [],
            "input": {"mode": "T2VA", "duration_seconds": 5, "creative_brief": "A quiet scene."},
        }

    def test_cli_detection_uses_path_lookup_only(self):
        with patch("backend.models.ollama_backend.shutil.which", return_value="C:/tools/ollama.exe") as which:
            self.assertTrue(_ollama_cli_installed())
        with patch("backend.models.ollama_backend.shutil.which", return_value=None):
            self.assertFalse(_ollama_cli_installed())
        which.assert_called_once_with("ollama")

    def test_normalizes_optional_remote_host_and_rejects_api_paths(self):
        self.assertEqual(normalize_ollama_url(None), "http://127.0.0.1:11434")
        self.assertEqual(normalize_ollama_url("http://localhost:11434"), "http://127.0.0.1:11434")
        self.assertEqual(normalize_ollama_url(" http://192.168.1.20:11434/ "), "http://192.168.1.20:11434")
        self.assertEqual(normalize_ollama_url("https://ollama.example"), "https://ollama.example:443")
        for invalid in ("ftp://host:11434", "http://host:11434/api", "http://user:secret@host:11434"):
            with self.subTest(invalid=invalid), self.assertRaises(ModelError) as raised:
                normalize_ollama_url(invalid)
            self.assertEqual(raised.exception.code, "INVALID_OLLAMA_URL")

    def test_ollama_host_allows_private_http_and_public_https(self):
        for value in (
            "http://10.1.2.3:11434",
            "http://172.16.0.1:11434",
            "http://172.31.255.254:11434",
            "http://192.168.1.25:11434",
            "http://[fd00::25]:11434",
        ):
            with self.subTest(value=value):
                self.assertEqual(normalize_ollama_url(value), value)
        self.assertEqual(normalize_ollama_url("https://ollama.example"), "https://ollama.example:443")

    def test_ollama_host_rejects_public_http(self):
        for value in (
            "http://example.com:11434",
            "http://8.8.8.8:11434",
            "http://172.32.0.1:11434",
            "http://192.0.2.1:11434",
        ):
            with self.subTest(value=value), self.assertRaises(ModelError) as raised:
                normalize_ollama_url(value)
            self.assertEqual(raised.exception.code, "OLLAMA_URL_INSECURE")

    def test_ollama_host_blocks_metadata_and_special_network_addresses(self):
        for value in (
            "https://metadata.google.internal",
            "https://instance-data",
            "https://instance-data.ec2.internal",
            "https://169.254.169.254",
            "https://0.0.0.0",
            "https://224.0.0.1",
            "https://[fe80::1]",
            "https://[ff02::1]",
            "https://[::]",
        ):
            with self.subTest(value=value), self.assertRaises(ModelError) as raised:
                normalize_ollama_url(value)
            self.assertEqual(raised.exception.code, "OLLAMA_URL_BLOCKED")

    def test_beginner_recommendations_match_the_live_tested_gpu_tiers(self):
        self.assertEqual(RECOMMENDED_OLLAMA_MODEL, "gemma4:e4b")
        self.assertEqual(TESTED_OLLAMA_TAGS, {
            "gemma4:e2b", "gemma4:e4b", "gemma4:12b", "gemma4:26b", "gemma4:31b",
        })
        self.assertEqual(
            [(tier["label"], tier["model"]) for tier in OLLAMA_MODEL_TIERS],
            [
                ("<8 GB", "gemma4:e2b"),
                ("8 GB", "gemma4:e4b"),
                ("12–16 GB", "gemma4:12b"),
                ("24 GB", "gemma4:26b"),
                ("32 GB", "gemma4:31b"),
            ],
        )

    def test_detects_only_local_compatible_models_and_declared_context(self):
        detected = self.backend.detect()

        self.assertEqual(detected["state"], "ready")
        self.assertEqual(detected["model_tiers"], OLLAMA_MODEL_TIERS)
        self.assertEqual([model["remote_model"] for model in detected["models"]], ["gemma4:test", "text:test"])
        self.assertEqual([model["remote_model"] for model in detected["compatible_models"]], ["gemma4:test"])
        model = detected["compatible_models"][0]
        self.assertEqual(model["model_context_limit"], 12288)
        self.assertEqual(model["recommended_context"], "low")
        self.assertTrue(model["auto_context_ladder"])
        self.assertTrue(model["thinking_detected"])
        self.assertFalse(model["tested_for_h3"])
        self.assertFalse(model["capabilities"]["audio"])

    def test_custom_endpoint_scopes_model_ids_metadata_cache_and_inference(self):
        local = self.backend.detect(self.url)
        remote = self.backend.detect(self.second_url)

        local_model = local["compatible_models"][0]
        remote_model = remote["compatible_models"][0]
        self.assertEqual(local_model["endpoint"], self.url)
        self.assertEqual(remote_model["endpoint"], self.second_url)
        self.assertNotEqual(local_model["id"], remote_model["id"])
        self.assertTrue(remote_model["id"].startswith(f"ollama::{self.second_url}::"))
        self.assertTrue(remote["remote_host"])
        self.assertTrue(any(path == "/api/show" for _, path, _ in _FakeOllamaHandler.requests))
        self.assertTrue(any(path == "/api/show" for _, path, _ in _SecondFakeOllamaHandler.requests))

        _FakeOllamaHandler.requests = []
        _SecondFakeOllamaHandler.requests = []
        result = self.backend._chat_completion(
            "gemma4:test", {"context_tokens": 8192}, endpoint=self.second_url,
            messages=[{"role": "user", "content": "remote"}],
            temperature=1.0, top_p=0.95, top_k=64, max_tokens=128, seed=None, thinking=False,
        )
        self.assertEqual(result["choices"][0]["message"]["content"], "OLLAMA_OK")
        self.assertFalse(any(path == "/api/chat" for _, path, _ in _FakeOllamaHandler.requests))
        self.assertTrue(any(path == "/api/chat" for _, path, _ in _SecondFakeOllamaHandler.requests))

    def test_retained_models_do_not_transfer_between_endpoints(self):
        remote_model = self.backend.probe_model("gemma4:test", self.second_url)
        plan = self.backend.preflight(remote_model, self._assembled(), context_profile="auto", kv_cache="auto", thinking=False)
        self.backend.prepare_request()
        with patch("backend.models.ollama_backend.run_h3_pipeline", return_value={"prompt": "OK"}):
            self.backend.generate(
                remote_model, self._assembled(), "session", thinking=False, seed=1,
                unload_after=False, runtime_plan=plan,
            )

        self.assertEqual(self.backend.retained_models, set())
        self.assertEqual(self.backend._retained_for(self.second_url), {"gemma4:test"})
        self.assertEqual(self.backend.retained_status(self.url)["writer_retained_models"], [])

    def test_converts_openai_multimodal_parts_to_native_ollama_images(self):
        converted = _ollama_messages([{
            "role": "user",
            "content": [
                {"type": "text", "text": "<Picture 1>"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                {"type": "text", "text": "<Video 1>"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,BBBB"}},
            ],
        }])

        self.assertEqual(converted, [{
            "role": "user",
            "content": "<Picture 1>\n\n<Video 1>",
            "images": ["AAAA", "BBBB"],
        }])

    def test_auto_context_is_explicit_and_capped_by_model_limit(self):
        plan = self.backend.preflight(
            self._model(), self._assembled(),
            context_profile="auto", kv_cache="auto", thinking=False,
        )

        self.assertEqual(plan["context_profile"], "low")
        self.assertEqual(plan["context_tokens"], 8192)
        self.assertEqual(plan["kv_cache"], "ollama")
        with self.assertRaises(ModelError) as manual:
            self.backend.preflight(
                self._model(), self._assembled(),
                context_profile="standard", kv_cache="auto", thinking=False,
            )
        self.assertEqual(manual.exception.code, "OLLAMA_MODEL_CONTEXT_LIMIT")

    def test_auto_context_rejects_a_request_larger_than_the_model_limit(self):
        assembled = self._assembled()
        assembled["messages"][1]["content"] = "x" * 20_000

        with self.assertRaises(ModelError) as raised:
            self.backend.preflight(
                self._model(), assembled,
                context_profile="auto", kv_cache="auto", thinking=False,
            )

        self.assertEqual(raised.exception.code, "OLLAMA_MODEL_CONTEXT_LIMIT")
        self.assertEqual(raised.exception.details["required_context_tokens"], 16384)
        self.assertEqual(raised.exception.details["model_context_limit"], 12288)

    def test_rejects_provider_managed_kv_and_unreported_thinking(self):
        model = self._model()
        with self.assertRaises(ModelError) as kv_error:
            self.backend.preflight(model, self._assembled(), context_profile="auto", kv_cache="q8", thinking=False)
        self.assertEqual(kv_error.exception.code, "OLLAMA_KV_MANAGED")
        model["thinking"] = False
        with self.assertRaises(ModelError) as thinking_error:
            self.backend.preflight(model, self._assembled(), context_profile="auto", kv_cache="auto", thinking=True)
        self.assertEqual(thinking_error.exception.code, "OLLAMA_THINKING_UNAVAILABLE")

    def test_native_stream_sends_num_ctx_images_and_keep_alive(self):
        result = self.backend._chat_completion(
            "gemma4:test", {"context_tokens": 8192},
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            }],
            temperature=1.0, top_p=0.95, top_k=64, max_tokens=1536, seed=42, thinking=True,
        )

        self.assertEqual(result["choices"][0]["message"]["content"], "OLLAMA_OK")
        self.assertEqual(result["usage"], {"prompt_tokens": 21, "completion_tokens": 4})
        payload = next(payload for method, path, payload in _FakeOllamaHandler.requests if path == "/api/chat")
        self.assertEqual(payload["options"]["num_ctx"], 8192)
        self.assertEqual(payload["messages"][0]["images"], ["AAAA"])
        self.assertEqual(payload["keep_alive"], -1)
        self.assertTrue(payload["think"])

    def test_unloads_after_success_and_stream_error_when_keep_loaded_is_off(self):
        model = self._model()
        plan = self.backend.preflight(model, self._assembled(), context_profile="auto", kv_cache="auto", thinking=False)
        fake_result = {"prompt": "OK"}
        self.backend.prepare_request()
        with patch("backend.models.ollama_backend.run_h3_pipeline", return_value=fake_result):
            result = self.backend.generate(
                model, self._assembled(), "session", thinking=False, seed=1,
                unload_after=True, runtime_plan=plan,
            )
        self.assertEqual(result["prompt"], "OK")
        self.assertTrue(any(path == "/api/generate" and payload["keep_alive"] == 0 for _, path, payload in _FakeOllamaHandler.requests))

        _FakeOllamaHandler.requests = []
        self.backend.prepare_request()
        with patch("backend.models.ollama_backend.run_h3_pipeline", side_effect=ModelError("OLLAMA_STREAM_ERROR", "runner stopped")):
            with self.assertRaises(ModelError) as error:
                self.backend.generate(
                    model, self._assembled(), "session", thinking=False, seed=1,
                    unload_after=True, runtime_plan=plan,
                )
        self.assertEqual(error.exception.code, "OLLAMA_STREAM_ERROR")
        self.assertTrue(any(path == "/api/generate" and payload["keep_alive"] == 0 for _, path, payload in _FakeOllamaHandler.requests))

    def test_keep_loaded_skips_final_unload(self):
        model = self._model()
        plan = self.backend.preflight(model, self._assembled(), context_profile="auto", kv_cache="auto", thinking=False)
        self.backend.prepare_request()
        with patch("backend.models.ollama_backend.run_h3_pipeline", return_value={"prompt": "OK"}):
            self.backend.generate(
                model, self._assembled(), "session", thinking=False, seed=1,
                unload_after=False, runtime_plan=plan,
            )
        self.assertFalse(any(path == "/api/generate" for _, path, _ in _FakeOllamaHandler.requests))
        self.assertEqual(self.backend.retained_models, {"gemma4:test"})

    def test_status_reconciles_writer_retained_models_with_ollama(self):
        self.backend.retained_models.update({"gemma4:test", "gemma4:gone"})
        self.backend.model_name = "gemma4:test"
        _FakeOllamaHandler.running_models = [{"model": "gemma4:test", "context_length": 8192}]

        status = self.backend.status()

        self.assertEqual(status["writer_retained_models"], ["gemma4:test"])
        self.assertEqual(self.backend.retained_models, {"gemma4:test"})

    def test_targeted_unload_forgets_only_requested_model(self):
        self.backend.retained_models.update({"gemma4:test", "gemma4:other"})

        self.backend.unload("gemma4:test")

        self.assertEqual(self.backend.retained_models, {"gemma4:other"})
        unloads = [payload for _, path, payload in _FakeOllamaHandler.requests if path == "/api/generate"]
        self.assertEqual(unloads[-1], {"model": "gemma4:test", "keep_alive": 0, "stream": False})

    def test_empty_retained_status_does_not_contact_ollama(self):
        _FakeOllamaHandler.requests = []

        status = self.backend.retained_status()

        self.assertEqual(status["writer_retained_models"], [])
        self.assertEqual(_FakeOllamaHandler.requests, [])

    def test_stop_and_unload_overrides_keep_loaded(self):
        model = self._model()
        plan = self.backend.preflight(model, self._assembled(), context_profile="auto", kv_cache="auto", thinking=False)
        self.backend.prepare_request()
        self.backend.request_unload()
        with patch("backend.models.ollama_backend.run_h3_pipeline", side_effect=ModelError("GENERATION_CANCELLED", "Generation was cancelled.")):
            with self.assertRaises(ModelError) as error:
                self.backend.generate(
                    model, self._assembled(), "session", thinking=False, seed=1,
                    unload_after=False, runtime_plan=plan,
                )
        self.assertEqual(error.exception.code, "GENERATION_CANCELLED")
        self.assertTrue(any(path == "/api/generate" and payload["keep_alive"] == 0 for _, path, payload in _FakeOllamaHandler.requests))
        self.assertNotIn("gemma4:test", self.backend.retained_models)

    def test_cancel_interrupts_native_stream(self):
        result = {}

        def run_request():
            try:
                self.backend._chat_completion(
                    "gemma4:test", {"context_tokens": 8192},
                    messages=[{"role": "user", "content": "slow"}],
                    temperature=1.0, top_p=0.95, top_k=999, max_tokens=1536, seed=None, thinking=False,
                )
            except Exception as error:
                result["error"] = error

        self.backend.prepare_request()
        thread = threading.Thread(target=run_request)
        thread.start()
        self.assertTrue(_FakeOllamaHandler.slow_started.wait(timeout=2))
        self.backend.cancel()
        thread.join(timeout=2)

        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result.get("error"), ModelError)
        self.assertEqual(result["error"].code, "GENERATION_CANCELLED")


if __name__ == "__main__":
    unittest.main()
