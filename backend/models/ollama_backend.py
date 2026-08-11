from __future__ import annotations

import http.client
import json
import os
import shutil
import sys
import threading
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from ..context import CONTEXT_PROFILES, ContextPlanError, estimate_text_tokens, plan_context
from ..h3_pipeline import run_h3_pipeline, validate_media_capabilities
from .contract import ModelError


DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
CONNECT_TIMEOUT_SECONDS = 3
REQUEST_TIMEOUT_SECONDS = 900
TESTED_OLLAMA_TAGS = {"gemma4:12b"}
RECOMMENDED_OLLAMA_MODEL = "gemma4:12b"


def _ollama_cli_installed() -> bool:
    if shutil.which("ollama"):
        return True
    local_app_data = os.environ.get("LOCALAPPDATA")
    return bool(
        local_app_data
        and (Path(local_app_data) / "Programs" / "Ollama" / "ollama.exe").is_file()
    )


def _model_context_limit(details: dict[str, Any]) -> int:
    model_info = details.get("model_info")
    if isinstance(model_info, dict):
        limits = [
            value for key, value in model_info.items()
            if str(key).endswith(".context_length") and isinstance(value, int) and value > 0
        ]
        if limits:
            return max(limits)
    high_level = details.get("details")
    if isinstance(high_level, dict):
        value = high_level.get("context_length")
        if isinstance(value, int) and value > 0:
            return value
    return 0


def _ollama_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            converted.append({"role": message.get("role", "user"), "content": content})
            continue
        if not isinstance(content, list):
            converted.append({"role": message.get("role", "user"), "content": str(content or "")})
            continue
        text_parts: list[str] = []
        images: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                text_parts.append(part["text"])
            elif part.get("type") == "image_url":
                image = part.get("image_url")
                url = image.get("url") if isinstance(image, dict) else None
                if isinstance(url, str):
                    images.append(url.split(",", 1)[1] if url.startswith("data:") and "," in url else url)
        converted_message: dict[str, Any] = {
            "role": message.get("role", "user"),
            "content": "\n\n".join(text_parts),
        }
        if images:
            converted_message["images"] = images
        converted.append(converted_message)
    return converted


