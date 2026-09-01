from __future__ import annotations

import asyncio
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from aiohttp import web
from server import PromptServer

from .assembly import AssemblyError, assemble_lyrics_request, assemble_refinement, assemble_request
from .catalog import discover_models_with_diagnostics, find_model, model_setup_catalog
from .comfy_state import comfyui_runtime_snapshot
from .devlog import DEVELOPER_MODE, LOG_PATH, PeakVRAMMonitor, gpu_memory_snapshot, write_event
from .guides import MODE_GUIDES, guide_catalog, guide_for_mode
from .media import CACHE_ROOT, MAX_FILE_BYTES, MODE_LIMITS, STORE, MediaError, parse_session_id
from .memory import assess_free_vram
from .models.gguf_backend import BACKEND as GGUF_BACKEND
from .models.external_server_backend import BACKEND as EXTERNAL_SERVER_BACKEND
from .models.ollama_backend import BACKEND as OLLAMA_BACKEND, normalize_ollama_url
from .models.api_provider_backend import BACKEND as API_PROVIDER_BACKEND
from .models.contract import ModelError
from .runtime_diagnostics import get_gguf_runtime_diagnostics
from .system_prompts import SystemPromptError, system_prompt_for_mode
from .version import VERSION


ROUTE_PREFIX = "/h3studio"
MODES = {"T2VA", "I2VA", "FL2VA", "L2VA", "Reference", "Music3"}
STATE: dict[str, Any] = {
    "phase": "idle",
    "active_request_id": None,
    "selected_model_id": None,
    "selected_model_family": None,
    "selected_model_endpoint": None,
    "cancel_requested": False,
    "pending_unload_family": None,
    "pending_unload_model_id": None,
    "pending_unload_endpoint": None,
    "media_mutation_active": False,
}
STATE_LOCK = threading.RLock()

BACKENDS = {
    "gguf": GGUF_BACKEND,
    "external": EXTERNAL_SERVER_BACKEND,
    "ollama": OLLAMA_BACKEND,
    "api": API_PROVIDER_BACKEND,
}
GENERATION_CACHE: dict[tuple[str, str], dict[str, Any]] = {}
GENERATION_CACHE_ACCESS: dict[tuple[str, str], float] = {}
SESSION_TTL_SECONDS = 24 * 60 * 60


def _cache_key(session_id: str, mode: str) -> tuple[str, str]:
    return session_id, mode


def _get_generation_cache(session_id: str, mode: str) -> dict[str, Any] | None:
    key = _cache_key(session_id, mode)
    cached = GENERATION_CACHE.get(key)
    if cached is not None:
        GENERATION_CACHE_ACCESS[key] = time.monotonic()
    return cached


def _set_generation_cache(session_id: str, mode: str, value: dict[str, Any]) -> None:
    key = _cache_key(session_id, mode)
    GENERATION_CACHE[key] = value
    GENERATION_CACHE_ACCESS[key] = time.monotonic()


def _invalidate_generation_cache(session_id: str, mode: str) -> None:
    key = _cache_key(session_id, mode)
    GENERATION_CACHE.pop(key, None)
    GENERATION_CACHE_ACCESS.pop(key, None)


def _generation_busy_error() -> web.Response | None:
    with STATE_LOCK:
        if STATE["active_request_id"] is None and not STATE["media_mutation_active"]:
            return None
    return _error("GENERATION_BUSY", "Media cannot be changed while H3 Prompt Writer is busy.", status=409)


def _claim_media_mutation() -> bool:
    with STATE_LOCK:
        if STATE["active_request_id"] is not None or STATE["media_mutation_active"]:
            return False
        STATE["media_mutation_active"] = True
    return True


def _release_media_mutation() -> None:
    with STATE_LOCK:
        STATE["media_mutation_active"] = False


async def _run_thread_worker(
    function: Callable[..., Any],
    *args: Any,
    on_cancel: Callable[[], Any] | None = None,
    **kwargs: Any,
) -> tuple[Any, asyncio.CancelledError | None]:
    """Keep a native worker owned until it really stops, even if its request task is cancelled."""
    worker = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    cancellation: asyncio.CancelledError | None = None
    while not worker.done():
        try:
            await asyncio.shield(worker)
        except asyncio.CancelledError as error:
            if cancellation is None and on_cancel is not None:
                try:
                    on_cancel()
                except Exception:
                    pass
            cancellation = cancellation or error
    try:
        result = worker.result()
    except BaseException as error:
        if cancellation is not None:
            raise cancellation from error
        raise
    return result, cancellation


def _propagate_worker_cancellation(cancellation: asyncio.CancelledError | None) -> None:
    if cancellation is not None:
        raise cancellation


async def _cleanup_expired_state(*, now: float | None = None) -> None:
    if not _claim_media_mutation():
        return
    try:
        current_time = time.monotonic() if now is None else now
        expired_directories = STORE.expire_sessions(now=current_time, max_age_seconds=SESSION_TTL_SECONDS)
        expired_sessions = {path.name for path in expired_directories}
        expired_cache_keys = {
            key
            for key, accessed_at in GENERATION_CACHE_ACCESS.items()
            if current_time - accessed_at >= SESSION_TTL_SECONDS
        }
        expired_cache_keys.update(key for key in GENERATION_CACHE if key[0] in expired_sessions)
        for key in expired_cache_keys:
            GENERATION_CACHE.pop(key, None)
            GENERATION_CACHE_ACCESS.pop(key, None)
        cleanup_cancellation = None
        for path in expired_directories:
            _result, cancellation = await _run_thread_worker(shutil.rmtree, path, ignore_errors=True)
            cleanup_cancellation = cleanup_cancellation or cancellation
        _propagate_worker_cancellation(cleanup_cancellation)
    finally:
        _release_media_mutation()


def _claim_generation_request() -> str | None:
    request_id = str(uuid4())
    with STATE_LOCK:
        if STATE["active_request_id"] is not None or STATE["media_mutation_active"]:
            return None
        STATE.update({
            "phase": "preparing",
            "active_request_id": request_id,
            "selected_model_id": None,
            "selected_model_family": None,
            "selected_model_endpoint": None,
            "cancel_requested": False,
            "pending_unload_family": None,
            "pending_unload_model_id": None,
            "pending_unload_endpoint": None,
        })
    return request_id


