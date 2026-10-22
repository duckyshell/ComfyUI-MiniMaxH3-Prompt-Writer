from __future__ import annotations

import base64
import binascii
import http.client
import json
import logging
import math
import threading
import time
from typing import Any, Callable
from urllib.parse import urlsplit, urlencode

from ..context import (
    CHAT_TEMPLATE_OVERHEAD_TOKENS,
    CONTEXT_SAFETY_TOKENS,
    ESTIMATED_VISUAL_TOKENS,
    estimate_text_tokens,
)
from ..h3_pipeline import run_h3_pipeline, validate_media_capabilities
from .contract import ModelError
from .external_lifecycle import RouterLifecycle


DEFAULT_SERVER_URL = "http://127.0.0.1:8080"
CONNECT_TIMEOUT_SECONDS = 3
REQUEST_TIMEOUT_SECONDS = 900
CHAT_MAX_MESSAGES = 200
CHAT_MAX_TOTAL_CHARACTERS = 400_000
CHAT_MAX_OUTPUT_TOKENS = 131_072
CHAT_MAX_IMAGES_PER_MESSAGE = 4
CHAT_MAX_VIDEOS_PER_MESSAGE = 1
CHAT_MAX_IMAGE_BYTES = 4 * 1024 * 1024
CHAT_MAX_VIDEO_BYTES = 10 * 1024 * 1024
CHAT_MAX_TOTAL_MEDIA_BYTES = 48 * 1024 * 1024
CHAT_IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
CHAT_VIDEO_MIME_TYPES = {"video/mp4", "video/webm", "video/mpeg"}
CHAT_ROLES = {"system", "user", "assistant"}
LOGGER = logging.getLogger(__name__)


def _chat_data_url(url: Any, *, label: str, allowed_types: set[str], max_bytes: int, details: dict[str, Any]) -> int:
    """Validate one media data URL and return its decoded size in bytes."""
    if not isinstance(url, str) or not url.startswith("data:"):
        raise ModelError("INVALID_REQUEST", f"{label} attachments must be data URLs.", details)
    header, separator, payload = url[5:].partition(",")
    if not separator or ";base64" not in header.lower():
        raise ModelError("INVALID_REQUEST", f"{label} attachments must be base64 data URLs.", details)
    mime = header.split(";", 1)[0].strip().lower()
    if mime not in allowed_types:
        raise ModelError(
            "INVALID_REQUEST",
            f"{label} type {mime or 'unknown'} is not supported.",
            {**details, "mime": mime},
        )
    estimated_bytes = len(payload) * 3 // 4
    if estimated_bytes > max_bytes + 3:
        raise ModelError(
            "INVALID_REQUEST",
            f"{label} attachments are limited to {max_bytes // (1024 * 1024)} MB.",
            {**details, "bytes": estimated_bytes},
        )
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise ModelError("INVALID_REQUEST", f"{label} attachment is not valid base64.", details) from None
    if not raw:
        raise ModelError("INVALID_REQUEST", f"{label} attachment is empty.", details)
    if len(raw) > max_bytes:
        raise ModelError(
            "INVALID_REQUEST",
            f"{label} attachments are limited to {max_bytes // (1024 * 1024)} MB.",
            {**details, "bytes": len(raw)},
        )
    return len(raw)


