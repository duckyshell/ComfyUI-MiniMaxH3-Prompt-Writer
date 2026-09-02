import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from backend.models.api_provider_backend import (
    ApiConnection,
    ApiProviderBackend,
    _ApiChatHandler,
    normalize_api_base_url,
)
from backend.models.contract import ModelError


class _FakeApiHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests = []
    slow_started = threading.Event()

    def log_message(self, *_args):
        return

    @classmethod
    def reset(cls):
        cls.requests = []
        cls.slow_started.clear()

    def _json(self, payload, status=200, headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _text(self, payload, status=200):
        body = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        type(self).requests.append(("GET", self.path, dict(self.headers), None))
        if self.path == "/v1/models":
            self._json({
                "data": [
                    {
                        "id": "vision-reasoning-model",
                        "context_length": 65536,
                        "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
                        "supported_parameters": ["reasoning", "temperature", "top_p"],
                        "reasoning": {"supported_efforts": ["low", "medium"], "mandatory": False},
                        "pricing": {"prompt": "0.000001", "completion": "0.000002"},
                        "top_provider": {"max_completion_tokens": 8192},
                    },
                    {
                        "id": "text-only-model",
                        "context_length": 8192,
                        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                    },
                    {"id": "lm-studio-vision-model"},
                    {"id": "embedding-model"},
                ],
            }, headers={"X-Request-ID": "models-request"})
        elif self.path == "/api/v1/models":
            self._json({
                "models": [
                    {
                        "type": "llm",
                        "key": "lm-studio-vision-model",
                        "max_context_length": 131072,
                        "loaded_instances": [{"config": {"context_length": 8192}}],
                        "capabilities": {"vision": True},
                    },
                    {"type": "embedding", "key": "embedding-model", "max_context_length": 2048},
                ],
            })
        elif self.path == "/missing/v1/models":
            self._json({"error": {"message": "not found"}}, 404)
        elif self.path == "/plain-404/v1/models":
            self._text("not found", 404)
        else:
            self._json({"error": {"message": "not found"}}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        type(self).requests.append(("POST", self.path, dict(self.headers), payload))
        if not self.path.endswith("/chat/completions"):
            self._json({"error": {"message": "not found"}}, 404)
            return
        model = payload.get("model")
        if model == "rate-limited":
            self._json(
                {"error": {"message": "quota reached", "type": "rate_limit", "code": "rate_limit_exceeded"}},
                429,
                {"Retry-After": "7", "X-Request-ID": "rate-request"},
            )
            return
        if model == "slow-model":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            type(self).slow_started.set()
            try:
                for index in range(100):
                    chunk = {"choices": [{"delta": {"content": str(index)}, "finish_reason": None}]}
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    time.sleep(0.04)
            except OSError:
                pass
            return
        if model == "stream-error":
            body = (
                'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
                'data: {"error":{"message":"upstream stopped"}}\n\n'
            ).encode("utf-8")
        else:
            chunks = [
                {"choices": [{"delta": {"content": "API_"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "OK"}, "finish_reason": "stop"}]},
                {
                    "choices": [],
                    "usage": {"prompt_tokens": 21, "completion_tokens": 4, "total_tokens": 25, "cost": 0.0123},
                    "provider": "fake-upstream",
                },
            ]
            body = (": keep-alive\n\n" + "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Request-ID", "chat-request")
        self.end_headers()
        self.wfile.write(body)


class _QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, _request, _client_address):
        return


class ApiProviderBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _QuietThreadingHTTPServer(("127.0.0.1", 0), _FakeApiHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        _FakeApiHandler.reset()
        self.backend = ApiProviderBackend()

    def _connection(self, preset="custom", key="secret-test-key", **kwargs):
        return ApiConnection(
            id="test-connection",
            preset=preset,
            base_url=self.base_url,
            api_key=key,
            custom_images=kwargs.get("custom_images", True),
            custom_context_tokens=kwargs.get("custom_context_tokens", 32768),
            reasoning_effort=kwargs.get("reasoning_effort", "minimal"),
            compatibility_profile=kwargs.get("compatibility_profile", "generic"),
        )

    def test_custom_url_accepts_loopback_and_private_lan_http_but_requires_https_for_public_hosts(self):
        self.assertEqual(normalize_api_base_url("custom", self.base_url), self.base_url)
        private_urls = (
            "http://10.0.0.25:8000/v1",
            "http://172.16.0.25:8000/v1",
            "http://172.31.255.254:8000/v1",
            "http://192.168.1.25:8000/v1",
            "http://[fd12:3456:789a::25]:8000/v1",
        )
        for url in private_urls:
            with self.subTest(url=url):
                self.assertEqual(normalize_api_base_url("custom", url), url)
        self.assertEqual(normalize_api_base_url("custom", "https://example.com/v1/"), "https://example.com/v1")
        for url in ("http://example.com/v1", "http://172.32.0.1/v1", "http://192.0.2.25/v1"):
            with self.subTest(url=url), self.assertRaises(ModelError) as insecure:
                normalize_api_base_url("custom", url)
            self.assertEqual(insecure.exception.code, "API_BASE_URL_INSECURE")
        with self.assertRaises(ModelError) as malformed_port:
            normalize_api_base_url("custom", "https://example.com:not-a-port/v1")
        self.assertEqual(malformed_port.exception.code, "API_BASE_URL_INVALID")

    def test_custom_url_keeps_special_network_addresses_blocked(self):
        blocked_urls = (
            "https://169.254.169.254/latest",
            "https://0.0.0.0/v1",
            "https://224.0.0.1/v1",
            "https://[fe80::1]/v1",
            "https://[ff02::1]/v1",
            "https://[::]/v1",
            "https://metadata.google.internal/latest",
        )
        for url in blocked_urls:
            with self.subTest(url=url), self.assertRaises(ModelError) as blocked:
                normalize_api_base_url("custom", url)
            self.assertEqual(blocked.exception.code, "API_BASE_URL_BLOCKED")

    def test_probe_keeps_key_server_side_and_normalizes_rich_model_metadata(self):
        result = self.backend.probe({
            "preset": "custom",
            "base_url": self.base_url,
            "model_id": "vision-reasoning-model",
            "credential": {"source": "session", "value": "secret-test-key"},
            "custom_capabilities": {"images": False, "context_tokens": 16384},
        })

        self.assertNotIn("secret-test-key", json.dumps(result))
        self.assertEqual(result["connection"]["key_hint"], "…-key")
        model = result["model"]
        self.assertEqual(model["family"], "api")
        self.assertTrue(model["capabilities"]["images"])
        self.assertFalse(model["thinking"])
        self.assertEqual(model["model_context_limit"], 65536)
        self.assertEqual(model["max_output_tokens"], 8192)
        self.assertEqual(model["capability_source"], "official_metadata")
        request = _FakeApiHandler.requests[0]
        self.assertEqual(request[1], "/v1/models")
        self.assertEqual(request[2]["Authorization"], "Bearer secret-test-key")

    def test_custom_model_list_may_be_missing_when_manual_model_is_supplied(self):
        result = self.backend.probe({
            "preset": "custom",
            "base_url": f"http://127.0.0.1:{self.server.server_address[1]}/missing/v1",
            "model_id": "manual-vision-model",
            "credential": {"source": "session", "value": ""},
            "custom_capabilities": {"images": True, "context_tokens": 32768},
        })
        self.assertEqual(result["model"]["remote_model"], "manual-vision-model")
        self.assertEqual(result["model"]["capability_source"], "user_declared")
        self.assertTrue(result["model"]["capabilities"]["images"])

    def test_custom_missing_model_list_without_manual_model_is_an_endpoint_error(self):
        with self.assertRaises(ModelError) as raised:
            self.backend.probe({
                "preset": "custom",
                "base_url": f"http://127.0.0.1:{self.server.server_address[1]}/missing/v1",
                "model_id": "",
                "credential": {"source": "session", "value": ""},
                "custom_capabilities": {"images": True, "context_tokens": 32768},
            })
        self.assertEqual(raised.exception.code, "API_MODEL_NOT_FOUND")

    def test_non_json_http_error_keeps_http_status_instead_of_reporting_invalid_json(self):
        connection = self._connection()
        connection.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/plain-404/v1"
        with self.assertRaises(ModelError) as raised:
            self.backend._fetch_models(connection)
        self.assertEqual(raised.exception.code, "API_MODEL_NOT_FOUND")
        self.assertEqual(raised.exception.details["status"], 404)

    def test_private_lan_custom_endpoint_can_be_detected_as_lm_studio(self):
        connection = self._connection()
        connection.base_url = "http://192.168.178.20:1234/v1"
        response = {
            "models": [
                {
                    "type": "llm",
                    "key": "lan-lm-studio-model",
                    "max_context_length": 262144,
                    "capabilities": {"vision": True},
                }
            ]
        }
        with patch.object(self.backend, "_request_json", return_value=(response, {})) as request_json:
            metadata = self.backend._local_custom_model_metadata(connection)
        request_json.assert_called_once_with(connection, "GET", "/api/v1/models")
        self.assertEqual(connection.compatibility_profile, "lm_studio")
        self.assertIn("lan-lm-studio-model", metadata)

    def test_loopback_custom_enriches_lm_studio_vision_metadata(self):
        result = self.backend.probe({
            "preset": "custom",
            "base_url": self.base_url,
            "model_id": "lm-studio-vision-model",
            "credential": {"source": "session", "value": ""},
            "custom_capabilities": {"images": False},
        })
        model = result["model"]
        self.assertTrue(model["capabilities"]["images"])
        self.assertEqual(model["model_context_limit"], 8192)
        self.assertEqual(model["capability_source"], "official_metadata")
        self.assertEqual(result["connection"]["compatibility_profile"], "lm_studio")
        self.assertNotIn("embedding-model", [item["remote_model"] for item in result["models"]])

        connection = self.backend._get_connection(result["connection"]["id"])
        _ApiChatHandler(self.backend, connection, "lm-studio-vision-model")(
            messages=[{"role": "user", "content": "brief"}],
            temperature=1.0,
            top_p=0.95,
            top_k=64,
            max_tokens=1536,
            seed=None,
            thinking=False,
        )
        payload = _FakeApiHandler.requests[-1][3]
        self.assertEqual(payload["reasoning_effort"], "none")

    def test_only_session_credentials_are_accepted(self):
        self.assertEqual(
            self.backend._credential({"credential": {"source": "session", "value": "session-secret"}}, "openai"),
            "session-secret",
        )
        with self.assertRaises(ModelError) as environment:
            self.backend._credential(
                {"credential": {"source": "environment", "environment_name": "H3_TEST_API_KEY"}},
                "openai",
            )
        self.assertEqual(environment.exception.code, "API_CREDENTIAL_SOURCE_INVALID")

    def test_custom_provider_allows_an_empty_session_key(self):
        self.assertEqual(self.backend._credential({"credential": {"source": "session", "value": ""}}, "custom"), "")

    def test_openrouter_handler_uses_common_multimodal_contract_and_reasoning_adapter(self):
        connection = self._connection(preset="openrouter")
        handler = _ApiChatHandler(self.backend, connection, "vision-reasoning-model")
        messages = [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Contact sheet follows."},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
            ],
        }]

        response = handler(
            messages=messages,
            temperature=1.0,
            top_p=0.95,
            top_k=64,
            max_tokens=2048,
            seed=42,
            thinking=True,
        )

        self.assertEqual(response["choices"][0]["message"]["content"], "API_OK")
        payload = _FakeApiHandler.requests[-1][3]
        self.assertEqual(payload["messages"], messages)
        self.assertEqual(payload["max_tokens"], 2048)
        self.assertEqual(payload["reasoning"], {"enabled": True, "exclude": True})
        self.assertNotIn("top_k", payload)
        self.assertNotIn("seed", payload)
        self.assertNotIn("temperature", payload)
        self.assertEqual(response["usage"]["prompt_tokens"], 21)
        self.assertEqual(self.backend._provider_cost_usd, 0.0123)
        self.assertEqual(self.backend._upstream_providers, {"fake-upstream"})

    def test_multimodal_repair_continuation_replays_media_and_counts_both_requests(self):
        connection = self._connection(preset="custom")
        handler = _ApiChatHandler(self.backend, connection, "vision-reasoning-model")
        original = [
            {"role": "system", "content": "guide"},
            {"role": "user", "content": [
                {"type": "text", "text": "<Picture 1>: image reference."},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
                {"type": "text", "text": "Use every active reference."},
            ]},
        ]
        continuation = [
            *original,
            {"role": "assistant", "content": "draft missing <Picture 1>"},
            {"role": "user", "content": "Correct only the missing reference tag."},
        ]

        self.backend.prepare_request()
        for messages in (original, continuation):
            handler(
                messages=messages, temperature=0.3, top_p=0.9, top_k=40,
                max_tokens=1536, seed=7, thinking=False,
            )

        posts = [request for request in _FakeApiHandler.requests if request[0] == "POST"]
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0][3]["messages"], original)
        self.assertEqual(posts[1][3]["messages"], continuation)
        self.assertEqual(self.backend._request_count, 2)
        self.assertEqual(self.backend._usage_sources, ["reported", "reported"])
        self.assertNotIn("secret-test-key", json.dumps(posts[1][3]))

    def test_openai_adapter_uses_max_completion_tokens_and_store_false(self):
        connection = self._connection(preset="openai")
        handler = _ApiChatHandler(self.backend, connection, "plain-model")
        handler(
            messages=[{"role": "system", "content": "guide"}, {"role": "user", "content": "brief"}],
            temperature=0.8,
            top_p=0.9,
            top_k=64,
            max_tokens=1536,
            seed=None,
            thinking=False,
        )
        payload = _FakeApiHandler.requests[-1][3]
        self.assertEqual(payload["max_completion_tokens"], 1536)
        self.assertFalse(payload["store"])
        self.assertEqual(payload["stream_options"], {"include_usage": True})
        self.assertNotIn("max_tokens", payload)
        self.assertNotIn("temperature", payload)
        self.assertNotIn("top_p", payload)

    def test_gemini_adapter_reserves_reasoning_budget_and_omits_sampling(self):
        connection = self._connection(preset="gemini")
        handler = _ApiChatHandler(self.backend, connection, "gemini-3.6-flash")
        handler(
            messages=[{"role": "user", "content": "brief"}],
            temperature=1.0,
            top_p=0.95,
            top_k=64,
            max_tokens=1536,
            seed=None,
            thinking=False,
        )
        payload = _FakeApiHandler.requests[-1][3]
        self.assertEqual(payload["reasoning_effort"], "minimal")
        self.assertNotIn("max_tokens", payload)
        self.assertNotIn("temperature", payload)
        self.assertNotIn("top_p", payload)

        connection.reasoning_effort = "medium"
        handler(
            messages=[{"role": "user", "content": "brief"}],
            temperature=1.0,
            top_p=0.95,
            top_k=64,
            max_tokens=1536,
            seed=None,
            thinking=False,
        )
        payload = _FakeApiHandler.requests[-1][3]
        self.assertEqual(payload["reasoning_effort"], "medium")
        self.assertNotIn("max_tokens", payload)

    def test_provider_errors_are_normalized_without_echoing_request_content(self):
        connection = self._connection(preset="openrouter")
        handler = _ApiChatHandler(self.backend, connection, "rate-limited")
        with self.assertRaises(ModelError) as caught:
            handler(
                messages=[{"role": "user", "content": "private prompt"}],
                temperature=1.0,
                top_p=0.95,
                top_k=64,
                max_tokens=100,
                seed=None,
                thinking=False,
            )
        self.assertEqual(caught.exception.code, "API_RATE_LIMITED")
        self.assertEqual(caught.exception.details["retry_after"], "7")
        self.assertNotIn("private prompt", json.dumps(caught.exception.details))
        self.assertNotIn("secret-test-key", json.dumps(caught.exception.details))

    def test_in_stream_error_reports_partial_output_and_is_not_retried(self):
        connection = self._connection(preset="openrouter")
        handler = _ApiChatHandler(self.backend, connection, "stream-error")
        with self.assertRaises(ModelError) as caught:
            handler(
                messages=[{"role": "user", "content": "brief"}],
                temperature=1.0,
                top_p=0.95,
                top_k=64,
                max_tokens=100,
                seed=None,
                thinking=False,
            )
        self.assertEqual(caught.exception.code, "API_STREAM_INTERRUPTED")
        self.assertTrue(caught.exception.details["partial_output"])
        self.assertEqual(len([request for request in _FakeApiHandler.requests if request[0] == "POST"]), 1)

    def test_cancel_closes_the_active_stream(self):
        connection = self._connection()
        handler = _ApiChatHandler(self.backend, connection, "slow-model")
        result = {}

        def run_request():
            try:
                handler(
                    messages=[{"role": "user", "content": "slow"}],
                    temperature=1.0,
                    top_p=0.95,
                    top_k=64,
                    max_tokens=100,
                    seed=None,
                    thinking=False,
                )
            except Exception as error:
                result["error"] = error

        self.backend.prepare_request()
        thread = threading.Thread(target=run_request)
        thread.start()
        self.assertTrue(_FakeApiHandler.slow_started.wait(timeout=2))
        self.backend.cancel()
        thread.join(timeout=3)

        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result.get("error"), ModelError)
        self.assertEqual(result["error"].code, "GENERATION_CANCELLED")

    def test_preflight_enforces_provider_managed_runtime_and_declared_thinking(self):
        model = self.backend._model_info(self._connection(custom_images=True), "manual-model")
        assembled = {
            "messages": [{"role": "system", "content": "guide"}, {"role": "user", "content": "brief"}],
            "media_inputs": [],
        }
        plan = self.backend.preflight(model, assembled, context_profile="auto", kv_cache="auto", thinking=False)
        self.assertEqual(plan["kv_cache"], "provider")
        self.assertEqual(plan["context_profile"], "provider")
        self.assertEqual(plan["max_output_tokens"], 2_048)
        continuum_plan = self.backend.preflight(
            model,
            {**assembled, "input": {"mode": "T2VA", "continuum_stage": "plan"}},
            context_profile="auto",
            kv_cache="auto",
            thinking=False,
        )
        self.assertEqual(continuum_plan["max_output_tokens"], 8_192)
        music_plan = self.backend.preflight(
            model,
            {**assembled, "input": {"mode": "Music3"}},
            context_profile="auto",
            kv_cache="auto",
            thinking=False,
        )
        self.assertEqual(music_plan["max_output_tokens"], 1_536)
        with self.assertRaises(ModelError) as runtime:
            self.backend.preflight(model, assembled, context_profile="low", kv_cache="auto", thinking=False)
        self.assertEqual(runtime.exception.code, "API_RUNTIME_MANAGED")
        with self.assertRaises(ModelError) as thinking:
            self.backend.preflight(model, assembled, context_profile="auto", kv_cache="auto", thinking=True)
        self.assertEqual(thinking.exception.code, "API_THINKING_UNAVAILABLE")

    def test_generation_runs_through_shared_h3_pipeline_and_reports_provider_metrics(self):
        configured = self.backend.probe({
            "preset": "custom",
            "base_url": self.base_url,
            "model_id": "vision-reasoning-model",
            "credential": {"source": "session", "value": "secret-test-key"},
            "custom_capabilities": {"images": True, "context_tokens": 32768},
        })
        model = configured["model"]
        assembled = {
            "messages": [
                {"role": "system", "content": "Return one concise video prompt."},
                {"role": "user", "content": "A static wide shot of an empty room."},
            ],
            "media_inputs": [],
            "input": {
                "mode": "T2VA",
                "duration_seconds": 5,
                "creative_brief": "A static wide shot of an empty room.",
            },
        }
        plan = self.backend.preflight(model, assembled, context_profile="auto", kv_cache="auto", thinking=False)
        self.backend.prepare_request()

        result = self.backend.generate(
            model,
            assembled,
            "api-test-session",
            thinking=False,
            seed=42,
            unload_after=True,
            runtime_plan=plan,
        )

        self.assertEqual(result["prompt"], "API_OK")
        self.assertEqual(result["api_provider"], "custom")
        self.assertEqual(result["provider_request_count"], 1)
        self.assertEqual(result["usage_source"], "reported")
        self.assertEqual(result["provider_request_ids"], ["chat-request"])
        self.assertEqual(result["provider_cost_usd"], 0.0123)
        self.assertEqual(result["upstream_providers"], ["fake-upstream"])
        self.assertEqual(result["kv_cache"], "provider")


if __name__ == "__main__":
    unittest.main()