def _set_active_model(request_id: str, model: dict[str, Any]) -> tuple[bool, str | None, str | None, str | None]:
    with STATE_LOCK:
        if STATE["active_request_id"] != request_id:
            return False, None, None, None
        STATE.update({
            "selected_model_id": model["id"],
            "selected_model_family": model["family"],
            "selected_model_endpoint": model.get("endpoint") if model["family"] == "ollama" else None,
        })
        pending_family = STATE["pending_unload_family"]
        pending_model_id = STATE["pending_unload_model_id"]
        pending_endpoint = STATE["pending_unload_endpoint"]
        STATE["pending_unload_family"] = None
        STATE["pending_unload_model_id"] = None
        STATE["pending_unload_endpoint"] = None
        return bool(STATE["cancel_requested"]), pending_family, pending_model_id, pending_endpoint


def _request_cancelled(request_id: str) -> bool:
    with STATE_LOCK:
        return STATE["active_request_id"] == request_id and bool(STATE["cancel_requested"])


def _set_request_phase(request_id: str, phase: str) -> None:
    with STATE_LOCK:
        if STATE["active_request_id"] == request_id:
            STATE["phase"] = phase


def _release_generation_request(request_id: str) -> None:
    with STATE_LOCK:
        if STATE["active_request_id"] != request_id:
            return
        STATE.update({
            "phase": "idle",
            "active_request_id": None,
            "cancel_requested": False,
            "pending_unload_family": None,
            "pending_unload_model_id": None,
            "pending_unload_endpoint": None,
        })


async def _memory_preflight(backend: Any, model: dict[str, Any], runtime_plan: dict[str, Any]) -> None:
    if getattr(backend, "manages_gpu_memory", True) is False:
        return
    status = backend.status()
    desired_signature = (model["id"], runtime_plan["context_tokens"], runtime_plan["kv_cache"])
    loaded_signature = (
        status.get("loaded_model_id"),
        status.get("loaded_context_tokens"),
        status.get("loaded_kv_cache"),
    )
    already_loaded = status.get("loaded") and loaded_signature == desired_signature
    if status.get("loaded") and not already_loaded:
        _result, cancellation = await _run_thread_worker(backend.unload)
        _propagate_worker_cancellation(cancellation)
    details = assess_free_vram(model, runtime_plan, gpu_memory_snapshot(), already_loaded=bool(already_loaded))
    if details:
        raise ModelError(
            "INSUFFICIENT_FREE_VRAM",
            "The selected prompt model needs more free GPU memory before it can load.",
            details,
        )


async def _resolve_model(body: dict[str, Any]) -> dict[str, Any] | None:
    api_provider = body.get("api_provider")
    if api_provider is not None:
        if not isinstance(api_provider, dict):
            raise ModelError("INVALID_API_PROVIDER", "API provider settings must be a JSON object.")
        model = API_PROVIDER_BACKEND.resolve_model(api_provider)
        requested_id = str(body.get("model_id") or "")
        if requested_id and requested_id != model["id"]:
            raise ModelError(
                "API_MODEL_CHANGED",
                "The selected API model changed. Select it again in Settings.",
                {"requested_model_id": requested_id, "current_model_id": model["id"]},
            )
        return model
    ollama_model = body.get("ollama_model")
    if ollama_model is not None:
        if not isinstance(ollama_model, str) or not ollama_model.strip():
            raise ModelError("INVALID_OLLAMA_MODEL", "Select an installed Ollama model.")
        ollama_host = body.get("ollama_host")
        if ollama_host is not None and not isinstance(ollama_host, str):
            raise ModelError("INVALID_OLLAMA_URL", "The Ollama host must be a URL string.")
        model, cancellation = await _run_thread_worker(
            OLLAMA_BACKEND.probe_model,
            ollama_model.strip(),
            ollama_host,
        )
        _propagate_worker_cancellation(cancellation)
        requested_id = str(body.get("model_id") or "")
        if requested_id and requested_id != model["id"]:
            raise ModelError(
                "OLLAMA_MODEL_CHANGED",
                "The selected Ollama model changed. Select it again in Settings.",
                {"requested_model_id": requested_id, "current_model_id": model["id"]},
            )
        return model
    external_config = body.get("external_server")
    if external_config is not None:
        if not isinstance(external_config, dict):
            raise ModelError("INVALID_EXTERNAL_SERVER", "External server settings must be a JSON object.")
        model, cancellation = await _run_thread_worker(EXTERNAL_SERVER_BACKEND.probe_model, external_config)
        _propagate_worker_cancellation(cancellation)
        requested_id = str(body.get("model_id") or "")
        if requested_id and requested_id != model["id"]:
            raise ModelError(
                "EXTERNAL_MODEL_CHANGED",
                "The model loaded by llama.cpp changed. Reconnect it in the model picker.",
                {"requested_model_id": requested_id, "current_model_id": model["id"]},
            )
        return model
    return find_model(str(body.get("model_id") or ""))


async def _apply_deferred_unload(
    family: str,
    model_id: str | None,
    resolved_model: dict[str, Any],
    endpoint: str | None = None,
) -> bool:
    backend = BACKENDS.get(family)
    if backend is None:
        return False
    resolved_family = resolved_model["family"]
    same_target = family == resolved_family
    if same_target and family == "ollama":
        same_target = _ollama_target_matches(
            model_id,
            endpoint,
            resolved_model.get("id"),
            resolved_model.get("endpoint"),
        )
    if same_target:
        request_unload = getattr(backend, "request_unload", None)
        if callable(request_unload):
            request_unload()
        else:
            backend.cancel()
        return True
    if getattr(backend, "externally_managed", False):
        return False
    if family == "ollama":
        _result, cancellation = await _run_thread_worker(backend.unload, model_id, endpoint)
    else:
        _result, cancellation = await _run_thread_worker(backend.unload)
    _propagate_worker_cancellation(cancellation)
    return False