def _chat_content(content: Any, index: int, totals: dict[str, int]) -> tuple[str | list[dict[str, Any]], int]:
    """Normalize one message body, returning it plus its text character count."""
    if isinstance(content, str):
        return content, len(content)
    if not isinstance(content, list) or not content:
        raise ModelError("INVALID_REQUEST", "Every chat message needs text or media content.", {"index": index})
    parts: list[dict[str, Any]] = []
    text_characters = 0
    image_count = 0
    video_count = 0
    for part_index, part in enumerate(content):
        details = {"index": index, "part": part_index}
        if not isinstance(part, dict):
            raise ModelError("INVALID_REQUEST", "Every content part must be an object.", details)
        kind = part.get("type")
        if kind == "text":
            text = part.get("text")
            if not isinstance(text, str):
                raise ModelError("INVALID_REQUEST", "Text content parts need a text string.", details)
            if not text:
                continue
            text_characters += len(text)
            parts.append({"type": "text", "text": text})
            continue
        if kind == "image_url":
            payload = part.get("image_url")
            url = payload.get("url") if isinstance(payload, dict) else None
            image_count += 1
            if image_count > CHAT_MAX_IMAGES_PER_MESSAGE:
                raise ModelError(
                    "INVALID_REQUEST",
                    f"Messages accept at most {CHAT_MAX_IMAGES_PER_MESSAGE} images.",
                    details,
                )
            size = _chat_data_url(
                url,
                label="Image",
                allowed_types=CHAT_IMAGE_MIME_TYPES,
                max_bytes=CHAT_MAX_IMAGE_BYTES,
                details=details,
            )
            totals["images"] += 1
            totals["image_bytes"] += size
            parts.append({"type": "image_url", "image_url": {"url": url}})
        elif kind == "video_url":
            payload = part.get("video_url")
            url = payload.get("url") if isinstance(payload, dict) else None
            video_count += 1
            if video_count > CHAT_MAX_VIDEOS_PER_MESSAGE:
                raise ModelError(
                    "INVALID_REQUEST",
                    f"Messages accept at most {CHAT_MAX_VIDEOS_PER_MESSAGE} video.",
                    details,
                )
            size = _chat_data_url(
                url,
                label="Video",
                allowed_types=CHAT_VIDEO_MIME_TYPES,
                max_bytes=CHAT_MAX_VIDEO_BYTES,
                details=details,
            )
            totals["videos"] += 1
            totals["video_bytes"] += size
            parts.append({"type": "video_url", "video_url": {"url": url}})
        else:
            raise ModelError("INVALID_REQUEST", f"Unsupported content part type {kind!r}.", details)
        total_media_bytes = totals["image_bytes"] + totals["video_bytes"]
        if total_media_bytes > CHAT_MAX_TOTAL_MEDIA_BYTES:
            raise ModelError(
                "INVALID_REQUEST",
                f"Attached media is limited to {CHAT_MAX_TOTAL_MEDIA_BYTES // (1024 * 1024)} MB per request.",
                {**details, "bytes": total_media_bytes},
            )
    if not parts:
        raise ModelError("INVALID_REQUEST", "Every chat message needs text or media content.", {"index": index})
    return parts, text_characters


def normalize_chat_messages(messages: Any) -> list[dict[str, Any]]:
    if not isinstance(messages, list) or not messages:
        raise ModelError("INVALID_REQUEST", "Chat requires at least one message.")
    if len(messages) > CHAT_MAX_MESSAGES:
        raise ModelError("INVALID_REQUEST", f"Chat accepts at most {CHAT_MAX_MESSAGES} messages.")
    normalized: list[dict[str, Any]] = []
    total_characters = 0
    totals = {"images": 0, "videos": 0, "image_bytes": 0, "video_bytes": 0}
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise ModelError("INVALID_REQUEST", "Every chat message must be an object.")
        role = message.get("role")
        if role not in CHAT_ROLES:
            raise ModelError("INVALID_REQUEST", "Chat roles must be system, user, or assistant.", {"index": index})
        content, characters = _chat_content(message.get("content"), index, totals)
        total_characters += characters
        if total_characters > CHAT_MAX_TOTAL_CHARACTERS:
            raise ModelError("INVALID_REQUEST", "The chat history is too large for one request.")
        normalized.append({"role": role, "content": content})
    if not any(message["role"] == "user" for message in normalized):
        raise ModelError("INVALID_REQUEST", "Chat requires a user message.")
    if totals["images"] or totals["videos"]:
        LOGGER.info(
            "Chat media accepted: images=%d videos=%d image_bytes=%d video_bytes=%d",
            totals["images"],
            totals["videos"],
            totals["image_bytes"],
            totals["video_bytes"],
        )
    return normalized


def count_chat_media(messages: list[dict[str, Any]]) -> tuple[int, int]:
    images = 0
    videos = 0
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "image_url":
                images += 1
            elif part.get("type") == "video_url":
                videos += 1
    return images, videos


