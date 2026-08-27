"""Standalone additions to the upstream external llama.cpp transport."""

from __future__ import annotations

import http.client
import json
from typing import Any, Callable
from urllib.parse import urlsplit


def _stream_with_reasoning(
    backend: Any,
    endpoint: str,
    payload: dict[str, Any],
    model_error: type[Exception],
    token_estimator: Callable[[str], int],
) -> dict[str, Any]:
    parsed = urlsplit(endpoint)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=900)
    body = json.dumps(payload).encode("utf-8")
    with backend._connection_lock:
        backend._connection = connection
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
            raise model_error(
                "EXTERNAL_SERVER_ERROR",
                message or f"The llama.cpp server returned HTTP {response.status}.",
                {"url": endpoint, "status": response.status, "response": data},
            )
        while True:
            if backend.cancel_event.is_set():
                raise model_error("GENERATION_CANCELLED", "Generation was cancelled.")
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
            content = delta.get("content")
            reasoning = delta.get("reasoning_content")
            if isinstance(content, str):
                content_parts.append(content)
            if isinstance(reasoning, str):
                reasoning_parts.append(reasoning)
            if choice.get("finish_reason") is not None:
                finish_reason = choice["finish_reason"]
    except model_error:
        raise
    except (OSError, TimeoutError, AttributeError, ValueError, http.client.HTTPException) as error:
        if backend.cancel_event.is_set():
            raise model_error("GENERATION_CANCELLED", "Generation was cancelled.") from error
        raise model_error(
            "EXTERNAL_SERVER_UNAVAILABLE",
            "The connection to the local llama.cpp server was interrupted.",
            {"url": endpoint, "reason": str(error)},
        ) from error
    finally:
        with backend._connection_lock:
            if backend._connection is connection:
                backend._connection = None
        connection.close()
    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    if not usage:
        usage = {
            "prompt_tokens": 0,
            "completion_tokens": token_estimator(content + reasoning),
        }
    message: dict[str, Any] = {"content": content}
    if reasoning:
        message["reasoning_content"] = reasoning
    return {
        "choices": [{"message": message, "finish_reason": finish_reason or "stop"}],
        "usage": usage,
    }


class _ManagedChatHandler:
    def __init__(
        self,
        backend: Any,
        endpoint: str,
        remote_model: str,
        model_info: dict[str, Any],
        sampling_options: Callable[..., dict[str, Any]],
        template_kwargs: Callable[..., dict[str, Any]],
    ) -> None:
        self.backend = backend
        self.endpoint = endpoint
        self.remote_model = remote_model
        self.model_info = model_info
        self.sampling_options = sampling_options
        self.template_kwargs = template_kwargs

    def __call__(
        self,
        *,
        messages: list[dict[str, Any]],
        temperature: float,
        top_p: float,
        top_k: int,
        max_tokens: int,
        seed: int | None,
        enable_thinking: bool,
        **_unused: Any,
    ) -> dict[str, Any]:
        fallback = {
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "min_p": 0.0,
            "presence_penalty": 0.0,
            "repeat_penalty": 1.0,
        }
        sampling = self.sampling_options(
            self.model_info,
            thinking=enable_thinking,
            fallback=fallback,
        )
        template_options = self.template_kwargs(
            self.model_info,
            thinking=enable_thinking,
        )
        if enable_thinking and self.model_info.get("reasoning_effort"):
            template_options["reasoning_effort"] = self.model_info["reasoning_effort"]
        payload: dict[str, Any] = {
            "model": self.remote_model,
            "messages": messages,
            "temperature": sampling["temperature"],
            "top_p": sampling["top_p"],
            "top_k": sampling["top_k"],
            "max_tokens": max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
            "chat_template_kwargs": template_options,
        }
        if enable_thinking and self.model_info.get("architecture_adapter") in {"qwen35", "qwen35moe"}:
            # llama.cpp's default parser streams reasoning separately, while the
            # upstream transport currently consumes content deltas. Legacy mode
            # keeps the tags in content as well, so the existing Qwen contract can
            # split and measure reasoning without a second transport implementation.
            payload["reasoning_format"] = "deepseek-legacy"
        if self.model_info.get("model_policy"):
            payload.update({
                "min_p": sampling["min_p"],
                "presence_penalty": sampling["presence_penalty"],
                "repeat_penalty": sampling["repeat_penalty"],
            })
        if seed is not None:
            payload["seed"] = seed
        return self.backend._request_chat_completion_stream(self.endpoint, payload)


def standalone_external_backend_class(
    upstream_class: type,
    sampling_options: Callable[..., dict[str, Any]],
    template_kwargs: Callable[..., dict[str, Any]],
    model_error: type[Exception],
    token_estimator: Callable[[str], int],
) -> type:
    """Build a narrow subclass without importing the upstream before host setup."""

    class StandaloneExternalServerBackend(upstream_class):
        def __init__(self) -> None:
            super().__init__()
            self._managed_model_info: dict[str, Any] = {}

        def configure_managed_model(self, model_info: dict[str, Any]) -> None:
            self._managed_model_info = model_info.copy()

        def _connect(self, model_info: dict[str, Any]) -> None:
            self.chat_handler = _ManagedChatHandler(
                self,
                model_info["endpoint"],
                model_info["remote_model"],
                self._managed_model_info,
                sampling_options,
                template_kwargs,
            )
            self.model_id = model_info["id"]

        def _request_chat_completion_stream(
            self,
            endpoint: str,
            payload: dict[str, Any],
        ) -> dict[str, Any]:
            return _stream_with_reasoning(
                self,
                endpoint,
                payload,
                model_error,
                token_estimator,
            )

    return StandaloneExternalServerBackend