def _ollama_target_matches(
    requested_model_id: str | None,
    requested_endpoint: str | None,
    active_model_id: str | None,
    active_endpoint: str | None,
) -> bool:
    if requested_endpoint is not None and requested_endpoint != active_endpoint:
        return False
    requested_model_name = _ollama_model_name(requested_model_id, requested_endpoint or active_endpoint)
    active_model_name = _ollama_model_name(active_model_id, active_endpoint)
    if requested_model_id is not None and requested_model_name != active_model_name:
        return False
    return True


def _ollama_model_name(model_id: str | None, endpoint: str | None) -> str | None:
    if model_id is None or not model_id.startswith("ollama::"):
        return model_id
    if endpoint:
        endpoint_prefix = f"ollama::{endpoint}::"
        if model_id.startswith(endpoint_prefix):
            return model_id[len(endpoint_prefix):]
    return model_id[len("ollama::"):]


async def _prepare_generation_runtime(
    body: dict[str, Any],
    assembled: dict[str, Any],
    request_id: str,
) -> tuple[dict[str, Any], Any, dict[str, Any]]:
    model = await _resolve_model(body)
    if model is None:
        raise ModelError("MODEL_NOT_FOUND", "The selected prompt model was not found.")
    backend = BACKENDS.get(model["family"])
    if backend is None:
        raise ModelError("MODEL_BACKEND_UNAVAILABLE", "The selected model backend is not connected yet.")

    cancel_requested, pending_unload_family, pending_unload_model_id, pending_unload_endpoint = _set_active_model(request_id, model)
    backend.prepare_request()
    deferred_cancel_requested = False
    if pending_unload_family is not None:
        deferred_cancel_requested = await _apply_deferred_unload(
            pending_unload_family,
            pending_unload_model_id,
            model,
            pending_unload_endpoint,
        )
    if cancel_requested or deferred_cancel_requested:
        backend.cancel()
        raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.")

    runtime_options = {
        "context_profile": body.get("context_profile", "auto"),
        "kv_cache": body.get("kv_cache", "auto"),
        "thinking": body.get("thinking", False),
    }
    if model["family"] == "gguf":
        runtime_options.update({
            "context_tokens": body.get("context_tokens"),
            "generation_budget": body.get("generation_budget"),
            "reasoning_effort": body.get("reasoning_effort", "auto"),
        })
    runtime_plan, cancellation = await _run_thread_worker(
        backend.preflight,
        model,
        assembled,
        **runtime_options,
    )
    try:
        _propagate_worker_cancellation(cancellation)
        await _memory_preflight(backend, model, runtime_plan)
        if _request_cancelled(request_id):
            raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.")
    except BaseException:
        if getattr(backend, "preflight_acquires_runtime", False):
            try:
                await _run_thread_worker(backend.unload)
            except BaseException:
                pass
        raise
    return model, backend, runtime_plan


def _model_error_status(error: ModelError) -> int:
    if error.code == "MODEL_NOT_FOUND":
        return 404
    if error.code == "INSUFFICIENT_FREE_VRAM":
        return 409
    if error.code in {
        "EXTERNAL_SERVER_UNAVAILABLE",
        "EXTERNAL_SERVER_ERROR",
        "EXTERNAL_SERVER_INVALID_RESPONSE",
        "OLLAMA_NOT_RUNNING",
        "OLLAMA_REQUEST_FAILED",
        "OLLAMA_INVALID_RESPONSE",
        "OLLAMA_STREAM_ERROR",
    }:
        return 502
    if error.code == "OLLAMA_MODEL_NOT_FOUND":
        return 404
    if error.code == "API_AUTHENTICATION_FAILED":
        return 401
    if error.code == "API_PAYMENT_REQUIRED":
        return 402
    if error.code == "API_PERMISSION_DENIED":
        return 403
    if error.code == "API_MODEL_NOT_FOUND":
        return 404
    if error.code == "API_RATE_LIMITED":
        return 429
    if error.code in {
        "API_PROVIDER_UNAVAILABLE",
        "API_STREAM_INTERRUPTED",
        "API_REQUEST_TIMEOUT",
        "API_RESPONSE_INVALID",
        "API_GENERATION_FAILED",
    }:
        return 502
    return 400


def _error(code: str, message: str, *, status: int, details: Any = None) -> web.Response:
    payload: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details is not None:
        payload["error"]["details"] = details
    return web.json_response(payload, status=status)


def _media_error(error: MediaError, status: int = 400) -> web.Response:
    return _error(error.code, error.message, status=status)


async def _json_body(request: web.Request) -> dict[str, Any] | None:
    try:
        body = await request.json()
    except (ValueError, TypeError):
        return None
    return body if isinstance(body, dict) else None


routes = PromptServer.instance.routes


@routes.get(f"{ROUTE_PREFIX}/status")
async def get_status(request: web.Request) -> web.Response:
    await _cleanup_expired_state()
    try:
        ollama_host = normalize_ollama_url(request.query.get("ollama_host"))
    except ModelError as error:
        return _error(error.code, error.message, status=400, details=error.details)
    with STATE_LOCK:
        state = dict(STATE)
    family = state.get("selected_model_family")
    backend = BACKENDS.get(family, GGUF_BACKEND)
    ollama_status_call = OLLAMA_BACKEND.status if family == "ollama" else OLLAMA_BACKEND.retained_status
    direct_status, ollama_status = await asyncio.gather(
        asyncio.to_thread(GGUF_BACKEND.status),
        asyncio.to_thread(ollama_status_call, ollama_host),
    )
    comfyui_status = comfyui_runtime_snapshot(getattr(PromptServer.instance, "prompt_queue", None))
    if family == "gguf" or family is None:
        backend_status = direct_status
    elif family == "ollama":
        backend_status = ollama_status
    else:
        backend_status = await asyncio.to_thread(backend.status)
    return web.json_response({
        **{key: state[key] for key in ("phase", "active_request_id", "selected_model_id", "selected_model_family")},
        **backend_status,
        "backend_ready": True,
        "model_backend_ready": True,
        "developer_mode": DEVELOPER_MODE,
        "version": VERSION,
        "developer_log_path": str(LOG_PATH) if DEVELOPER_MODE else None,
        "gpu_memory": gpu_memory_snapshot(),
        "comfyui": comfyui_status,
        "prompt_residency": {
            "direct": {
                "loaded": bool(direct_status.get("loaded")),
                "model_id": direct_status.get("loaded_model_id"),
            },
            "ollama": {
                "models": ollama_status.get("writer_retained_models", []),
                "targets": OLLAMA_BACKEND.retained_targets(),
                "running": bool(ollama_status.get("ollama_running")),
            },
        },
    })


