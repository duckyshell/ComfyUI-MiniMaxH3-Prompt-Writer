from __future__ import annotations

import http.client
import ipaddress
import json
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlsplit
from uuid import uuid4

from ..context import (
    CHAT_TEMPLATE_OVERHEAD_TOKENS,
    CONTEXT_SAFETY_TOKENS,
    ESTIMATED_VISUAL_TOKENS,
    MINIMUM_OUTPUT_TOKENS,
    THINKING_OUTPUT_TOKENS,
    estimate_text_tokens,
    non_thinking_output_tokens,
)
from ..h3_pipeline import run_h3_pipeline, validate_media_capabilities
from ..version import VERSION
from .contract import ModelError


CONNECT_TIMEOUT_SECONDS = 10
REQUEST_TIMEOUT_SECONDS = 900
DEFAULT_CONTEXT_TOKENS = 32_768
DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024
GEMINI_MAX_REQUEST_BYTES = 20 * 1024 * 1024
MAX_API_CONNECTIONS = 32
GEMINI_REASONING_EFFORTS = {"minimal", "low", "medium", "high"}
PRIVATE_LAN_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "fc00::/7",
))

PRESETS: dict[str, dict[str, Any]] = {
    "openai": {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "key_url": "https://platform.openai.com/api-keys",
        "privacy_url": "https://developers.openai.com/api/docs/guides/your-data",
        "pricing_url": "https://developers.openai.com/api/docs/pricing",
        "default_images": True,
        "thinking": True,
    },
    "gemini": {
        "name": "Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_url": "https://aistudio.google.com/api-keys",
        "privacy_url": "https://ai.google.dev/gemini-api/terms",
        "pricing_url": "https://ai.google.dev/gemini-api/docs/pricing",
        "default_images": True,
        "thinking": True,
    },
    "openrouter": {
        "name": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "key_url": "https://openrouter.ai/settings/keys",
        "privacy_url": "https://openrouter.ai/docs/guides/privacy/provider-logging/",
        "pricing_url": "https://openrouter.ai/pricing",
        "default_images": False,
        "thinking": False,
    },
    "custom": {
        "name": "Custom",
        "base_url": None,
        "key_url": None,
        "privacy_url": None,
        "pricing_url": None,
        "default_images": False,
        "thinking": False,
    },
}


def _is_loopback(hostname: str) -> bool:
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _is_private_lan(hostname: str) -> bool:
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return any(address.version == network.version and address in network for network in PRIVATE_LAN_NETWORKS)


def normalize_api_base_url(preset: str, value: str | None = None) -> str:
    if preset not in PRESETS:
        raise ModelError("API_PRESET_INVALID", "Choose OpenAI, Gemini, OpenRouter, or Custom.")
    fixed = PRESETS[preset]["base_url"]
    raw = str(fixed if fixed is not None else value or "").strip().rstrip("/")
    if not raw:
        raise ModelError("API_BASE_URL_INVALID", "Enter the OpenAI-compatible API base URL.")
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ModelError("API_BASE_URL_INVALID", "Use a valid HTTP or HTTPS API base URL.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ModelError(
            "API_BASE_URL_INVALID",
            "The API base URL cannot contain credentials, a query, or a fragment.",
        )
    if preset == "custom" and parsed.scheme == "http" and not (
        _is_loopback(parsed.hostname) or _is_private_lan(parsed.hostname)
    ):
        raise ModelError(
            "API_BASE_URL_INSECURE",
            "Custom HTTP endpoints must use loopback or a private LAN address. Use HTTPS for public remote API providers.",
        )
    lowered_host = parsed.hostname.lower()
    if lowered_host in {"metadata.google.internal", "instance-data", "instance-data.ec2.internal"}:
        raise ModelError("API_BASE_URL_BLOCKED", "Cloud metadata endpoints cannot be used as API providers.")
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        address = None
    if address is not None and (address.is_link_local or address.is_multicast or address.is_unspecified):
        raise ModelError("API_BASE_URL_BLOCKED", "This network address cannot be used as an API provider.")
    try:
        port = parsed.port
    except ValueError as error:
        raise ModelError("API_BASE_URL_INVALID", "Use a valid port in the API base URL.") from error
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname and not parsed.hostname.startswith("[") else parsed.hostname
    default_port = 443 if parsed.scheme == "https" else 80
    authority = host if (port or default_port) == default_port else f"{host}:{port}"
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme}://{authority}{path}"


