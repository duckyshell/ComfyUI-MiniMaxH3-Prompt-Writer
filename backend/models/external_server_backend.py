from __future__ import annotations

import http.client
import json
import threading
from typing import Any, Callable
from urllib.parse import urlsplit

from ..context import (
    CHAT_TEMPLATE_OVERHEAD_TOKENS,
    CONTEXT_SAFETY_TOKENS,
    ESTIMATED_VISUAL_TOKENS,
    estimate_text_tokens,
)
from ..h3_pipeline import run_h3_pipeline, validate_media_capabilities
from .contract import ModelError


DEFAULT_SERVER_URL = "http://127.0.0.1:8080"
CONNECT_TIMEOUT_SECONDS = 3
REQUEST_TIMEOUT_SECONDS = 900


def _split_embedded_reasoning(content: str) -> tuple[str, str | None]:
    stripped = content.lstrip()
    if not stripped.startswith("<think>"):
        return content, None
    closing_tag = "</think>"
    if closing_tag not in stripped:
        raise ModelError(
            "THINKING_TRUNCATED",
            "The external llama.cpp server returned reasoning without a final prompt.",
        )
    reasoning, final = stripped[len("<think>"):].split(closing_tag, 1)
    return final.lstrip(), reasoning.strip()


def normalize_server_url(value: str | None) -> str:
    raw = (value or DEFAULT_SERVER_URL).strip()
    parsed = urlsplit(raw)
    if parsed.scheme != "http" or not parsed.hostname:
        raise ModelError(
            "INVALID_EXTERNAL_SERVER_URL",
            "Enter a local llama.cpp server URL such as http://127.0.0.1:8080.",
        )
    if parsed.hostname.lower() not in {"127.0.0.1", "localhost", "::1"}:
        raise ModelError(
            "EXTERNAL_SERVER_NOT_LOCAL",
            "H3 Prompt Writer only connects to a llama.cpp server on this computer.",
        )
    path = parsed.path.rstrip("/")
    if path == "/v1":
        path = ""
    if path:
        raise ModelError(
            "INVALID_EXTERNAL_SERVER_URL",
            "Use the server root URL without an API path, for example http://127.0.0.1:8080.",
        )
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ModelError(
            "INVALID_EXTERNAL_SERVER_URL",
            "The llama.cpp server URL cannot contain credentials, a query, or a fragment.",
        )
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname and not parsed.hostname.startswith("[") else parsed.hostname
    port = parsed.port or 80
    return f"http://{host}:{port}"