@routes.get(f"{ROUTE_PREFIX}/models")
async def get_models(_request: web.Request) -> web.Response:
    models, discovery = discover_models_with_diagnostics()
    return web.json_response({
        "models": models,
        "model_directory": "ComfyUI/models/LLM/",
        "setup": model_setup_catalog(),
        "discovery": discovery,
    })


@routes.post(f"{ROUTE_PREFIX}/runtime/gguf/diagnostics")
async def diagnose_gguf_runtime(request: web.Request) -> web.Response:
    body = await _json_body(request)
    if body is None:
        return _error("INVALID_REQUEST", "Expected a JSON object.", status=400)
    force = body.get("refresh", False)
    if not isinstance(force, bool):
        return _error("INVALID_REQUEST", "The refresh field must be a boolean.", status=400)
    diagnostics = await asyncio.to_thread(get_gguf_runtime_diagnostics, force=force)
    return web.json_response({"diagnostics": diagnostics})


@routes.post(f"{ROUTE_PREFIX}/external-server/probe")
async def probe_external_server(request: web.Request) -> web.Response:
    body = await _json_body(request)
    if body is None:
        return _error("INVALID_REQUEST", "Expected a JSON object.", status=400)
    try:
        model = await asyncio.to_thread(EXTERNAL_SERVER_BACKEND.probe_model, body)
    except ModelError as error:
        return _error(error.code, error.message, status=_model_error_status(error), details=error.details)
    return web.json_response({"model": model})


@routes.get(f"{ROUTE_PREFIX}/ollama/status")
async def get_ollama_status(request: web.Request) -> web.Response:
    try:
        status = await asyncio.to_thread(OLLAMA_BACKEND.detect, request.query.get("host"))
    except ModelError as error:
        return _error(error.code, error.message, status=_model_error_status(error), details=error.details)
    return web.json_response(status)


@routes.get(f"{ROUTE_PREFIX}/api-provider/presets")
async def get_api_provider_presets(_request: web.Request) -> web.Response:
    return web.json_response({"presets": API_PROVIDER_BACKEND.preset_catalog()})


@routes.post(f"{ROUTE_PREFIX}/api-provider/probe")
async def probe_api_provider(request: web.Request) -> web.Response:
    body = await _json_body(request)
    if body is None:
        return _error("INVALID_REQUEST", "Expected a JSON object.", status=400)
    try:
        result = await asyncio.to_thread(API_PROVIDER_BACKEND.probe, body)
    except ModelError as error:
        return _error(error.code, error.message, status=_model_error_status(error), details=error.details)
    return web.json_response(result)


@routes.post(f"{ROUTE_PREFIX}/api-provider/models")
async def get_api_provider_models(request: web.Request) -> web.Response:
    body = await _json_body(request)
    connection_id = str((body or {}).get("connection_id") or "").strip()
    if not connection_id:
        return _error("INVALID_REQUEST", "A provider connection ID is required.", status=400)
    try:
        result = await asyncio.to_thread(API_PROVIDER_BACKEND.list_models, connection_id)
    except ModelError as error:
        return _error(error.code, error.message, status=_model_error_status(error), details=error.details)
    return web.json_response(result)


@routes.post(f"{ROUTE_PREFIX}/api-provider/disconnect")
async def disconnect_api_provider(request: web.Request) -> web.Response:
    body = await _json_body(request)
    connection_id = str((body or {}).get("connection_id") or "").strip()
    if not connection_id:
        return _error("INVALID_REQUEST", "A provider connection ID is required.", status=400)
    disconnected = await asyncio.to_thread(API_PROVIDER_BACKEND.disconnect, connection_id)
    return web.json_response({"disconnected": disconnected})


@routes.get(f"{ROUTE_PREFIX}/guides")
async def get_guides(_request: web.Request) -> web.Response:
    return web.json_response({"guides": guide_catalog()})


@routes.get(f"{ROUTE_PREFIX}/guides/{{mode}}")
async def get_guide(request: web.Request) -> web.Response:
    mode = request.match_info["mode"]
    if mode not in MODE_GUIDES:
        return _error("INVALID_MODE", "The selected MiniMax mode is not supported.", status=404)
    return web.json_response({"guide": guide_for_mode(mode)})


@routes.get(f"{ROUTE_PREFIX}/system-prompt/{{mode}}")
async def get_system_prompt(request: web.Request) -> web.Response:
    mode = request.match_info["mode"]
    try:
        prompt = system_prompt_for_mode(mode)
    except SystemPromptError as error:
        return _error(error.code, error.message, status=404)
    return web.json_response({
        "mode": mode,
        "profile": "music3_lyrics" if mode == "Music3Lyrics" else "music3" if mode == "Music3" else "reference" if mode == "Reference" else "standard",
        "system_prompt": prompt,
    })


@routes.post(f"{ROUTE_PREFIX}/assemble")
async def assemble(request: web.Request) -> web.Response:
    body = await _json_body(request)
    if body is None:
        return _error("INVALID_REQUEST", "Expected a JSON object.", status=400)
    try:
        assembled = assemble_request(body)
    except AssemblyError as error:
        return _error(error.code, error.message, status=400, details=error.details)
    except (MediaError, RuntimeError) as error:
        code = error.code if isinstance(error, MediaError) else "GUIDE_LOAD_FAILED"
        return _error(code, str(error), status=500)
    return web.json_response({"request": assembled})