def normalize_chat_options(payload: dict[str, Any]) -> dict[str, Any]:
    def bounded_number(name: str, default: float, minimum: float, maximum: float) -> float:
        value = payload.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ModelError("INVALID_REQUEST", f"{name} must be a number.")
        value = float(value)
        if not math.isfinite(value) or value < minimum or value > maximum:
            raise ModelError("INVALID_REQUEST", f"{name} is outside the supported range.")
        return value

    def optional_integer(name: str, minimum: int, maximum: int) -> int | None:
        value = payload.get(name)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
            raise ModelError("INVALID_REQUEST", f"{name} must be an integer between {minimum} and {maximum}.")
        return value

    top_k = optional_integer("top_k", 0, 500)
    thinking = payload.get("thinking", True)
    if not isinstance(thinking, bool):
        raise ModelError("INVALID_REQUEST", "thinking must be a boolean.")
    keep_loaded = payload.get("keep_loaded", False)
    if not isinstance(keep_loaded, bool):
        raise ModelError("INVALID_REQUEST", "keep_loaded must be a boolean.")
    return {
        "temperature": bounded_number("temperature", 0.8, 0.0, 2.0),
        "top_p": bounded_number("top_p", 0.95, 0.0, 1.0),
        "top_k": 40 if top_k is None else top_k,
        "max_tokens": optional_integer("max_tokens", 1, CHAT_MAX_OUTPUT_TOKENS),
        "seed": optional_integer("seed", 0, 2**63 - 1),
        "thinking": thinking,
        "keep_loaded": keep_loaded,
    }