def _api_path(base_url: str, suffix: str) -> str:
    path = urlsplit(base_url).path.rstrip("/")
    return f"{path}/{suffix.lstrip('/')}" or "/"


@dataclass
class ApiConnection:
    id: str
    preset: str
    base_url: str
    api_key: str
    custom_images: bool
    custom_context_tokens: int | None
    reasoning_effort: str = "minimal"
    compatibility_profile: str = "generic"
    models: list[dict[str, Any]] = field(default_factory=list)
    connection_verified: bool = False


class _ApiChatHandler:
    def __init__(self, backend: "ApiProviderBackend", connection: ApiConnection, model_id: str) -> None:
        self.backend = backend
        self.connection = connection
        self.model_id = model_id

    def __call__(
        self,
        *,
        messages: list[dict[str, Any]],
        temperature: float,
        top_p: float,
        top_k: int,
        max_tokens: int,
        seed: int | None,
        thinking: bool,
        **_unused: Any,
    ) -> dict[str, Any]:
        del top_k, seed
        payload: dict[str, Any] = {
            "model": self.model_id,
            "messages": messages,
            "stream": True,
        }
        preset = self.connection.preset
        if preset in {"openai", "gemini", "openrouter"}:
            payload["stream_options"] = {"include_usage": True}
        if preset == "openai":
            payload["max_completion_tokens"] = max_tokens
            payload["store"] = False
        else:
            payload["max_tokens"] = max_tokens
        # New OpenAI reasoning models and Gemini 3.6+ reject or deprecate
        # sampling controls. Keep those presets on the smallest portable set.
        if not thinking and preset in {"openrouter", "custom"}:
            payload["temperature"] = temperature
            payload["top_p"] = top_p
        if preset == "gemini":
            # Let Gemini manage the combined hidden reasoning and visible output
            # budget. Hard-coding per-effort token allowances would duplicate
            # provider policy and becomes stale as models change.
            effort = self.connection.reasoning_effort
            payload["reasoning_effort"] = effort
            payload.pop("max_tokens", None)
        elif thinking and preset == "openai":
            payload["reasoning_effort"] = "low"
        elif thinking and preset == "openrouter":
            payload["reasoning"] = {"enabled": True, "exclude": True}
        elif preset == "custom" and self.connection.compatibility_profile == "lm_studio":
            payload["reasoning_effort"] = "low" if thinking else "none"
        return self.backend._request_chat_completion_stream(self.connection, payload)