@routes.post(f"{ROUTE_PREFIX}/generate")
async def generate(request: web.Request) -> web.Response:
    body = await _json_body(request)
    if body is None:
        return _error("INVALID_REQUEST", "Expected a JSON object.", status=400)

    required = ("mode", "creative_brief", "model_id", "session_id") if body.get("mode") == "Music3" else ("mode", "creative_brief", "model_id", "session_id", "aspect_ratio", "duration_seconds")
    missing = [key for key in required if not body.get(key)]
    if missing:
        return _error("INVALID_REQUEST", "Required fields are missing.", status=400, details={"fields": missing})
    if body["mode"] not in MODES:
        return _error("INVALID_MODE", "The selected MiniMax mode is not supported.", status=400)

    if not isinstance(body.get("thinking", False), bool) or not isinstance(body.get("unload_after", True), bool):
        return _error("INVALID_REQUEST", "Thinking and unload_after must be booleans.", status=400)
    if body.get("seed") is not None and (not isinstance(body["seed"], int) or isinstance(body["seed"], bool) or body["seed"] < 0):
        return _error("INVALID_REQUEST", "Seed must be a non-negative integer.", status=400)
    try:
        assembled = assemble_request(body)
    except AssemblyError as error:
        return _error(error.code, error.message, status=400, details=error.details)
    except (MediaError, RuntimeError) as error:
        code = error.code if isinstance(error, MediaError) else "GUIDE_LOAD_FAILED"
        return _error(code, str(error), status=500)

    request_id = _claim_generation_request()
    if request_id is None:
        return _error("GENERATION_BUSY", "Another H3 Prompt Writer request is already running.", status=409)
    try:
        model, backend, runtime_plan = await _prepare_generation_runtime(body, assembled, request_id)
    except ModelError as error:
        _release_generation_request(request_id)
        status = 499 if error.code == "GENERATION_CANCELLED" else _model_error_status(error)
        return _error(error.code, error.message, status=status, details=error.details)
    except BaseException:
        _release_generation_request(request_id)
        raise

    request_started = time.perf_counter()
    vram_monitor = PeakVRAMMonitor()
    vram_monitor.start()
    _set_request_phase(request_id, "loading_model")
    write_event(
        "request_started",
        request_id=request_id,
        operation="generate",
        model={"id": model["id"], "name": model["name"], "family": model["family"], "format": model.get("format")},
        thinking=body.get("thinking", False),
        seed=body.get("seed"),
        unload_after=body.get("unload_after", True),
        context_profile=runtime_plan["context_profile"],
        kv_cache=runtime_plan["kv_cache"],
        input=assembled["input"],
    )

    def on_phase(phase: str) -> None:
        _set_request_phase(request_id, phase)
        write_event("phase", request_id=request_id, operation="generate", phase=phase, elapsed_seconds=round(time.perf_counter() - request_started, 3))

    try:
        result, cancellation = await _run_thread_worker(
            backend.generate,
            model,
            assembled,
            body["session_id"],
            on_cancel=backend.cancel,
            thinking=body.get("thinking", False),
            seed=body.get("seed"),
            unload_after=body.get("unload_after", True),
            context_profile=body.get("context_profile", "auto"),
            kv_cache=body.get("kv_cache", "auto"),
            runtime_plan=runtime_plan,
            on_phase=on_phase,
        )
        _propagate_worker_cancellation(cancellation)
        total_seconds = round(time.perf_counter() - request_started, 3)
        peak_vram_mb = vram_monitor.stop()
        debug_input_sequence = result.pop("debug_input_sequence", None)
        _set_generation_cache(body["session_id"], body["mode"], {
            "mode": body["mode"],
            "duration_seconds": assembled["input"]["duration_seconds"],
            "aspect_ratio": assembled["input"]["aspect_ratio"],
            "creative_brief": assembled["input"]["creative_brief"],
            "lyrics": assembled["input"].get("lyrics", ""),
        })
        write_event(
            "request_succeeded",
            request_id=request_id,
            operation="generate",
            total_seconds=total_seconds,
            peak_vram_mb=peak_vram_mb,
            metrics={key: result[key] for key in ("input_tokens", "output_tokens", "generation_seconds", "media_processing_seconds", "visual_input_count", "video_frame_count", "video_sheet_count", "estimated_input_tokens", "estimated_visual_tokens", "reserved_output_tokens", "text_token_source", "vision_budget_applied", "thinking_fallback", "thinking_attempt_tokens", "reasoning_tokens", "primary_finish_reason", "format_repair_attempted", "format_repair_applied", "format_repair_reason", "format_repair_failure", "format_repair_method", "format_repair_multimodal", "format_repair_tokens", "tokens_per_second", "cold_start", "model_load_seconds", "context_profile", "context_tokens", "kv_cache", "max_output_tokens", "thinking_budget_reduced", "prompt_audit", "api_provider", "provider_request_count", "usage_source", "provider_request_ids", "provider_cost_usd", "upstream_providers") if key in result},
            input_sequence=debug_input_sequence if DEVELOPER_MODE else None,
            output=result["prompt"],
        )
        return web.json_response({
            "request_id": request_id,
            "model_id": model["id"],
            "thinking": body.get("thinking", False),
            "total_seconds": total_seconds,
            "peak_vram_mb": peak_vram_mb,
            **result,
        })
    except ModelError as error:
        peak_vram_mb = vram_monitor.stop()
        write_event(
            "request_failed",
            request_id=request_id,
            operation="generate",
            total_seconds=round(time.perf_counter() - request_started, 3),
            peak_vram_mb=peak_vram_mb,
            error={"code": error.code, "message": error.message, "details": error.details},
        )
        status = 499 if error.code == "GENERATION_CANCELLED" else _model_error_status(error)
        return _error(error.code, error.message, status=status, details=error.details)
    finally:
        vram_monitor.stop()
        _release_generation_request(request_id)


@routes.post(f"{ROUTE_PREFIX}/cancel")
async def cancel(_request: web.Request) -> web.Response:
    with STATE_LOCK:
        if STATE["active_request_id"] is None:
            return web.json_response({"cancelled": False, "reason": "idle"})
        STATE["phase"] = "cancelling"
        STATE["cancel_requested"] = True
        family = STATE.get("selected_model_family")
    if family is None:
        return web.json_response({"cancelled": True, "pending": True})
    backend = BACKENDS.get(family, GGUF_BACKEND)
    return web.json_response({"cancelled": backend.cancel(), "pending": False})