class _ChatStreamSplitter:
    """Split content deltas that embed <think> reasoning when the server sends no reasoning deltas."""

    OPEN_TAG = "<think>"
    CLOSE_TAG = "</think>"

    def __init__(self) -> None:
        self._state = "undecided"
        self._buffer = ""
        self._reasoning_seen = False

    def feed_reasoning(self, text: str) -> tuple[tuple[str, str], ...]:
        if not text:
            return ()
        events: tuple[tuple[str, str], ...] = ()
        if self._buffer and self._state != "content":
            events = (("content", self._buffer),)
            self._buffer = ""
            self._state = "content"
        self._reasoning_seen = True
        return (*events, ("reasoning", text))

    def feed_content(self, text: str) -> tuple[tuple[str, str], ...]:
        if not text:
            return ()
        if self._reasoning_seen or self._state == "content":
            return (("content", text),)
        self._buffer += text
        return self._drain(final=False)

    def flush(self) -> tuple[tuple[str, str], ...]:
        return self._drain(final=True)

    def _drain(self, *, final: bool) -> tuple[tuple[str, str], ...]:
        events: list[tuple[str, str]] = []
        while self._buffer:
            if self._state == "undecided":
                stripped = self._buffer.lstrip()
                if not stripped:
                    if final:
                        events.append(("content", self._buffer))
                        self._buffer = ""
                    break
                if stripped.startswith(self.OPEN_TAG):
                    self._buffer = stripped[len(self.OPEN_TAG):]
                    self._state = "reasoning"
                    continue
                if not final and self.OPEN_TAG.startswith(stripped):
                    break
                events.append(("content", self._buffer))
                self._buffer = ""
                self._state = "content"
                break
            if self._state == "reasoning":
                closing = self._buffer.find(self.CLOSE_TAG)
                if closing >= 0:
                    if closing:
                        events.append(("reasoning", self._buffer[:closing]))
                    self._buffer = self._buffer[closing + len(self.CLOSE_TAG):]
                    self._state = "content"
                    continue
                if final:
                    events.append(("reasoning", self._buffer))
                    self._buffer = ""
                    break
                keep = 0
                for size in range(min(len(self._buffer), len(self.CLOSE_TAG) - 1), 0, -1):
                    if self._buffer.endswith(self.CLOSE_TAG[:size]):
                        keep = size
                        break
                emit = self._buffer[:-keep] if keep else self._buffer
                if emit:
                    events.append(("reasoning", emit))
                self._buffer = self._buffer[-keep:] if keep else ""
                break
            events.append(("content", self._buffer))
            self._buffer = ""
        return tuple(events)


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
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ModelError(
            "INVALID_EXTERNAL_SERVER_URL",
            "Enter a local llama.cpp server URL such as http://127.0.0.1:8080.",
        )
    if parsed.hostname.lower() not in {"127.0.0.1", "localhost", "::1"}:
        raise ModelError(
            "EXTERNAL_SERVER_NOT_LOCAL",
            "External llama.cpp requires loopback: 127.0.0.1, localhost, or ::1. Publish a same-machine Docker port on host loopback.",
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
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as error:
        raise ModelError("INVALID_EXTERNAL_SERVER_URL", "Enter a valid server port.") from error
    return f"{parsed.scheme}://{host}:{port}"


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
    reasoning_managed_by_server = True

    def __init__(self) -> None:
        self.model_id: str | None = None
        self.chat_handler: _RemoteChatHandler | None = None
        self.cancel_event = threading.Event()
        self.chat_cancel_event = threading.Event()
        self.lock = threading.RLock()
        self._connection: http.client.HTTPConnection | None = None
        self._connection_lock = threading.Lock()
        self._chat_connection: http.client.HTTPConnection | None = None
        self._chat_connection_lock = threading.Lock()
        self._keys = {}
        self.router = RouterLifecycle(self._request_json)
        self._unload_requested = threading.Event()

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
        self._unload_requested.clear()

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
        self._unload_requested.set()
        return self.cancel()

    def prepare_chat(self) -> None:
        self.chat_cancel_event.clear()

    def cancel_chat(self) -> bool:
        self.chat_cancel_event.set()
        with self._chat_connection_lock:
            connection = self._chat_connection
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
        LOGGER.info("External chat cancellation requested.")
        return True

    def unload(self, model_id):
        with self.lock:
            self.router.transition(model_id, False)

    def _auth_headers(self, endpoint):
        key = self._keys.get(endpoint)
        return {"Authorization": f"Bearer {key}"} if key else {}

    def _redact(self, value):
        text = str(value)
        for key in list(self._keys.values()):
            if key:
                text = text.replace(key, "[redacted]")
        return text

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
        connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), timeout=timeout)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Accept": "application/json", **self._auth_headers(endpoint)}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if path == "/models/load":
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
                {"url": endpoint, "reason": self._redact(error)},
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
                self._redact(message) if message else f"The llama.cpp server returned HTTP {response.status}.",
                {"url": endpoint, "status": response.status, "response": self._redact(data)},
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
        connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), timeout=REQUEST_TIMEOUT_SECONDS)
        body = json.dumps(payload).encode("utf-8")
        with self._connection_lock:
            self._connection = connection
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        finish_reason = None
        terminal_received = False
        usage: dict[str, Any] = {}
        try:
            connection.request(
                "POST",
                "/v1/chat/completions",
                body=body,
                headers={"Accept": "text/event-stream", "Content-Type": "application/json", **self._auth_headers(endpoint)},
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
                    self._redact(message) if message else f"The llama.cpp server returned HTTP {response.status}.",
                    {"url": endpoint, "status": response.status, "response": self._redact(data)},
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
                    terminal_received = True
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
                {"url": endpoint, "reason": self._redact(error)},
            ) from error
        finally:
            with self._connection_lock:
                if self._connection is connection:
                    self._connection = None
            connection.close()
        if not terminal_received and finish_reason is None:
            raise ModelError(
                "EXTERNAL_STREAM_INTERRUPTED",
                "The generation stream ended before completion.",
                {"partial_output": bool(content_parts)},
            )
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

    def _stream_chat_completion(
        self,
        endpoint: str,
        payload: dict[str, Any],
        on_delta: Callable[[str, str], None],
    ) -> dict[str, Any]:
        parsed = urlsplit(endpoint)
        connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), timeout=REQUEST_TIMEOUT_SECONDS)
        body = json.dumps(payload).encode("utf-8")
        with self._chat_connection_lock:
            self._chat_connection = connection
        splitter = _ChatStreamSplitter()
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        finish_reason = None
        terminal_received = False
        usage: dict[str, Any] = {}

        def emit(events: tuple[tuple[str, str], ...]) -> None:
            for kind, text in events:
                if kind == "reasoning":
                    reasoning_parts.append(text)
                else:
                    content_parts.append(text)
                on_delta(kind, text)

        try:
            connection.request(
                "POST",
                "/v1/chat/completions",
                body=body,
                headers={"Accept": "text/event-stream", "Content-Type": "application/json", **self._auth_headers(endpoint)},
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
                    self._redact(message) if message else f"The llama.cpp server returned HTTP {response.status}.",
                    {"url": endpoint, "status": response.status, "response": self._redact(data)},
                )
            while True:
                if self.chat_cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Chat was cancelled.")
                line = response.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="replace").strip()
                if not decoded.startswith("data:"):
                    continue
                event = decoded[5:].strip()
                if event == "[DONE]":
                    terminal_received = True
                    break
                try:
                    chunk = json.loads(event)
                except json.JSONDecodeError:
                    continue
                if not isinstance(chunk, dict):
                    continue
                if isinstance(chunk.get("usage"), dict):
                    usage = chunk["usage"]
                choices = chunk.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue
                choice = choices[0] if isinstance(choices[0], dict) else {}
                delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                text = delta.get("content")
                if isinstance(text, str) and text:
                    emit(splitter.feed_content(text))
                reasoning = delta.get("reasoning_content")
                if isinstance(reasoning, str) and reasoning:
                    emit(splitter.feed_reasoning(reasoning))
                if choice.get("finish_reason") is not None:
                    finish_reason = choice["finish_reason"]
        except ModelError:
            raise
        except (OSError, TimeoutError, AttributeError, ValueError, http.client.HTTPException) as error:
            if self.chat_cancel_event.is_set():
                raise ModelError("GENERATION_CANCELLED", "Chat was cancelled.") from error
            raise ModelError(
                "EXTERNAL_SERVER_UNAVAILABLE",
                "The connection to the local llama.cpp server was interrupted.",
                {"url": endpoint, "reason": self._redact(error)},
            ) from error
        finally:
            try:
                emit(splitter.flush())
            finally:
                with self._chat_connection_lock:
                    if self._chat_connection is connection:
                        self._chat_connection = None
                connection.close()
        if not terminal_received and finish_reason is None:
            raise ModelError(
                "EXTERNAL_STREAM_INTERRUPTED",
                "The chat stream ended before completion.",
                {"partial_output": bool(content_parts)},
            )
        if not usage:
            usage = {
                "prompt_tokens": 0,
                "completion_tokens": estimate_text_tokens("".join(content_parts + reasoning_parts)),
            }
        return {
            "finish_reason": finish_reason or "stop",
            "usage": usage,
            "reasoning": bool(reasoning_parts),
        }

    def stream_chat(
        self,
        model_info: dict[str, Any],
        messages: list[dict[str, Any]],
        *,
        temperature: float,
        top_p: float,
        top_k: int,
        max_tokens: int | None,
        seed: int | None,
        thinking: bool,
        on_event: Callable[[str, dict[str, Any]], None],
        keep_loaded: bool = False,
    ) -> dict[str, Any]:
        endpoint = model_info["endpoint"]
        remote_model = model_info["remote_model"]
        payload: dict[str, Any] = {
            "model": remote_model,
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "stream": True,
            "stream_options": {"include_usage": True},
            "chat_template_kwargs": {"enable_thinking": thinking},
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if seed is not None:
            payload["seed"] = seed
        self.prepare_chat()
        started = time.perf_counter()
        loaded = False
        images, videos = count_chat_media(messages)
        LOGGER.info(
            "External chat started: model=%s endpoint=%s messages=%d images=%d videos=%d max_tokens=%s thinking=%s keep_loaded=%s",
            remote_model,
            endpoint,
            len(messages),
            images,
            videos,
            max_tokens,
            thinking,
            keep_loaded,
        )
        with self.lock:
            try:
                if model_info.get("lifecycle_supported"):
                    on_event("status", {"phase": "loading_model"})
                    LOGGER.info("External chat loading model: %s", model_info["id"])
                    self.router.transition(model_info["id"], True, self.chat_cancel_event.is_set)
                    loaded = True
                    LOGGER.info("External chat model loaded: %s", model_info["id"])
                if self.chat_cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Chat was cancelled after model loading.")
                generation_started = time.perf_counter()
                on_event("status", {"phase": "generating"})
                result = self._stream_chat_completion(
                    endpoint,
                    payload,
                    lambda kind, text: on_event(kind, {"text": text}),
                )
                generation_seconds = time.perf_counter() - generation_started
                usage = result.get("usage") or {}
                completion_tokens = usage.get("completion_tokens")
                tokens_per_second = None
                if (
                    isinstance(completion_tokens, (int, float))
                    and not isinstance(completion_tokens, bool)
                    and completion_tokens > 0
                    and generation_seconds > 0
                ):
                    tokens_per_second = round(completion_tokens / generation_seconds, 2)
                result["elapsed_seconds"] = round(generation_seconds, 3)
                result["tokens_per_second"] = tokens_per_second
                LOGGER.info(
                    "External chat finished: model=%s finish_reason=%s prompt_tokens=%s completion_tokens=%s "
                    "generation=%.2fs tokens_per_second=%s elapsed=%.2fs",
                    remote_model,
                    result["finish_reason"],
                    usage.get("prompt_tokens"),
                    completion_tokens,
                    generation_seconds,
                    tokens_per_second,
                    time.perf_counter() - started,
                )
                return result
            except ModelError as error:
                LOGGER.info("External chat stopped: model=%s code=%s elapsed=%.2fs", remote_model, error.code, time.perf_counter() - started)
                raise
            except Exception as error:
                LOGGER.exception("External chat failed: model=%s", remote_model)
                raise ModelError("GENERATION_FAILED", "The external chat request failed.", self._redact(error)) from error
            finally:
                if loaded and keep_loaded:
                    LOGGER.info("External chat model kept loaded: %s", model_info["id"])
                elif loaded:
                    try:
                        self.router.transition(model_info["id"], False)
                    except Exception as error:
                        warning = self._redact(error)
                        LOGGER.warning("External chat cleanup failed: %s", warning)
                        on_event("warning", {
                            "code": "EXTERNAL_UNLOAD_FAILED",
                            "message": "Chat ended, but External model unload was not confirmed.",
                            "details": warning,
                        })
                    else:
                        LOGGER.info("External chat model unloaded: %s", model_info["id"])

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
        if "api_key" in config:
            key = config["api_key"]
            if not isinstance(key, str) or len(key) > 4096 or any(c in key for c in "\r\n"):
                raise ModelError("INVALID_EXTERNAL_API_KEY", "Enter a valid API key.")
            self._keys[endpoint] = key.strip()
        self._request_json(endpoint, "GET", "/health", timeout=CONNECT_TIMEOUT_SECONDS)
        router = False
        try:
            entries = self.router.entries(endpoint)
            router = True
        except ModelError as error:
            if error.code != "EXTERNAL_ROUTER_UNAVAILABLE" and not (
                isinstance(error.details, dict) and error.details.get("status") in {404, 405, 501}
            ):
                raise
            entries = self._request_json(endpoint, "GET", "/v1/models", timeout=CONNECT_TIMEOUT_SECONDS).get("data")
        props = {} if router else self._request_json(endpoint, "GET", "/props", timeout=CONNECT_TIMEOUT_SECONDS)
        if not isinstance(entries, list) or not entries:
            raise ModelError(
                "EXTERNAL_MODEL_NOT_FOUND",
                "The llama.cpp server did not report a loaded model.",
                {"url": endpoint},
            )
        requested_model = str(config.get("model") or "").strip()
        if not requested_model and len(entries) != 1:
            raise ModelError("EXTERNAL_MODEL_AMBIGUOUS", "Enter the exact Model ID; the server lists more than one model.")
        matches = [item for item in entries if isinstance(item, dict) and (not requested_model or item.get("id") == requested_model)]
        selected = matches[0] if len(matches) == 1 else None
        if selected is None:
            raise ModelError(
                "EXTERNAL_MODEL_NOT_FOUND",
                "The requested model is not loaded by this llama.cpp server.",
                {"url": endpoint, "model": requested_model},
            )
        remote_model = str(selected.get("id") or "").strip()
        if not remote_model:
            raise ModelError("EXTERNAL_MODEL_NOT_FOUND", "The llama.cpp server returned an unnamed model.")
        if router and selected["status"]["value"] in {"loaded", "sleeping"}:
            props = self._request_json(endpoint, "GET", "/props?" + urlencode({"model": remote_model, "autoload": "false"}), timeout=CONNECT_TIMEOUT_SECONDS)
        modalities = props.get("modalities")
        capabilities = selected.get("capabilities")
        has_multimodal = (
            isinstance(modalities, dict) and bool(modalities.get("vision"))
        ) or (
            isinstance(capabilities, list) and "multimodal" in capabilities
        )
        architecture = selected.get("architecture") or {}
        has_multimodal = has_multimodal or (isinstance(architecture, dict) and "image" in (architecture.get("input_modalities") or []))
        context_tokens = self._context_tokens(props)
        name = remote_model.replace("\\", "/").rsplit("/", 1)[-1]
        model = {
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
            "context_verified": bool(props),
            "externally_managed": True,
            "source_label": f"External llama.cpp · {endpoint}",
            "lifecycle_supported": router,
        }
        self.router.register(model)
        return model

    def preflight(
        self,
        model_info: dict[str, Any],
        assembled: dict[str, Any],
        *,
        context_profile: str | None,
        kv_cache: str | None,
        thinking: bool,
    ) -> dict[str, Any]:
        effective_thinking = False if self.reasoning_managed_by_server else thinking
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
        if minimum_required > context_tokens and model_info.get("context_verified", True):
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
            "thinking": effective_thinking,
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
        effective_thinking = False if self.reasoning_managed_by_server else thinking
        with self.lock:
            validate_media_capabilities(model_info, assembled)
            response = None
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
                if model_info.get("lifecycle_supported"):
                    self.router.transition(model_info["id"], True, self.cancel_event.is_set)
                    refreshed = self.probe_model({"url": model_info["endpoint"], "model": model_info["remote_model"]})
                    runtime_plan = self.preflight(refreshed, assembled, context_profile=context_profile, kv_cache=kv_cache, thinking=thinking)
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
                    del purpose
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
                        enable_thinking=thinking,
                    )

                result = run_h3_pipeline(
                    model_info,
                    assembled,
                    session_id,
                    runtime_plan,
                    complete=complete,
                    count_text_tokens=lambda text: estimate_text_tokens(text) + 1,
                    is_cancelled=self.cancel_event.is_set,
                    thinking=effective_thinking,
                    seed=seed,
                    on_phase=on_phase,
                )
                response = {
                    **result,
                    "cold_start": None,
                    "model_load_seconds": None,
                    "context_profile": runtime_plan["context_profile"],
                    "context_tokens": runtime_plan["context_tokens"],
                    "kv_cache": runtime_plan["kv_cache"],
                    "max_output_tokens": runtime_plan["max_output_tokens"],
                    "thinking_budget_reduced": runtime_plan["thinking_budget_reduced"],
                    "external_server": True,
                    "server_managed_lifecycle": not model_info.get("lifecycle_supported", False),
                }
                return response
            except ModelError:
                raise
            except MemoryError as error:
                raise ModelError("GENERATION_OOM", "GGUF generation ran out of memory.") from error
            except Exception as error:
                raise ModelError("GENERATION_FAILED", "The GGUF model could not generate a prompt.", self._redact(error)) from error
            finally:
                if model_info.get("lifecycle_supported") and (unload_after or self._unload_requested.is_set() or self.cancel_event.is_set()):
                    try:
                        self.router.transition(model_info["id"], False)
                    except Exception as error:
                        warning = self._redact(error)
                        logging.getLogger(__name__).warning("External model cleanup failed: %s", warning)
                        if response is not None:
                            response["lifecycle_warning"] = "Prompt completed, but External model unload was not confirmed."
                    else:
                        logging.getLogger(__name__).info("External router model unloaded after request: %s", model_info["id"])


BACKEND = ExternalServerBackend()