class OllamaBackend:
    manages_gpu_memory = False
    externally_managed = False

    def __init__(self, endpoint: str = DEFAULT_OLLAMA_URL) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.model_name: str | None = None
        self.cancel_event = threading.Event()
        self.force_unload_event = threading.Event()
        self.lock = threading.RLock()
        self._connection: http.client.HTTPConnection | None = None
        self._connection_lock = threading.Lock()
        self._details_cache: dict[str, tuple[str, dict[str, Any]]] = {}
        self._last_load_duration = 0

    def prepare_request(self) -> None:
        self.cancel_event.clear()
        self.force_unload_event.clear()

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
        self.force_unload_event.set()
        return self.cancel()

    def _connection_for(self, timeout: int) -> http.client.HTTPConnection:
        parsed = urlsplit(self.endpoint)
        return http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        timeout: int = CONNECT_TIMEOUT_SECONDS,
        track: bool = False,
    ) -> dict[str, Any]:
        connection = self._connection_for(timeout)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if track:
            with self._connection_lock:
                self._connection = connection
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
        except (OSError, TimeoutError, AttributeError, ValueError, http.client.HTTPException) as error:
            if self.cancel_event.is_set() and track:
                raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.") from error
            raise ModelError(
                "OLLAMA_NOT_RUNNING",
                "Ollama is installed but its local service is not responding.",
                {"url": self.endpoint, "reason": str(error)},
            ) from error
        finally:
            if track:
                with self._connection_lock:
                    if self._connection is connection:
                        self._connection = None
            connection.close()
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ModelError(
                "OLLAMA_INVALID_RESPONSE",
                "Ollama returned an invalid response.",
                {"path": path, "status": response.status},
            ) from error
        if not 200 <= response.status < 300:
            message = data.get("error") if isinstance(data, dict) else None
            raise ModelError(
                "OLLAMA_REQUEST_FAILED",
                str(message or f"Ollama returned HTTP {response.status}."),
                {"path": path, "status": response.status, "response": data},
            )
        if not isinstance(data, dict):
            raise ModelError("OLLAMA_INVALID_RESPONSE", "Ollama returned an unexpected response.")
        return data

    def detect(self) -> dict[str, Any]:
        cli_detected = _ollama_cli_installed()
        try:
            version = str(self._request_json("GET", "/api/version").get("version") or "")
        except ModelError as error:
            return {
                "state": "not_running" if cli_detected else "not_installed",
                "installed": cli_detected,
                "running": False,
                "version": None,
                "models": [],
                "compatible_models": [],
                "error": {"code": error.code, "message": error.message, "details": error.details},
            }
        try:
            tags = self._request_json("GET", "/api/tags").get("models")
        except ModelError as error:
            return {
                "state": "error",
                "installed": True,
                "running": True,
                "version": version,
                "models": [],
                "compatible_models": [],
                "error": {"code": error.code, "message": error.message, "details": error.details},
            }
        models: list[dict[str, Any]] = []
        for entry in tags if isinstance(tags, list) else []:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("model") or entry.get("name") or "").strip()
            digest = str(entry.get("digest") or "")
            if not name or not digest or not isinstance(entry.get("size"), int) or entry["size"] <= 0:
                continue
            cached = self._details_cache.get(name)
            if cached is not None and cached[0] == digest:
                details = cached[1]
            else:
                try:
                    details = self._request_json("POST", "/api/show", {"model": name, "verbose": False})
                except ModelError as error:
                    models.append({
                        "id": f"ollama::{name}", "name": name, "family": "ollama",
                        "remote_model": name, "runtime_ready": False,
                        "capabilities": {"images": False, "video_frames": False, "audio": False},
                        "thinking": False, "available": True, "tested_for_h3": False,
                        "inspection_error": {"code": error.code, "message": error.message},
                    })
                    continue
                self._details_cache[name] = (digest, details)
            capabilities = details.get("capabilities")
            if not isinstance(capabilities, list):
                capabilities = entry.get("capabilities") if isinstance(entry.get("capabilities"), list) else []
            capability_set = {str(value).lower() for value in capabilities}
            compatible = "completion" in capability_set and "vision" in capability_set
            detail = details.get("details") if isinstance(details.get("details"), dict) else {}
            models.append({
                "id": f"ollama::{name}",
                "name": name,
                "family": "ollama",
                "format": "OLLAMA",
                "role": "ollama-compatible",
                "remote_model": name,
                "runtime_ready": compatible,
                "missing_dependencies": [] if compatible else ["vision-capable Ollama model"],
                "capabilities": {"images": compatible, "video_frames": compatible, "audio": False},
                "thinking": "thinking" in capability_set,
                "thinking_detected": "thinking" in capability_set,
                "recommended_context": "standard",
                "model_context_limit": _model_context_limit(details),
                "parameter_size": detail.get("parameter_size"),
                "quantization_level": detail.get("quantization_level"),
                "size": entry.get("size"),
                "digest": digest,
                "available": True,
                "tested_for_h3": name in TESTED_OLLAMA_TAGS,
                "source_label": "Ollama · installed locally",
            })
        compatible_models = [model for model in models if model["runtime_ready"]]
        state = "ready" if compatible_models else "no_compatible_model"
        return {
            "state": state,
            "installed": True,
            "running": True,
            "version": version,
            "models": models,
            "compatible_models": compatible_models,
            "recommended_model": RECOMMENDED_OLLAMA_MODEL,
            "error": None,
        }

    def probe_model(self, model_name: str) -> dict[str, Any]:
        detected = self.detect()
        if not detected["running"]:
            error = detected.get("error") or {}
            raise ModelError(error.get("code", "OLLAMA_NOT_RUNNING"), error.get("message", "Ollama is not running."), error.get("details"))
        model = next((item for item in detected["models"] if item["remote_model"] == model_name), None)
        if model is None:
            raise ModelError("OLLAMA_MODEL_NOT_FOUND", "The selected Ollama model is not installed.", {"model": model_name})
        if not model["runtime_ready"]:
            raise ModelError("OLLAMA_MODEL_INCOMPATIBLE", "The selected Ollama model does not report image understanding support.", {"model": model_name})
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
        if (kv_cache or "auto").lower() != "auto":
            raise ModelError("OLLAMA_KV_MANAGED", "KV cache is managed by Ollama. Set it to Auto.")
        if thinking and not model_info.get("thinking"):
            raise ModelError("OLLAMA_THINKING_UNAVAILABLE", "This Ollama model does not report thinking support.")
        try:
            runtime_plan = plan_context(
                assembled,
                model_info,
                requested_context=context_profile,
                requested_kv_cache="auto",
                thinking=thinking,
            )
        except ContextPlanError as error:
            raise ModelError(error.code, error.message, error.details) from error
        limit = int(model_info.get("model_context_limit") or 0)
        if limit and runtime_plan["context_tokens"] > limit:
            requested = (context_profile or "auto").lower()
            if requested != "auto":
                raise ModelError(
                    "OLLAMA_MODEL_CONTEXT_LIMIT",
                    "The selected Context exceeds this Ollama model's declared limit.",
                    {"context_tokens": runtime_plan["context_tokens"], "model_context_limit": limit},
                )
            fitting = [name for name, tokens in CONTEXT_PROFILES.items() if tokens <= limit]
            if not fitting:
                raise ModelError("OLLAMA_MODEL_CONTEXT_LIMIT", "This Ollama model has too little declared context for H3 Prompt Writer.", {"model_context_limit": limit})
            try:
                runtime_plan = plan_context(
                    assembled,
                    model_info,
                    requested_context=fitting[-1],
                    requested_kv_cache="auto",
                    thinking=thinking,
                )
            except ContextPlanError as error:
                raise ModelError(error.code, error.message, error.details) from error
            runtime_plan["requested_context_profile"] = "auto"
        runtime_plan["kv_cache"] = "ollama"
        runtime_plan["requested_kv_cache"] = "auto"
        return runtime_plan

    def _chat_completion(
        self,
        model_name: str,
        runtime_plan: dict[str, Any],
        *,
        messages: list[dict[str, Any]],
        temperature: float,
        top_p: float,
        top_k: int,
        max_tokens: int,
        seed: int | None,
        thinking: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model_name,
            "messages": _ollama_messages(messages),
            "stream": True,
            "think": thinking,
            "keep_alive": -1,
            "options": {
                "temperature": temperature,
                "top_p": top_p,
                "top_k": top_k,
                "num_predict": max_tokens,
                "num_ctx": runtime_plan["context_tokens"],
            },
        }
        if seed is not None:
            payload["options"]["seed"] = seed
        connection = self._connection_for(REQUEST_TIMEOUT_SECONDS)
        body = json.dumps(payload).encode("utf-8")
        with self._connection_lock:
            self._connection = connection
        content_parts: list[str] = []
        finish_reason = "stop"
        prompt_tokens = 0
        completion_tokens = 0
        try:
            connection.request(
                "POST", "/api/chat", body=body,
                headers={"Accept": "application/x-ndjson", "Content-Type": "application/json"},
            )
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                raw = response.read()
                try:
                    error_data = json.loads(raw.decode("utf-8")) if raw else {}
                except (UnicodeDecodeError, json.JSONDecodeError):
                    error_data = {}
                raise ModelError(
                    "OLLAMA_REQUEST_FAILED",
                    str(error_data.get("error") or f"Ollama returned HTTP {response.status}."),
                    {"status": response.status, "response": error_data},
                )
            while True:
                if self.cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.")
                line = response.readline()
                if not line:
                    break
                try:
                    chunk = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ModelError("OLLAMA_INVALID_RESPONSE", "Ollama returned an invalid stream event.") from error
                if isinstance(chunk.get("error"), str):
                    raise ModelError("OLLAMA_STREAM_ERROR", chunk["error"])
                message = chunk.get("message")
                if isinstance(message, dict) and isinstance(message.get("content"), str):
                    content_parts.append(message["content"])
                if chunk.get("done") is True:
                    done_reason = str(chunk.get("done_reason") or "stop")
                    finish_reason = "length" if done_reason == "length" else "stop"
                    prompt_tokens = int(chunk.get("prompt_eval_count") or 0)
                    completion_tokens = int(chunk.get("eval_count") or 0)
                    self._last_load_duration = int(chunk.get("load_duration") or 0)
                    break
        except ModelError:
            raise
        except (OSError, TimeoutError, AttributeError, ValueError, http.client.HTTPException) as error:
            if self.cancel_event.is_set():
                raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.") from error
            raise ModelError("OLLAMA_REQUEST_FAILED", "The connection to Ollama was interrupted.", {"reason": str(error)}) from error
        finally:
            with self._connection_lock:
                if self._connection is connection:
                    self._connection = None
            connection.close()
        content = "".join(content_parts)
        return {
            "choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens or estimate_text_tokens(content),
            },
        }

    def _running_models(self) -> list[dict[str, Any]]:
        data = self._request_json("GET", "/api/ps")
        models = data.get("models")
        return [item for item in models if isinstance(item, dict)] if isinstance(models, list) else []

    def status(self) -> dict[str, Any]:
        try:
            running = self._running_models()
            loaded = next((item for item in running if str(item.get("model") or item.get("name")) == self.model_name), None)
            return {
                "loaded_model_id": f"ollama::{self.model_name}" if loaded and self.model_name else None,
                "loaded": loaded is not None,
                "loaded_context_tokens": loaded.get("context_length") if loaded else None,
                "loaded_kv_cache": "ollama" if loaded else None,
                "ollama_running": True,
                "ollama_model": self.model_name,
            }
        except ModelError as error:
            return {
                "loaded_model_id": None, "loaded": False,
                "loaded_context_tokens": None, "loaded_kv_cache": None,
                "ollama_running": False, "ollama_model": self.model_name,
                "ollama_error": {"code": error.code, "message": error.message},
            }

    def unload(self) -> None:
        model_name = self.model_name
        if not model_name:
            return
        self._request_json(
            "POST", "/api/generate",
            {"model": model_name, "keep_alive": 0, "stream": False},
            timeout=30,
        )

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
        with self.lock:
            validate_media_capabilities(model_info, assembled)
            self.model_name = model_info["remote_model"]
            runtime_plan = runtime_plan or self.preflight(
                model_info, assembled,
                context_profile=context_profile, kv_cache=kv_cache, thinking=thinking,
            )
            try:
                cold_start = not any(
                    str(item.get("model") or item.get("name")) == self.model_name
                    for item in self._running_models()
                )
                if on_phase:
                    on_phase("loading_model")

                def complete(**kwargs: Any) -> dict[str, Any]:
                    return self._chat_completion(self.model_name, runtime_plan, **kwargs)

                result = run_h3_pipeline(
                    model_info, assembled, session_id, runtime_plan,
                    complete=complete,
                    count_text_tokens=lambda text: estimate_text_tokens(text) + 1,
                    is_cancelled=self.cancel_event.is_set,
                    thinking=thinking,
                    seed=seed,
                    on_phase=on_phase,
                )
                return {
                    **result,
                    "cold_start": cold_start,
                    "model_load_seconds": round(self._last_load_duration / 1_000_000_000, 3),
                    "context_profile": runtime_plan["context_profile"],
                    "context_tokens": runtime_plan["context_tokens"],
                    "kv_cache": runtime_plan["kv_cache"],
                    "max_output_tokens": runtime_plan["max_output_tokens"],
                    "thinking_budget_reduced": runtime_plan["thinking_budget_reduced"],
                    "ollama": True,
                }
            except ModelError:
                raise
            except Exception as error:
                raise ModelError("GENERATION_FAILED", "Ollama could not generate a prompt.", str(error)) from error
            finally:
                active_error = sys.exc_info()[0] is not None
                force_unload = self.force_unload_event.is_set()
                if unload_after or force_unload:
                    try:
                        self.unload()
                    except ModelError:
                        if not active_error:
                            raise
                self.force_unload_event.clear()


BACKEND = OllamaBackend()