@routes.post(f"{ROUTE_PREFIX}/unload")
async def unload(request: web.Request) -> web.Response:
    body = await _json_body(request)
    body = body or {}
    with STATE_LOCK:
        selected_family = STATE.get("selected_model_family")
    family = body.get("family") or selected_family
    model_id = body.get("model_id")
    ollama_host = body.get("ollama_host")
    if family not in BACKENDS:
        return _error("INVALID_MODEL_FAMILY", "A supported model family is required.", status=400)
    if model_id is not None and not isinstance(model_id, str):
        return _error("INVALID_REQUEST", "model_id must be a string.", status=400)
    if ollama_host is not None and not isinstance(ollama_host, str):
        return _error("INVALID_OLLAMA_URL", "The Ollama host must be a URL string.", status=400)
    if family == "ollama" and ollama_host is not None:
        try:
            ollama_host = normalize_ollama_url(ollama_host)
        except ModelError as error:
            return _error(error.code, error.message, status=400, details=error.details)
    backend = BACKENDS[family]
    with STATE_LOCK:
        active = STATE["active_request_id"] is not None
        active_family = STATE.get("selected_model_family")
        active_model_id = STATE.get("selected_model_id")
        active_endpoint = STATE.get("selected_model_endpoint")
        if active and active_family is None:
            targeted_ollama_unload = family == "ollama" and (model_id is not None or ollama_host is not None)
            if not targeted_ollama_unload:
                STATE["phase"] = "cancelling"
                STATE["cancel_requested"] = True
            STATE["pending_unload_family"] = family
            STATE["pending_unload_model_id"] = model_id
            STATE["pending_unload_endpoint"] = ollama_host
            return web.json_response({"unload_requested": True, "deferred": True})
    active_same_target = active and active_family == family
    if active_same_target and family == "ollama":
        active_same_target = _ollama_target_matches(model_id, ollama_host, active_model_id, active_endpoint)
    if active_same_target:
        request_unload = getattr(backend, "request_unload", None)
        if callable(request_unload):
            return web.json_response({"unload_requested": request_unload(), "deferred": True})
        return web.json_response({"unload_requested": False, "deferred": False, "externally_managed": True})
    if getattr(backend, "externally_managed", False):
        return web.json_response({
            "unload_requested": False,
            "deferred": False,
            "externally_managed": True,
            "message": "The API provider owns its model lifecycle." if family == "api" else "The external llama.cpp server owns its model lifecycle.",
        })
    if family == "ollama":
        await asyncio.to_thread(OLLAMA_BACKEND.unload, model_id, ollama_host)
    else:
        await asyncio.to_thread(backend.unload)
    return web.json_response({"unload_requested": True, "deferred": False})


@routes.post(f"{ROUTE_PREFIX}/refine")
async def refine(request: web.Request) -> web.Response:
    body = await _json_body(request)
    if body is None:
        return _error("INVALID_REQUEST", "Expected a JSON object.", status=400)
    lyrics_request = body.get("mode") == "Music3" and body.get("target") == "lyrics"
    required = ("model_id", "session_id", "mode") if lyrics_request else ("current_prompt", "instruction", "model_id", "session_id", "mode")
    missing = [key for key in required if not body.get(key)]
    if missing:
        return _error("INVALID_REQUEST", "Required fields are missing.", status=400, details={"fields": missing})
    if not isinstance(body.get("thinking", False), bool) or not isinstance(body.get("unload_after", True), bool):
        return _error("INVALID_REQUEST", "Thinking and unload_after must be booleans.", status=400)
    if body.get("seed") is not None and (not isinstance(body["seed"], int) or isinstance(body["seed"], bool) or body["seed"] < 0):
        return _error("INVALID_REQUEST", "Seed must be a non-negative integer.", status=400)
    try:
        assembled = assemble_lyrics_request(body) if lyrics_request else assemble_refinement(
            body,
            _get_generation_cache(body["session_id"], body["mode"]),
        )
    except AssemblyError as error:
        return _error(error.code, error.message, status=400, details=error.details)
    except (MediaError, RuntimeError) as error:
        code = error.code if isinstance(error, MediaError) else "GUIDE_LOAD_FAILED"
        return _error(code, str(error), status=500)

    request_id = _claim_generation_request()
    if request_id is None:
        return _error("GENERATION_BUSY", "Another H3 Prompt Writer request is already running.", status=409)
    try:
        model, backend, runtime_plan = await _prepare_generation_runtime(body, assembled, request_id)
    except ModelError as error:
        _release_generation_request(request_id)
        status = 499 if error.code == "GENERATION_CANCELLED" else _model_error_status(error)
        return _error(error.code, error.message, status=status, details=error.details)
    except BaseException:
        _release_generation_request(request_id)
        raise

    request_started = time.perf_counter()
    vram_monitor = PeakVRAMMonitor()
    vram_monitor.start()
    _set_request_phase(request_id, "loading_model")
    operation = "refine_lyrics" if lyrics_request else "refine"
    write_event(
        "request_started",
        request_id=request_id,
        operation=operation,
        model={"id": model["id"], "name": model["name"], "family": model["family"], "format": model.get("format")},
        thinking=body.get("thinking", False),
        seed=body.get("seed"),
        unload_after=body.get("unload_after", True),
        context_profile=runtime_plan["context_profile"],
        kv_cache=runtime_plan["kv_cache"],
        input=assembled["input"],
    )

    def on_phase(phase: str) -> None:
        _set_request_phase(request_id, phase)
        write_event("phase", request_id=request_id, operation=operation, phase=phase, elapsed_seconds=round(time.perf_counter() - request_started, 3))

    try:
        result, cancellation = await _run_thread_worker(
            backend.generate,
            model,
            assembled,
            body["session_id"],
            on_cancel=backend.cancel,
            thinking=body.get("thinking", False),
            seed=body.get("seed"),
            unload_after=body.get("unload_after", True),
            context_profile=body.get("context_profile", "auto"),
            kv_cache=body.get("kv_cache", "auto"),
            runtime_plan=runtime_plan,
            on_phase=on_phase,
        )
        _propagate_worker_cancellation(cancellation)
        if lyrics_request and len(result["prompt"]) > 4000:
            raise ModelError("LYRICS_TOO_LONG", "The generated Lyrics exceed 4,000 characters. Shorten the request and try again.")
        total_seconds = round(time.perf_counter() - request_started, 3)
        peak_vram_mb = vram_monitor.stop()
        debug_input_sequence = result.pop("debug_input_sequence", None)
        write_event(
            "request_succeeded",
            request_id=request_id,
            operation=operation,
            total_seconds=total_seconds,
            peak_vram_mb=peak_vram_mb,
            metrics={key: result[key] for key in ("input_tokens", "output_tokens", "generation_seconds", "media_processing_seconds", "visual_input_count", "video_frame_count", "video_sheet_count", "estimated_input_tokens", "estimated_visual_tokens", "reserved_output_tokens", "text_token_source", "vision_budget_applied", "thinking_fallback", "thinking_attempt_tokens", "reasoning_tokens", "primary_finish_reason", "format_repair_attempted", "format_repair_applied", "format_repair_reason", "format_repair_failure", "format_repair_method", "format_repair_multimodal", "format_repair_tokens", "tokens_per_second", "cold_start", "model_load_seconds", "context_profile", "context_tokens", "kv_cache", "max_output_tokens", "thinking_budget_reduced", "prompt_audit", "api_provider", "provider_request_count", "usage_source", "provider_request_ids", "provider_cost_usd", "upstream_providers") if key in result},
            input_sequence=debug_input_sequence if DEVELOPER_MODE else None,
            output=result["prompt"],
        )
        return web.json_response({
            "request_id": request_id,
            "model_id": model["id"],
            "thinking": body.get("thinking", False),
            "total_seconds": total_seconds,
            "peak_vram_mb": peak_vram_mb,
            **result,
        })
    except ModelError as error:
        peak_vram_mb = vram_monitor.stop()
        write_event(
            "request_failed",
            request_id=request_id,
            operation=operation,
            total_seconds=round(time.perf_counter() - request_started, 3),
            peak_vram_mb=peak_vram_mb,
            error={"code": error.code, "message": error.message, "details": error.details},
        )
        status = 499 if error.code == "GENERATION_CANCELLED" else _model_error_status(error)
        return _error(error.code, error.message, status=status, details=error.details)
    finally:
        vram_monitor.stop()
        _release_generation_request(request_id)