class _RemoteChatHandler:
    def __init__(
        self,
        backend: "ExternalServerBackend",
        endpoint: str,
        remote_model: str,
    ) -> None:
        self.backend = backend
        self.endpoint = endpoint
        self.remote_model = remote_model

    def __call__(
        self,
        *,
        messages: list[dict[str, Any]],
        temperature: float,
        top_p: float,
        top_k: int,
        max_tokens: int | None,
        seed: int | None,
        **_unused: Any,
    ) -> dict[str, Any]:
        del max_tokens
        payload: dict[str, Any] = {
            "model": self.remote_model,
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if seed is not None:
            payload["seed"] = seed
        return self.backend._request_chat_completion_stream(
            self.endpoint,
            payload,
        )


class ExternalServerBackend:
    manages_gpu_memory = False
    externally_managed = True

    def __init__(self) -> None:
        self.model_id: str | None = None
        self.chat_handler: _RemoteChatHandler | None = None
        self.cancel_event = threading.Event()
        self.lock = threading.RLock()
        self._connection: http.client.HTTPConnection | None = None
        self._connection_lock = threading.Lock()

    def status(self) -> dict[str, Any]:
        return {
            "loaded_model_id": None,
            "loaded": False,
            "loaded_context_tokens": None,
            "loaded_kv_cache": None,
            "externally_managed": True,
            "external_connected": self.model_id is not None,
            "external_model_id": self.model_id,
        }

    def prepare_request(self) -> None:
        self.cancel_event.clear()

    def cancel(self) -> bool:
        self.cancel_event.set()
        with self._connection_lock:
            connection = self._connection
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
        return True

    def request_unload(self) -> bool:
        return self.cancel()

    def _request_json(
        self,
        endpoint: str,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        timeout: int,
    ) -> dict[str, Any]:
        parsed = urlsplit(endpoint)
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        with self._connection_lock:
            self._connection = connection
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
        except (OSError, TimeoutError, AttributeError, ValueError, http.client.HTTPException) as error:
            if self.cancel_event.is_set():
                raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.") from error
            raise ModelError(
                "EXTERNAL_SERVER_UNAVAILABLE",
                "H3 Prompt Writer could not reach the local llama.cpp server.",
                {"url": endpoint, "reason": str(error)},
            ) from error
        finally:
            with self._connection_lock:
                if self._connection is connection:
                    self._connection = None
            connection.close()
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ModelError(
                "EXTERNAL_SERVER_INVALID_RESPONSE",
                "The llama.cpp server returned an invalid JSON response.",
                {"url": endpoint, "status": response.status},
            ) from error
        if not 200 <= response.status < 300:
            remote_error = data.get("error") if isinstance(data, dict) else None
            message = remote_error.get("message") if isinstance(remote_error, dict) else None
            raise ModelError(
                "EXTERNAL_SERVER_ERROR",
                message or f"The llama.cpp server returned HTTP {response.status}.",
                {"url": endpoint, "status": response.status, "response": data},
            )
        if not isinstance(data, dict):
            raise ModelError(
                "EXTERNAL_SERVER_INVALID_RESPONSE",
                "The llama.cpp server returned an unexpected response.",
                {"url": endpoint},
            )
        return data

    def _request_chat_completion_stream(
        self,
        endpoint: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        parsed = urlsplit(endpoint)
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=REQUEST_TIMEOUT_SECONDS)
        body = json.dumps(payload).encode("utf-8")
        with self._connection_lock:
            self._connection = connection
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        finish_reason = None
        usage: dict[str, Any] = {}
        try:
            connection.request(
                "POST",
                "/v1/chat/completions",
                body=body,
                headers={"Accept": "text/event-stream", "Content-Type": "application/json"},
            )
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                raw = response.read()
                try:
                    data = json.loads(raw.decode("utf-8")) if raw else {}
                except (UnicodeDecodeError, json.JSONDecodeError):
                    data = {}
                remote_error = data.get("error") if isinstance(data, dict) else None
                message = remote_error.get("message") if isinstance(remote_error, dict) else None
                raise ModelError(
                    "EXTERNAL_SERVER_ERROR",
                    message or f"The llama.cpp server returned HTTP {response.status}.",
                    {"url": endpoint, "status": response.status, "response": data},
                )
            while True:
                if self.cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.")
                line = response.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="replace").strip()
                if not decoded.startswith("data:"):
                    continue
                event = decoded[5:].strip()
                if event == "[DONE]":
                    break
                try:
                    chunk = json.loads(event)
                except json.JSONDecodeError:
                    continue
                if isinstance(chunk.get("usage"), dict):
                    usage = chunk["usage"]
                choices = chunk.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue
                choice = choices[0] if isinstance(choices[0], dict) else {}
                delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                text = delta.get("content")
                if isinstance(text, str):
                    content_parts.append(text)
                reasoning = delta.get("reasoning_content")
                if isinstance(reasoning, str):
                    reasoning_parts.append(reasoning)
                if choice.get("finish_reason") is not None:
                    finish_reason = choice["finish_reason"]
        except ModelError:
            raise
        except (OSError, TimeoutError, AttributeError, ValueError, http.client.HTTPException) as error:
            if self.cancel_event.is_set():
                raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.") from error
            raise ModelError(
                "EXTERNAL_SERVER_UNAVAILABLE",
                "The connection to the local llama.cpp server was interrupted.",
                {"url": endpoint, "reason": str(error)},
            ) from error
        finally:
            with self._connection_lock:
                if self._connection is connection:
                    self._connection = None
            connection.close()
        content = "".join(content_parts)
        reasoning = "".join(reasoning_parts)
        if not reasoning:
            content, embedded_reasoning = _split_embedded_reasoning(content)
            reasoning = embedded_reasoning or ""
        if not usage:
            usage = {
                "prompt_tokens": 0,
                "completion_tokens": estimate_text_tokens(content + reasoning),
            }
        message: dict[str, Any] = {"content": content}
        if reasoning:
            message["reasoning_content"] = reasoning
        return {
            "choices": [{"message": message, "finish_reason": finish_reason or "stop"}],
            "usage": usage,
        }

    @staticmethod
    def _context_tokens(props: dict[str, Any]) -> int:
        candidates = (
            props.get("n_ctx"),
            props.get("default_generation_settings", {}).get("n_ctx")
            if isinstance(props.get("default_generation_settings"), dict)
            else None,
        )
        for value in candidates:
            if isinstance(value, int) and value > 0:
                return value
        return 16_384

    def probe_model(self, config: dict[str, Any]) -> dict[str, Any]:
        endpoint = normalize_server_url(str(config.get("url") or ""))
        self._request_json(endpoint, "GET", "/health", timeout=CONNECT_TIMEOUT_SECONDS)
        props = self._request_json(endpoint, "GET", "/props", timeout=CONNECT_TIMEOUT_SECONDS)
        models = self._request_json(endpoint, "GET", "/v1/models", timeout=CONNECT_TIMEOUT_SECONDS)
        entries = models.get("data")
        if not isinstance(entries, list) or not entries:
            raise ModelError(
                "EXTERNAL_MODEL_NOT_FOUND",
                "The llama.cpp server did not report a loaded model.",
                {"url": endpoint},
            )
        requested_model = str(config.get("model") or "").strip()
        selected = next(
            (item for item in entries if isinstance(item, dict) and item.get("id") == requested_model),
            None,
        ) if requested_model else next((item for item in entries if isinstance(item, dict)), None)
        if selected is None:
            raise ModelError(
                "EXTERNAL_MODEL_NOT_FOUND",
                "The requested model is not loaded by this llama.cpp server.",
                {"url": endpoint, "model": requested_model},
            )
        remote_model = str(selected.get("id") or "").strip()
        if not remote_model:
            raise ModelError("EXTERNAL_MODEL_NOT_FOUND", "The llama.cpp server returned an unnamed model.")
        modalities = props.get("modalities")
        capabilities = selected.get("capabilities")
        has_multimodal = (
            isinstance(modalities, dict) and bool(modalities.get("vision"))
        ) or (
            isinstance(capabilities, list) and "multimodal" in capabilities
        )
        context_tokens = self._context_tokens(props)
        name = remote_model.replace("\\", "/").rsplit("/", 1)[-1]
        return {
            "id": f"external::{endpoint}::{remote_model}",
            "name": name,
            "family": "external",
            "format": "API",
            "role": "external-server",
            "runtime_ready": True,
            "missing_dependencies": [],
            "capabilities": {"images": has_multimodal, "video_frames": has_multimodal, "audio": False},
            "thinking": True,
            "thinking_managed_by_server": True,
            "recommended_context": "external",
            "endpoint": endpoint,
            "remote_model": remote_model,
            "server_context_tokens": context_tokens,
            "externally_managed": True,
            "source_label": f"External llama.cpp · {endpoint}",
        }

    def preflight(
        self,
        model_info: dict[str, Any],
        assembled: dict[str, Any],
        *,
        context_profile: str | None,
        kv_cache: str | None,
        thinking: bool,
    ) -> dict[str, Any]:
        del thinking
        if (context_profile or "auto").lower() != "auto" or (kv_cache or "auto").lower() != "auto":
            raise ModelError(
                "EXTERNAL_RUNTIME_MANAGED",
                "Context and KV cache are controlled by the external llama.cpp server. Set both options to Auto.",
            )
        context_tokens = int(model_info.get("server_context_tokens") or 16_384)
        visual_input_count = sum(
            1 for item in assembled.get("media_inputs", []) if item.get("type") in {"image", "video"}
        )
        text = "\n\n".join(
            str(message.get("content") or "")
            for message in assembled.get("messages", [])
            if isinstance(message.get("content"), str)
        )
        estimated_text_tokens = estimate_text_tokens(text)
        estimated_input_tokens = (
            estimated_text_tokens
            + visual_input_count * ESTIMATED_VISUAL_TOKENS
            + CHAT_TEMPLATE_OVERHEAD_TOKENS
        )
        minimum_required = estimated_input_tokens + CONTEXT_SAFETY_TOKENS
        if minimum_required > context_tokens:
            raise ModelError(
                "CONTEXT_BUDGET_EXCEEDED",
                "This request does not fit the context configured on the external llama.cpp server.",
                {
                    "estimated_input_tokens": estimated_input_tokens,
                    "safety_tokens": CONTEXT_SAFETY_TOKENS,
                    "context_tokens": context_tokens,
                    "suggestion": "Restart llama-server with a larger context or remove references.",
                },
            )
        return {
            "requested_context_profile": "auto",
            "context_profile": "external",
            "context_tokens": context_tokens,
            "requested_kv_cache": "auto",
            "kv_cache": "server",
            "thinking": False,
            "estimated_text_tokens": estimated_text_tokens,
            "estimated_input_tokens": estimated_input_tokens,
            "visual_input_count": visual_input_count,
            "max_output_tokens": None,
            "reserved_output_tokens": CONTEXT_SAFETY_TOKENS,
            "thinking_budget_reduced": False,
            "output_tokens_managed_by_server": True,
        }

    def _connect(self, model_info: dict[str, Any]) -> None:
        self.chat_handler = _RemoteChatHandler(
            self,
            model_info["endpoint"],
            model_info["remote_model"],
        )
        self.model_id = model_info["id"]

    def generate(
        self,
        model_info: dict[str, Any],
        assembled: dict[str, Any],
        session_id: str,
        *,
        thinking: bool,
        seed: int | None,
        unload_after: bool,
        context_profile: str | None = None,
        kv_cache: str | None = None,
        runtime_plan: dict[str, Any] | None = None,
        on_phase: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        del unload_after, thinking
        with self.lock:
            validate_media_capabilities(model_info, assembled)
            try:
                runtime_plan = runtime_plan or self.preflight(
                    model_info,
                    assembled,
                    context_profile=context_profile,
                    kv_cache=kv_cache,
                    thinking=thinking,
                )
                if on_phase:
                    on_phase("loading_model")
                self._connect(model_info)
                if self.cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Generation was cancelled after model loading.")

                def complete(
                    *,
                    messages: list[dict[str, Any]],
                    temperature: float,
                    top_p: float,
                    top_k: int,
                    max_tokens: int | None,
                    seed: int | None,
                    thinking: bool,
                    purpose: str,
                ) -> dict[str, Any]:
                    del purpose, thinking
                    if self.chat_handler is None:
                        raise ModelError(
                            "EXTERNAL_SERVER_UNAVAILABLE",
                            "The local llama.cpp server is not connected.",
                        )
                    return self.chat_handler(
                        messages=messages,
                        temperature=temperature,
                        top_p=top_p,
                        top_k=top_k,
                        max_tokens=max_tokens,
                        seed=seed,
                    )

                result = run_h3_pipeline(
                    model_info,
                    assembled,
                    session_id,
                    runtime_plan,
                    complete=complete,
                    count_text_tokens=lambda text: estimate_text_tokens(text) + 1,
                    is_cancelled=self.cancel_event.is_set,
                    thinking=False,
                    seed=seed,
                    on_phase=on_phase,
                )
                return {
                    **result,
                    "cold_start": None,
                    "model_load_seconds": None,
                    "context_profile": runtime_plan["context_profile"],
                    "context_tokens": runtime_plan["context_tokens"],
                    "kv_cache": runtime_plan["kv_cache"],
                    "max_output_tokens": runtime_plan["max_output_tokens"],
                    "thinking_budget_reduced": runtime_plan["thinking_budget_reduced"],
                    "external_server": True,
                    "server_managed_lifecycle": True,
                }
            except ModelError:
                raise
            except MemoryError as error:
                raise ModelError("GENERATION_OOM", "GGUF generation ran out of memory.") from error
            except Exception as error:
                raise ModelError("GENERATION_FAILED", "The GGUF model could not generate a prompt.", str(error)) from error


BACKEND = ExternalServerBackend()