class ApiProviderBackend:
    manages_gpu_memory = False
    externally_managed = True

    def __init__(self) -> None:
        self.cancel_event = threading.Event()
        self.lock = threading.RLock()
        self._connection: http.client.HTTPConnection | None = None
        self._connection_lock = threading.Lock()
        self._connections: dict[str, ApiConnection] = {}
        self._connections_lock = threading.RLock()
        self.model_id: str | None = None
        self._request_count = 0
        self._usage_sources: list[str] = []
        self._provider_request_ids: list[str] = []
        self._provider_cost_usd = 0.0
        self._upstream_providers: set[str] = set()

    def status(self) -> dict[str, Any]:
        with self._connections_lock:
            count = len(self._connections)
        return {
            "loaded_model_id": None,
            "loaded": False,
            "loaded_context_tokens": None,
            "loaded_kv_cache": None,
            "externally_managed": True,
            "api_connected": count > 0,
            "api_connection_count": count,
            "api_model_id": self.model_id,
        }

    def prepare_request(self) -> None:
        self.cancel_event.clear()
        self._request_count = 0
        self._usage_sources = []
        self._provider_request_ids = []
        self._provider_cost_usd = 0.0
        self._upstream_providers = set()

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

    @staticmethod
    def preset_catalog() -> list[dict[str, Any]]:
        return [
            {
                "id": preset,
                "name": config["name"],
                "base_url": config["base_url"],
                "key_url": config["key_url"],
                "privacy_url": config["privacy_url"],
                "pricing_url": config["pricing_url"],
            }
            for preset, config in PRESETS.items()
        ]

    @staticmethod
    def _credential(config: dict[str, Any], preset: str) -> str:
        credential = config.get("credential")
        if not isinstance(credential, dict):
            credential = {}
        if credential.get("source") not in {None, "", "session"} or credential.get("environment_name"):
            raise ModelError("API_CREDENTIAL_SOURCE_INVALID", "API keys must be entered for the current Writer session.")
        key = str(credential.get("value") or "").strip()
        if not key and preset != "custom":
            raise ModelError(
                "API_CREDENTIAL_MISSING",
                f"Enter a {PRESETS[preset]['name']} API key for this Writer session.",
            )
        return key

    @staticmethod
    def _safe_error_details(
        preset: str,
        status: int,
        data: Any,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        remote_error = data.get("error") if isinstance(data, dict) else None
        details: dict[str, Any] = {"provider": preset, "status": status}
        if isinstance(remote_error, dict):
            for source, target in (("type", "provider_error_type"), ("code", "provider_error_code")):
                value = remote_error.get(source)
                if isinstance(value, (str, int)):
                    details[target] = value
        request_id = headers.get("x-request-id") or headers.get("x-openrouter-request-id")
        if request_id:
            details["provider_request_id"] = request_id
        retry_after = headers.get("retry-after")
        if retry_after:
            details["retry_after"] = retry_after
        return details

    @classmethod
    def _http_error(
        cls,
        preset: str,
        status: int,
        data: Any,
        headers: dict[str, str],
    ) -> ModelError:
        remote_error = data.get("error") if isinstance(data, dict) else None
        remote_message = remote_error.get("message") if isinstance(remote_error, dict) else None
        message_text = str(remote_message or "")
        lowered = message_text.lower()
        details = cls._safe_error_details(preset, status, data, headers)
        if status == 401:
            return ModelError("API_AUTHENTICATION_FAILED", "The provider rejected this API key.", details)
        if status == 402:
            return ModelError("API_PAYMENT_REQUIRED", "The provider account has no available credit.", details)
        if status == 403:
            return ModelError("API_PERMISSION_DENIED", "The provider denied this request.", details)
        if status == 404:
            return ModelError("API_MODEL_NOT_FOUND", remote_message or "The provider could not find this model or endpoint.", details)
        if status == 408:
            return ModelError("API_REQUEST_TIMEOUT", "The provider timed out before generation started.", details)
        if status == 429:
            return ModelError("API_RATE_LIMITED", "The provider rate limit or quota was reached.", details)
        if status >= 500:
            return ModelError("API_PROVIDER_UNAVAILABLE", "The provider is temporarily unavailable.", details)
        if "context" in lowered and any(word in lowered for word in ("length", "window", "token", "maximum", "exceed")):
            return ModelError("API_CONTEXT_EXCEEDED", remote_message or "The request exceeds the model context window.", details)
        return ModelError("API_INVALID_REQUEST", remote_message or f"The provider returned HTTP {status}.", details)

    @staticmethod
    def _http_connection(base_url: str, timeout: int) -> http.client.HTTPConnection:
        parsed = urlsplit(base_url)
        if parsed.scheme == "https":
            return http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout)
        return http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)

    @staticmethod
    def _headers(connection: ApiConnection, accept: str) -> dict[str, str]:
        headers = {
            "Accept": accept,
            "Content-Type": "application/json",
            "User-Agent": f"H3-Prompt-Writer/{VERSION}",
        }
        if connection.api_key:
            headers["Authorization"] = f"Bearer {connection.api_key}"
        return headers

    def _request_json(
        self,
        connection: ApiConnection,
        method: str,
        path: str,
        *,
        timeout: int = CONNECT_TIMEOUT_SECONDS,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        http_connection = self._http_connection(connection.base_url, timeout)
        try:
            http_connection.request(method, path, headers=self._headers(connection, "application/json"))
            response = http_connection.getresponse()
            raw = response.read()
        except (OSError, TimeoutError, AttributeError, ValueError, http.client.HTTPException) as error:
            raise ModelError(
                "API_PROVIDER_UNAVAILABLE",
                "H3 Prompt Writer could not reach the API provider.",
                {"provider": connection.preset, "reason": str(error)},
            ) from error
        finally:
            http_connection.close()
        headers = {key.lower(): value for key, value in response.getheaders()}
        data: Any = {}
        try:
            if raw:
                data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            if not 200 <= response.status < 300:
                raise self._http_error(connection.preset, response.status, {}, headers) from error
            raise ModelError(
                "API_RESPONSE_INVALID",
                "The API provider returned invalid JSON.",
                {"provider": connection.preset, "status": response.status},
            ) from error
        if not 200 <= response.status < 300:
            raise self._http_error(connection.preset, response.status, data, headers)
        if not isinstance(data, dict):
            raise ModelError("API_RESPONSE_INVALID", "The API provider returned an unexpected response.")
        return data, headers

    @staticmethod
    def _context_limit(entry: dict[str, Any]) -> int | None:
        candidates = [
            entry.get("context_length"),
            entry.get("context_window"),
            entry.get("input_token_limit"),
        ]
        top_provider = entry.get("top_provider")
        if isinstance(top_provider, dict):
            candidates.extend([top_provider.get("context_length"), top_provider.get("max_completion_tokens")])
        for value in candidates:
            if isinstance(value, int) and value > 0:
                return value
        return None

    @staticmethod
    def _max_output_tokens(entry: dict[str, Any]) -> int | None:
        candidates = [entry.get("max_output_tokens"), entry.get("output_token_limit")]
        top_provider = entry.get("top_provider")
        if isinstance(top_provider, dict):
            candidates.append(top_provider.get("max_completion_tokens"))
        for value in candidates:
            if isinstance(value, int) and value > 0:
                return value
        return None

    @staticmethod
    def _model_modalities(entry: dict[str, Any]) -> set[str] | None:
        architecture = entry.get("architecture")
        value = architecture.get("input_modalities") if isinstance(architecture, dict) else None
        if value is None:
            value = entry.get("input_modalities") or entry.get("modalities")
        if isinstance(value, list):
            return {str(item).lower() for item in value}
        return None

    def _model_info(self, connection: ApiConnection, entry: dict[str, Any] | str) -> dict[str, Any]:
        if isinstance(entry, str):
            item: dict[str, Any] = {"id": entry}
        else:
            item = entry
        model_id = str(item.get("id") or item.get("name") or "").strip()
        if not model_id:
            raise ModelError("API_MODEL_NOT_FOUND", "The provider returned an unnamed model.")
        modalities = self._model_modalities(item)
        if modalities is not None:
            images = "image" in modalities
            capability_source = "official_metadata"
        elif connection.preset == "custom":
            images = connection.custom_images
            capability_source = "user_declared"
        else:
            images = bool(PRESETS[connection.preset]["default_images"])
            capability_source = "provider_preset"
        supported_parameters = item.get("supported_parameters")
        parameter_set = {str(value) for value in supported_parameters} if isinstance(supported_parameters, list) else set()
        reasoning = item.get("reasoning")
        if connection.preset == "openrouter":
            thinking = isinstance(reasoning, dict) or "reasoning" in parameter_set
        else:
            thinking = bool(PRESETS[connection.preset]["thinking"])
        context_tokens = self._context_limit(item) or connection.custom_context_tokens
        max_output_tokens = self._max_output_tokens(item)
        pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else None
        return {
            "id": f"api::{connection.id}::{model_id}",
            "name": model_id,
            "family": "api",
            "format": "API",
            "role": "api-provider",
            "runtime_ready": True,
            "missing_dependencies": [],
            "capabilities": {"images": images, "video_frames": images, "audio": False},
            "capability_source": capability_source,
            "thinking": thinking,
            "recommended_context": "provider",
            "model_context_limit": context_tokens,
            "max_output_tokens": max_output_tokens,
            "externally_managed": True,
            "api_connection_id": connection.id,
            "api_preset": connection.preset,
            "endpoint": connection.base_url,
            "remote_model": model_id,
            "source_label": f"{PRESETS[connection.preset]['name']} · API provider",
            "pricing": pricing,
        }

    def _local_custom_model_metadata(self, connection: ApiConnection) -> dict[str, dict[str, Any]]:
        hostname = urlsplit(connection.base_url).hostname or ""
        if connection.preset != "custom" or not (_is_loopback(hostname) or _is_private_lan(hostname)):
            return {}
        try:
            data, _headers = self._request_json(connection, "GET", "/api/v1/models")
        except ModelError:
            return {}
        entries = data.get("models")
        if not isinstance(entries, list):
            return {}
        if not any(
            isinstance(entry, dict)
            and entry.get("key")
            and ("loaded_instances" in entry or "max_context_length" in entry)
            for entry in entries
        ):
            return {}
        connection.compatibility_profile = "lm_studio"
        return {
            str(entry.get("key") or entry.get("id")): entry
            for entry in entries
            if isinstance(entry, dict) and (entry.get("key") or entry.get("id"))
        }

    @staticmethod
    def _enrich_local_custom_model(entry: dict[str, Any], metadata: dict[str, Any] | None) -> dict[str, Any] | None:
        if not metadata:
            return entry
        if metadata.get("type") not in {None, "llm"}:
            return None
        enriched = dict(entry)
        capabilities = metadata.get("capabilities")
        if isinstance(capabilities, dict) and capabilities.get("vision") is True:
            enriched["architecture"] = {"input_modalities": ["text", "image"]}
        loaded_instances = metadata.get("loaded_instances")
        if isinstance(loaded_instances, list):
            for instance in loaded_instances:
                config = instance.get("config") if isinstance(instance, dict) else None
                context_length = config.get("context_length") if isinstance(config, dict) else None
                if isinstance(context_length, int) and context_length > 0:
                    enriched["context_length"] = context_length
                    break
        if "context_length" not in enriched:
            maximum = metadata.get("max_context_length")
            if isinstance(maximum, int) and maximum > 0:
                enriched["context_length"] = maximum
        return enriched

    def _fetch_models(self, connection: ApiConnection, *, allow_missing: bool = False) -> list[dict[str, Any]]:
        try:
            data, _headers = self._request_json(connection, "GET", _api_path(connection.base_url, "models"))
        except ModelError as error:
            if allow_missing and error.code == "API_MODEL_NOT_FOUND":
                return []
            raise
        entries = data.get("data") or data.get("models")
        if not isinstance(entries, list):
            raise ModelError("API_RESPONSE_INVALID", "The provider model list has an unexpected shape.")
        connection.connection_verified = True
        local_metadata = self._local_custom_model_metadata(connection)
        models: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            model_id = str(entry.get("id") or entry.get("name") or "").strip()
            entry = self._enrich_local_custom_model(entry, local_metadata.get(model_id))
            if entry is None:
                continue
            try:
                models.append(self._model_info(connection, entry))
            except ModelError:
                continue
        return models

    def probe(self, config: dict[str, Any]) -> dict[str, Any]:
        preset = str(config.get("preset") or "").strip().lower()
        base_url = normalize_api_base_url(preset, config.get("base_url"))
        key = self._credential(config, preset)
        custom_capabilities = config.get("custom_capabilities")
        if not isinstance(custom_capabilities, dict):
            custom_capabilities = {}
        context_value = custom_capabilities.get("context_tokens")
        custom_context = context_value if isinstance(context_value, int) and context_value >= 4_096 else None
        provider_options = config.get("provider_options")
        if not isinstance(provider_options, dict):
            provider_options = {}
        reasoning_effort = str(provider_options.get("reasoning_effort") or "minimal").strip().lower()
        if preset == "gemini" and reasoning_effort not in GEMINI_REASONING_EFFORTS:
            raise ModelError("API_REASONING_EFFORT_INVALID", "Choose Minimal, Low, Medium, or High Gemini thinking.")
        if preset != "gemini":
            reasoning_effort = "minimal"
        connection = ApiConnection(
            id=str(uuid4()),
            preset=preset,
            base_url=base_url,
            api_key=key,
            custom_images=bool(custom_capabilities.get("images")),
            custom_context_tokens=custom_context,
            reasoning_effort=reasoning_effort,
        )
        requested_model = str(config.get("model_id") or "").strip()
        models = self._fetch_models(
            connection,
            allow_missing=preset == "custom" and bool(requested_model),
        )
        selected = next((model for model in models if model["remote_model"] == requested_model), None)
        if requested_model and selected is None:
            selected = self._model_info(connection, requested_model)
            models.insert(0, selected)
        connection.models = models
        with self._connections_lock:
            while len(self._connections) >= MAX_API_CONNECTIONS:
                self._connections.pop(next(iter(self._connections)))
            self._connections[connection.id] = connection
        return {
            "connection": self._connection_public(connection),
            "models": models,
            "model": selected,
        }

    @staticmethod
    def _connection_public(connection: ApiConnection) -> dict[str, Any]:
        return {
            "id": connection.id,
            "preset": connection.preset,
            "provider_name": PRESETS[connection.preset]["name"],
            "base_url": connection.base_url,
            "credential_configured": bool(connection.api_key) or connection.preset == "custom",
            "key_hint": f"…{connection.api_key[-4:]}" if connection.api_key else None,
            "reasoning_effort": connection.reasoning_effort if connection.preset == "gemini" else None,
            "compatibility_profile": connection.compatibility_profile,
            "externally_managed": True,
            "connection_verified": connection.connection_verified,
        }

    def disconnect(self, connection_id: str) -> bool:
        with self._connections_lock:
            connection = self._connections.pop(connection_id, None)
        return connection is not None

    def _get_connection(self, connection_id: str) -> ApiConnection:
        with self._connections_lock:
            connection = self._connections.get(connection_id)
        if connection is None:
            raise ModelError(
                "API_CONNECTION_EXPIRED",
                "The API provider session expired. Reconnect it in Settings.",
            )
        return connection

    def list_models(self, connection_id: str, *, refresh: bool = True) -> dict[str, Any]:
        connection = self._get_connection(connection_id)
        if refresh:
            connection.models = self._fetch_models(connection, allow_missing=connection.preset == "custom")
        return {"connection": self._connection_public(connection), "models": connection.models}

    def resolve_model(self, reference: dict[str, Any]) -> dict[str, Any]:
        connection_id = str(reference.get("connection_id") or "").strip()
        model_id = str(reference.get("model_id") or "").strip()
        if not connection_id or not model_id:
            raise ModelError("API_MODEL_NOT_FOUND", "Select a connected API model.")
        connection = self._get_connection(connection_id)
        existing = next((model for model in connection.models if model["remote_model"] == model_id), None)
        return existing or self._model_info(connection, model_id)

    def preflight(
        self,
        model_info: dict[str, Any],
        assembled: dict[str, Any],
        *,
        context_profile: str | None,
        kv_cache: str | None,
        thinking: bool,
    ) -> dict[str, Any]:
        if (context_profile or "auto").lower() != "auto" or (kv_cache or "auto").lower() != "auto":
            raise ModelError(
                "API_RUNTIME_MANAGED",
                "Context and KV cache are managed by the API provider. Set both options to Auto.",
            )
        if thinking and model_info.get("thinking") is not True:
            raise ModelError("API_THINKING_UNAVAILABLE", "This provider model does not report reasoning controls.")
        visual_input_count = sum(
            1 for item in assembled.get("media_inputs", []) if item.get("type") in {"image", "video"}
        )
        text = "\n\n".join(
            str(message.get("content") or "")
            for message in assembled.get("messages", [])
            if isinstance(message.get("content"), str)
        )
        estimated_text_tokens = estimate_text_tokens(text)
        estimated_input_tokens = estimated_text_tokens + visual_input_count * ESTIMATED_VISUAL_TOKENS + CHAT_TEMPLATE_OVERHEAD_TOKENS
        known_context = model_info.get("model_context_limit")
        context_tokens = int(known_context) if isinstance(known_context, int) and known_context > 0 else max(
            DEFAULT_CONTEXT_TOKENS,
            estimated_input_tokens + THINKING_OUTPUT_TOKENS + CONTEXT_SAFETY_TOKENS,
        )
        standard_output_tokens = non_thinking_output_tokens(assembled)
        desired_output = THINKING_OUTPUT_TOKENS if thinking else standard_output_tokens
        provider_max_output = model_info.get("max_output_tokens")
        if isinstance(provider_max_output, int) and provider_max_output > 0:
            desired_output = min(desired_output, provider_max_output)
        available_output = context_tokens - estimated_input_tokens - CONTEXT_SAFETY_TOKENS
        minimum_output = MINIMUM_OUTPUT_TOKENS if thinking else desired_output
        if available_output < minimum_output:
            raise ModelError(
                "CONTEXT_BUDGET_EXCEEDED",
                "The selected references leave too little provider context for a complete prompt.",
                {
                    "estimated_input_tokens": estimated_input_tokens,
                    "context_tokens": context_tokens,
                    "suggestion": "Choose a larger-context API model or remove references.",
                },
            )
        max_output_tokens = min(desired_output, available_output)
        return {
            "requested_context_profile": "auto",
            "context_profile": "provider",
            "context_tokens": context_tokens,
            "requested_kv_cache": "auto",
            "kv_cache": "provider",
            "thinking": thinking,
            "estimated_text_tokens": estimated_text_tokens,
            "estimated_input_tokens": estimated_input_tokens,
            "visual_input_count": visual_input_count,
            "max_output_tokens": max_output_tokens,
            "reserved_output_tokens": max_output_tokens + CONTEXT_SAFETY_TOKENS,
            "thinking_budget_reduced": thinking and max_output_tokens < THINKING_OUTPUT_TOKENS,
            "context_limit_known": known_context is not None,
        }

    def _request_chat_completion_stream(
        self,
        connection: ApiConnection,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        http_connection = self._http_connection(connection.base_url, REQUEST_TIMEOUT_SECONDS)
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        limit = GEMINI_MAX_REQUEST_BYTES if connection.preset == "gemini" else DEFAULT_MAX_REQUEST_BYTES
        if len(body) > limit:
            raise ModelError(
                "API_REQUEST_TOO_LARGE",
                "The prepared prompt and images exceed this provider request limit.",
                {"provider": connection.preset, "request_bytes": len(body), "limit_bytes": limit},
            )
        with self._connection_lock:
            self._connection = http_connection
        content_parts: list[str] = []
        finish_reason: str | None = None
        usage: dict[str, Any] = {}
        usage_source = "missing"
        request_id: str | None = None
        try:
            http_connection.request(
                "POST",
                _api_path(connection.base_url, "chat/completions"),
                body=body,
                headers=self._headers(connection, "text/event-stream"),
            )
            response = http_connection.getresponse()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            request_id = response_headers.get("x-request-id") or response_headers.get("x-openrouter-request-id")
            if not 200 <= response.status < 300:
                raw = response.read()
                try:
                    data = json.loads(raw.decode("utf-8")) if raw else {}
                except (UnicodeDecodeError, json.JSONDecodeError):
                    data = {}
                raise self._http_error(connection.preset, response.status, data, response_headers)
            while True:
                if self.cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.")
                line = response.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="replace").strip()
                if not decoded or decoded.startswith(":") or not decoded.startswith("data:"):
                    continue
                event = decoded[5:].strip()
                if event == "[DONE]":
                    break
                try:
                    chunk = json.loads(event)
                except json.JSONDecodeError:
                    continue
                if not isinstance(chunk, dict):
                    continue
                if isinstance(chunk.get("error"), dict):
                    message = str(chunk["error"].get("message") or "The provider stream failed.")
                    raise ModelError(
                        "API_STREAM_INTERRUPTED",
                        message,
                        {"provider": connection.preset, "partial_output": bool(content_parts)},
                    )
                if isinstance(chunk.get("usage"), dict):
                    usage = chunk["usage"]
                    usage_source = "reported"
                    cost = usage.get("cost") or usage.get("total_cost")
                    if isinstance(cost, (int, float)):
                        self._provider_cost_usd += float(cost)
                provider_name = chunk.get("provider")
                if isinstance(provider_name, str) and provider_name:
                    self._upstream_providers.add(provider_name)
                choices = chunk.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue
                choice = choices[0] if isinstance(choices[0], dict) else {}
                delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                text = delta.get("content")
                if isinstance(text, str):
                    content_parts.append(text)
                elif isinstance(text, list):
                    for part in text:
                        if isinstance(part, dict) and isinstance(part.get("text"), str):
                            content_parts.append(part["text"])
                if choice.get("finish_reason") is not None:
                    finish_reason = str(choice["finish_reason"])
        except ModelError:
            raise
        except (OSError, TimeoutError, AttributeError, ValueError, http.client.HTTPException) as error:
            if self.cancel_event.is_set():
                raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.") from error
            raise ModelError(
                "API_STREAM_INTERRUPTED",
                "The connection to the API provider was interrupted.",
                {"provider": connection.preset, "partial_output": bool(content_parts), "reason": str(error)},
            ) from error
        finally:
            with self._connection_lock:
                if self._connection is http_connection:
                    self._connection = None
            http_connection.close()
        content = "".join(content_parts)
        if not usage:
            usage = {"prompt_tokens": 0, "completion_tokens": estimate_text_tokens(content)}
            usage_source = "estimated" if content else "missing"
        self._request_count += 1
        self._usage_sources.append(usage_source)
        if request_id:
            self._provider_request_ids.append(request_id)
        return {
            "choices": [{"message": {"content": content}, "finish_reason": finish_reason or "stop"}],
            "usage": usage,
        }

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
        del unload_after
        with self.lock:
            validate_media_capabilities(model_info, assembled)
            connection = self._get_connection(str(model_info.get("api_connection_id") or ""))
            runtime_plan = runtime_plan or self.preflight(
                model_info,
                assembled,
                context_profile=context_profile,
                kv_cache=kv_cache,
                thinking=thinking,
            )
            self.model_id = model_info["id"]
            try:
                if on_phase:
                    on_phase("loading_model")
                handler = _ApiChatHandler(self, connection, model_info["remote_model"])

                def complete(**kwargs: Any) -> dict[str, Any]:
                    kwargs.pop("purpose", None)
                    return handler(**kwargs)

                result = run_h3_pipeline(
                    model_info,
                    assembled,
                    session_id,
                    runtime_plan,
                    complete=complete,
                    count_text_tokens=lambda text: estimate_text_tokens(text) + 1,
                    is_cancelled=self.cancel_event.is_set,
                    thinking=thinking,
                    seed=seed,
                    on_phase=on_phase,
                )
                usage_source = "reported" if self._usage_sources and all(value == "reported" for value in self._usage_sources) else (
                    "estimated" if "estimated" in self._usage_sources else "missing"
                )
                return {
                    **result,
                    "cold_start": None,
                    "model_load_seconds": None,
                    "context_profile": runtime_plan["context_profile"],
                    "context_tokens": runtime_plan["context_tokens"],
                    "context_limit_known": runtime_plan["context_limit_known"],
                    "kv_cache": runtime_plan["kv_cache"],
                    "max_output_tokens": runtime_plan["max_output_tokens"],
                    "thinking_budget_reduced": runtime_plan["thinking_budget_reduced"],
                    "api_provider": connection.preset,
                    "provider_request_count": self._request_count,
                    "usage_source": usage_source,
                    "provider_request_ids": list(self._provider_request_ids),
                    "provider_cost_usd": round(self._provider_cost_usd, 8) if self._provider_cost_usd else None,
                    "upstream_providers": sorted(self._upstream_providers),
                    "server_managed_lifecycle": True,
                }
            except ModelError:
                raise
            except Exception as error:
                raise ModelError(
                    "API_GENERATION_FAILED",
                    "The API provider could not generate a prompt.",
                    {"provider": connection.preset, "reason": str(error)},
                ) from error


BACKEND = ApiProviderBackend()