@routes.post(f"{ROUTE_PREFIX}/media/upload")
async def upload_media(request: web.Request) -> web.Response:
    busy = _generation_busy_error()
    if busy is not None:
        return busy
    try:
        reader = await request.multipart()
    except Exception:
        return _error("INVALID_REQUEST", "Expected multipart form data.", status=400)

    session_id: str | None = None
    mode: str | None = None
    uploaded: list[dict[str, Any]] = []
    uploaded_ids: list[str] = []
    asset_dir: Path | None = None
    pending_replacement: dict[str, Any] | None = None
    pending_replacement_dir: Path | None = None
    media_claimed = False
    replace_asset_id: str | None = request.query.get("replace_asset_id") or None

    def rollback_upload() -> None:
        if asset_dir is not None:
            shutil.rmtree(asset_dir, ignore_errors=True)
        if pending_replacement_dir is not None:
            shutil.rmtree(pending_replacement_dir, ignore_errors=True)
        if session_id is not None and not replace_asset_id:
            for asset_id in uploaded_ids:
                try:
                    STORE.remove(session_id, asset_id)
                except MediaError:
                    pass

    try:
        while field := await reader.next():
            if field.name == "session_id":
                session_id = parse_session_id((await field.text()).strip() or None)
                continue
            if field.name == "mode":
                mode = (await field.text()).strip()
                continue
            if field.name == "replace_asset_id":
                multipart_replace_asset_id = (await field.text()).strip() or None
                if uploaded or pending_replacement is not None:
                    raise MediaError("INVALID_REPLACEMENT", "Replacement metadata must be provided before the file.")
                replace_asset_id = multipart_replace_asset_id
                continue
            if field.name != "file" or not field.filename:
                continue
            if session_id is None:
                session_id = parse_session_id(None)
            if mode not in MODE_LIMITS:
                raise MediaError("INVALID_MODE", "Select a valid mode before uploading media.")
            if replace_asset_id and pending_replacement is not None:
                raise MediaError("INVALID_REPLACEMENT", "Replace accepts exactly one file.")

            asset_dir = CACHE_ROOT / session_id / str(uuid4())
            asset_dir.mkdir(parents=True, exist_ok=False)
            extension = Path(field.filename).suffix.lower()
            stored_path = asset_dir / f"original{extension}"
            size = 0
            with stored_path.open("wb") as output:
                while chunk := await field.read_chunk(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise MediaError("MEDIA_TOO_LARGE", "A media file cannot exceed 1 GB.")
                    output.write(chunk)
            if not media_claimed and not _claim_media_mutation():
                raise MediaError("GENERATION_BUSY", "Media cannot be changed while H3 Prompt Writer is generating or refining.")
            media_claimed = True
            if replace_asset_id:
                old_asset = STORE.get(session_id, replace_asset_id)
                if old_asset["mode"] != mode:
                    raise MediaError("INVALID_REPLACEMENT", "The replacement must stay in the same mode.")
                prepared, cancellation = await _run_thread_worker(
                    STORE.prepare_replace,
                    session_id,
                    replace_asset_id,
                    field.filename,
                    field.headers.get("Content-Type"),
                    stored_path,
                )
                if cancellation is not None:
                    raise cancellation
                pending_replacement = prepared
                pending_replacement_dir = asset_dir
                asset_dir = None
                continue
            else:
                prepared, cancellation = await _run_thread_worker(
                    STORE.prepare_add,
                    session_id,
                    mode,
                    field.filename,
                    field.headers.get("Content-Type"),
                    stored_path,
                )
                if cancellation is not None:
                    raise cancellation
                asset = STORE.commit_add(session_id, mode, prepared)
            uploaded.append(asset)
            uploaded_ids.append(asset["id"])
            asset_dir = None
        if replace_asset_id and pending_replacement is not None:
            asset = STORE.commit_replace(session_id, replace_asset_id, pending_replacement)
            uploaded.append(asset)
            pending_replacement = None
            pending_replacement_dir = None
    except (MediaError, ValueError) as error:
        rollback_upload()
        if isinstance(error, MediaError):
            return _media_error(error, status=409 if error.code == "GENERATION_BUSY" else 400)
        return _error("INVALID_SESSION", "The media session ID is invalid.", status=400)
    except BaseException:
        rollback_upload()
        raise
    finally:
        if media_claimed:
            _release_media_mutation()

    if not uploaded:
        return _error("INVALID_REQUEST", "No media files were provided.", status=400)
    _invalidate_generation_cache(session_id, mode)
    if replace_asset_id:
        return web.json_response({"session_id": session_id, "asset": uploaded[0], "assets": STORE.list(session_id)}, status=201)
    return web.json_response({"session_id": session_id, "assets": uploaded}, status=201)


@routes.get(f"{ROUTE_PREFIX}/media")
async def list_media(request: web.Request) -> web.Response:
    try:
        session_id = parse_session_id(request.query.get("session_id"))
    except ValueError:
        return _error("INVALID_SESSION", "The media session ID is invalid.", status=400)
    return web.json_response({"session_id": session_id, "assets": STORE.list(session_id)})


@routes.get(f"{ROUTE_PREFIX}/media/manifest")
async def media_manifest(request: web.Request) -> web.Response:
    mode = request.query.get("mode", "")
    if mode not in MODE_LIMITS:
        return _error("INVALID_MODE", "The selected MiniMax mode is not supported.", status=400)
    try:
        session_id = parse_session_id(request.query.get("session_id"))
    except ValueError:
        return _error("INVALID_SESSION", "The media session ID is invalid.", status=400)
    return web.json_response(STORE.manifest(session_id, mode))


@routes.get(f"{ROUTE_PREFIX}/media/{{asset_id}}/content")
async def media_content(request: web.Request) -> web.StreamResponse:
    try:
        session_id = parse_session_id(request.query.get("session_id"))
        asset = STORE.get(session_id, request.match_info["asset_id"])
        kind = request.query.get("kind", "original")
        if kind == "frame":
            index = int(request.query.get("index", "0"))
            path = Path(asset["_frames"][index]["path"])
        elif kind == "preview":
            path = Path(asset.get("_preview_path") or asset["_original_path"])
        elif kind == "sheet":
            path = Path(asset["_contact_sheet_path"])
        else:
            path = Path(asset["_original_path"])
    except (MediaError, ValueError, IndexError):
        raise web.HTTPNotFound()
    return web.FileResponse(path)


@routes.delete(f"{ROUTE_PREFIX}/media/{{asset_id}}")
async def remove_media(request: web.Request) -> web.Response:
    busy = _generation_busy_error()
    if busy is not None:
        return busy
    try:
        session_id = parse_session_id(request.query.get("session_id"))
        mode = STORE.get(session_id, request.match_info["asset_id"])["mode"]
        STORE.remove(session_id, request.match_info["asset_id"])
    except ValueError:
        return _error("INVALID_SESSION", "The media session ID is invalid.", status=400)
    except MediaError as error:
        return _media_error(error, status=404)
    _invalidate_generation_cache(session_id, mode)
    return web.json_response({"removed": True, "assets": STORE.list(session_id)})


@routes.delete(f"{ROUTE_PREFIX}/media")
async def clear_media(request: web.Request) -> web.Response:
    busy = _generation_busy_error()
    if busy is not None:
        return busy
    try:
        session_id = parse_session_id(request.query.get("session_id"))
        mode = request.query.get("mode", "")
        assets = STORE.clear_mode(session_id, mode)
    except ValueError:
        return _error("INVALID_SESSION", "The media session ID is invalid.", status=400)
    except MediaError as error:
        return _media_error(error)
    _invalidate_generation_cache(session_id, mode)
    return web.json_response({"cleared": True, "assets": assets})


@routes.post(f"{ROUTE_PREFIX}/media/{{asset_id}}/resample")
async def resample_media(request: web.Request) -> web.Response:
    busy = _generation_busy_error()
    if busy is not None:
        return busy
    body = await _json_body(request)
    if not _claim_media_mutation():
        return _error("GENERATION_BUSY", "Media cannot be changed while H3 Prompt Writer is generating or refining.", status=409)
    prepared: dict[str, Any] | None = None
    try:
        session_id = parse_session_id((body or {}).get("session_id"))
        mode = STORE.get(session_id, request.match_info["asset_id"])["mode"]
        prepared, cancellation = await _run_thread_worker(
            STORE.prepare_resample,
            session_id,
            request.match_info["asset_id"],
            (body or {}).get("frame_count"),
            (body or {}).get("include_endpoints"),
        )
        if cancellation is not None:
            raise cancellation
        asset = STORE.commit_resample(session_id, request.match_info["asset_id"], prepared)
    except ValueError:
        return _error("INVALID_SESSION", "The media session ID is invalid.", status=400)
    except MediaError as error:
        if prepared is not None:
            _result, cleanup_cancellation = await _run_thread_worker(
                shutil.rmtree,
                prepared["derived_dir"],
                ignore_errors=True,
            )
            if cleanup_cancellation is not None:
                raise cleanup_cancellation
        return _media_error(error)
    except BaseException:
        if prepared is not None:
            await _run_thread_worker(shutil.rmtree, prepared["derived_dir"], ignore_errors=True)
        raise
    finally:
        _release_media_mutation()
    _invalidate_generation_cache(session_id, mode)
    return web.json_response({"asset": asset})


@routes.post(f"{ROUTE_PREFIX}/media/reorder")
async def reorder_media(request: web.Request) -> web.Response:
    busy = _generation_busy_error()
    if busy is not None:
        return busy
    body = await _json_body(request)
    if body is None or body.get("mode") not in MODE_LIMITS or not isinstance(body.get("asset_ids"), list):
        return _error("INVALID_REQUEST", "Mode and ordered asset IDs are required.", status=400)
    busy = _generation_busy_error()
    if busy is not None:
        return busy
    try:
        session_id = parse_session_id(body.get("session_id"))
        assets = STORE.reorder(session_id, body["mode"], body["asset_ids"])
    except ValueError:
        return _error("INVALID_SESSION", "The media session ID is invalid.", status=400)
    except MediaError as error:
        return _media_error(error)
    _invalidate_generation_cache(session_id, body["mode"])
    return web.json_response({"assets": assets})
