"""Standalone-only GGUF discovery and a managed llama-server backend adapter."""

from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path
from typing import Any, Callable

from .managed_runtime import ManagedLlamaServer


def _resolved(value: str | os.PathLike[str]) -> Path:
    return Path(value).expanduser().resolve()


def _normalized_server_path(value: str | os.PathLike[str]) -> Path:
    path = _resolved(value)
    if path.is_dir():
        executable = path / "llama-server.exe"
        if executable.is_file():
            return executable.resolve()
    return path


class ManagedGGUFController:
    def __init__(
        self,
        *,
        package_root: Path,
        initial_roots: tuple[Path, ...],
        metadata_reader: Callable[[Path], dict[str, Any]],
        file_classifier: Callable[[dict[str, Any] | None, str], str] | None = None,
        policy_resolver: Callable[[str | None, str | None, dict[str, Any] | None], Any] | None = None,
        readiness_timeout: float = 300.0,
    ) -> None:
        self.package_root = package_root
        self.config_path = package_root / "data" / "managed_gguf.json"
        self.metadata_reader = metadata_reader
        self.file_classifier = file_classifier
        self.policy_resolver = policy_resolver
        self._lock = threading.RLock()
        self._discovery_cache: dict[str, Any] | None = None
        self._metadata_cache: dict[str, tuple[int, int, dict[str, Any] | None, str | None]] = {}
        self._initial_roots = tuple(path.resolve() for path in initial_roots)
        self.runtime = ManagedLlamaServer(
            package_root / "data" / "logs" / "llama-server.log",
            readiness_timeout=readiness_timeout,
        )
        self._config = self._load_config()

    def _load_config(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        roots = raw.get("model_roots") if isinstance(raw.get("model_roots"), list) else []
        forgotten = raw.get("forgotten_roots") if isinstance(raw.get("forgotten_roots"), list) else []
        forgotten_roots = {
            os.path.normcase(str(_resolved(value)))
            for value in forgotten
            if isinstance(value, str) and value.strip()
        }
        combined = [*self._initial_roots, *[Path(value) for value in roots if isinstance(value, str)]]
        unique: list[str] = []
        seen: set[str] = set()
        for root in combined:
            path = _resolved(root)
            key = os.path.normcase(str(path))
            if key not in seen and key not in forgotten_roots:
                seen.add(key)
                unique.append(str(path))
        server_value = str(raw.get("server_path") or "").strip()
        return {
            "server_path": str(_normalized_server_path(server_value)) if server_value else "",
            "model_roots": unique,
            "forgotten_roots": sorted(forgotten_roots),
            "selected_model": str(raw.get("selected_model") or ""),
            "selected_projector": str(raw.get("selected_projector") or ""),
        }

    def _save(self) -> None:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.config_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._config, indent=2), encoding="utf-8")
        os.replace(temporary, self.config_path)

    def _invalidate_discovery(self) -> None:
        self._discovery_cache = None

    def _read_cached_metadata(self, path: Path) -> tuple[dict[str, Any] | None, str | None]:
        try:
            stat = path.stat()
        except OSError as error:
            return None, str(error)
        key = os.path.normcase(str(path.resolve()))
        cached = self._metadata_cache.get(key)
        signature = (stat.st_size, stat.st_mtime_ns)
        if cached is not None and cached[:2] == signature:
            return copy.deepcopy(cached[2]), cached[3]
        metadata = None
        metadata_error = None
        try:
            metadata = self.metadata_reader(path)
        except (OSError, RuntimeError, ValueError) as error:
            metadata_error = str(error)
        self._metadata_cache[key] = (signature[0], signature[1], copy.deepcopy(metadata), metadata_error)
        return metadata, metadata_error

    def config(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._config)

    def update_config(self, values: dict[str, Any]) -> dict[str, Any]:
        allowed = {"server_path", "selected_model", "selected_projector"}
        changed_runtime_selection = False
        with self._lock:
            previous = copy.deepcopy(self._config)
            try:
                for key in allowed:
                    if key not in values:
                        continue
                    value = values[key]
                    if not isinstance(value, str):
                        raise ValueError(f"{key} must be a path string.")
                    if key == "server_path" and value.strip():
                        normalized = str(_normalized_server_path(value))
                    else:
                        normalized = str(_resolved(value)) if value.strip() else ""
                    changed_runtime_selection = changed_runtime_selection or normalized != self._config[key]
                    self._config[key] = normalized

                if "selected_model" in values:
                    model_value = self._config["selected_model"]
                    if model_value:
                        model_path = Path(model_value)
                        if not model_path.is_file() or model_path.suffix.lower() != ".gguf":
                            raise ValueError(f"Model GGUF does not exist: {model_path}")
                        self._add_root_locked(model_path.parent)
                    if "selected_projector" not in values:
                        projector = self._auto_projector(model_value) if model_value else ""
                        changed_runtime_selection = changed_runtime_selection or projector != self._config["selected_projector"]
                        self._config["selected_projector"] = projector

                projector_value = self._config["selected_projector"]
                if "selected_projector" in values and projector_value:
                    projector_path = Path(projector_value)
                    if not projector_path.is_file() or projector_path.suffix.lower() != ".gguf":
                        raise ValueError(f"Vision projector GGUF does not exist: {projector_path}")
                self._save()
                if previous["model_roots"] != self._config["model_roots"]:
                    self._invalidate_discovery()
                result = self.config()
            except Exception:
                self._config = previous
                raise
        if changed_runtime_selection:
            self.runtime.stop()
        return result

    def _add_root_locked(self, path: Path) -> None:
        resolved = str(path.resolve())
        key = os.path.normcase(resolved)
        keys = {os.path.normcase(item) for item in self._config["model_roots"]}
        self._config["forgotten_roots"] = [
            item for item in self._config["forgotten_roots"] if os.path.normcase(item) != key
        ]
        if key not in keys:
            self._config["model_roots"].append(resolved)

    @staticmethod
    def _covered_by_roots(value: str, roots: list[str]) -> bool:
        if not value:
            return False
        path = _resolved(value)
        return any(path == _resolved(root) or path.is_relative_to(_resolved(root)) for root in roots)

    def _clear_orphaned_selection_locked(self) -> bool:
        selected_model = self._config["selected_model"]
        if selected_model and not self._covered_by_roots(selected_model, self._config["model_roots"]):
            self._config["selected_model"] = ""
            self._config["selected_projector"] = ""
            return True
        selected_projector = self._config["selected_projector"]
        if selected_projector and not self._covered_by_roots(selected_projector, self._config["model_roots"]):
            self._config["selected_projector"] = ""
            return True
        return False

    def _auto_projector(self, model_value: str) -> str:
        model_path = Path(model_value)
        try:
            model_metadata = self.metadata_reader(model_path)
        except (OSError, RuntimeError, ValueError):
            return ""
        model_name = str(model_metadata.get("name") or "").strip().casefold()
        if not model_name:
            return ""
        matches: list[Path] = []
        try:
            candidates = model_path.parent.glob("*.gguf")
            for candidate in candidates:
                if candidate.resolve() == model_path.resolve():
                    continue
                try:
                    metadata = self.metadata_reader(candidate)
                except (OSError, RuntimeError, ValueError):
                    continue
                split_count, split_index = self._split_metadata(metadata)
                if self._kind(metadata, candidate.name, split_count, split_index) != "projector":
                    continue
                candidate_name = str(metadata.get("name") or "").strip().casefold()
                if candidate_name == model_name:
                    matches.append(candidate.resolve())
        except OSError:
            return ""
        return str(matches[0]) if len(matches) == 1 else ""

    def add_root(self, value: str) -> dict[str, Any]:
        path = _resolved(value)
        if not path.is_dir():
            raise ValueError(f"Model folder does not exist: {path}")
        with self._lock:
            before = len(self._config["model_roots"])
            self._add_root_locked(path)
            if len(self._config["model_roots"]) != before:
                self._invalidate_discovery()
                self._save()
            return self.config()

    def remove_root(self, value: str) -> dict[str, Any]:
        target = os.path.normcase(str(_resolved(value)))
        runtime_selection_changed = False
        with self._lock:
            self._config["model_roots"] = [
                item for item in self._config["model_roots"] if os.path.normcase(item) != target
            ]
            if target not in {os.path.normcase(item) for item in self._config["forgotten_roots"]}:
                self._config["forgotten_roots"].append(target)
            runtime_selection_changed = self._clear_orphaned_selection_locked()
            self._invalidate_discovery()
            self._save()
            result = self.config()
        if runtime_selection_changed:
            self.runtime.stop()
        return result

    def clear_roots(self) -> dict[str, Any]:
        with self._lock:
            forgotten = {
                os.path.normcase(item)
                for item in [*self._config["forgotten_roots"], *self._config["model_roots"]]
            }
            self._config["forgotten_roots"] = sorted(forgotten)
            self._config["model_roots"] = []
            self._config["selected_model"] = ""
            self._config["selected_projector"] = ""
            self._invalidate_discovery()
            self._save()
            result = self.config()
        self.runtime.stop()
        return result

    @staticmethod
    def _split_metadata(metadata: dict[str, Any]) -> tuple[int, int]:
        values = metadata.get("values") if isinstance(metadata.get("values"), dict) else {}
        count = values.get("split.count", 1)
        index = values.get("split.no", 0)
        return (
            int(count) if isinstance(count, int) and count > 0 else 1,
            int(index) if isinstance(index, int) and index >= 0 else 0,
        )

    def _kind(self, metadata: dict[str, Any] | None, filename: str, split_count: int, split_index: int) -> str:
        if split_count > 1 and split_index > 0:
            return "shard"
        if self.file_classifier is not None:
            return self.file_classifier(metadata, filename)
        if metadata is None:
            return "unknown"
        architecture = str(metadata.get("architecture") or "").lower()
        projector_markers = (
            metadata.get("projector_type"),
            metadata.get("projector_projection_dim"),
            metadata.get("has_vision_encoder"),
            metadata.get("has_audio_encoder"),
        )
        if architecture == "clip" and any(value not in {None, False, ""} for value in projector_markers):
            return "projector"
        if architecture and architecture != "clip":
            return "model"
        return "unknown"

    @staticmethod
    def _reasoning_effort(metadata: dict[str, Any], policy: Any) -> str | None:
        controls = metadata.get("template_controls", {})
        if controls.get("reasoning_effort") is not True:
            return None
        if policy is not None and policy.reasoning_effort:
            return str(policy.reasoning_effort)
        values = metadata.get("values") if isinstance(metadata.get("values"), dict) else {}
        template = str(values.get("tokenizer.chat_template") or "")
        # Modified model provenance may intentionally prevent an official lineage
        # match. The embedded template itself remains authoritative for accepted
        # kwargs; only pass Low when it explicitly advertises that exact value.
        if "reasoning_effort" in template and ("'low'" in template or '"low"' in template):
            return "low"
        return None

    def discover(self, *, refresh: bool = False) -> dict[str, Any]:
        with self._lock:
            if self._discovery_cache is not None and not refresh:
                return copy.deepcopy(self._discovery_cache)
        files: list[dict[str, Any]] = []
        seen: set[str] = set()
        roots: list[dict[str, Any]] = []
        for value in self.config()["model_roots"]:
            root = Path(value)
            root_info = {"path": str(root), "exists": root.is_dir(), "files": 0, "error": None}
            roots.append(root_info)
            if not root.is_dir():
                continue
            try:
                candidates = sorted(path for path in root.rglob("*.gguf") if path.is_file())
            except OSError as error:
                root_info["error"] = str(error)
                continue
            for path in candidates:
                resolved = str(path.resolve())
                key = os.path.normcase(resolved)
                if key in seen:
                    continue
                seen.add(key)
                metadata, metadata_error = self._read_cached_metadata(path)
                split_count, split_index = self._split_metadata(metadata or {})
                kind = self._kind(metadata, path.name, split_count, split_index)
                template_controls = (metadata or {}).get("template_controls", {})
                policy = None
                if metadata is not None and self.policy_resolver is not None:
                    policy = self.policy_resolver(
                        metadata.get("architecture"),
                        metadata.get("name"),
                        metadata.get("values"),
                    )
                files.append({
                    "path": resolved,
                    "name": path.name,
                    "kind": kind,
                    "metadata_status": "readable" if metadata is not None else "unverified",
                    "metadata_error": metadata_error,
                    "architecture": (metadata or {}).get("architecture"),
                    "metadata_name": (metadata or {}).get("name"),
                    "context_length": (metadata or {}).get("context_length"),
                    "embedding_length": (metadata or {}).get("embedding_length"),
                    "projector_type": (metadata or {}).get("projector_type"),
                    "has_vision_encoder": (metadata or {}).get("has_vision_encoder") is True,
                    "split_count": split_count,
                    "split_index": split_index,
                    "thinking": bool(template_controls.get("enable_thinking")),
                    "template_reasoning_control": bool(template_controls.get("reasoning_effort")),
                    "reasoning_effort": self._reasoning_effort(metadata or {}, policy),
                    "reasoning_effort_values": list((metadata or {}).get("reasoning_effort_values") or []),
                    "model_policy": policy.id if policy is not None else None,
                })
                root_info["files"] += 1
        files.sort(key=lambda item: (item["kind"], item["name"].lower(), item["path"].lower()))
        result = {"roots": roots, "files": files}
        with self._lock:
            self._discovery_cache = copy.deepcopy(result)
        return result

    def _server_ready(self) -> bool:
        value = self.config()["server_path"]
        return bool(value and Path(value).is_file())

    def _selected_projector(self, model_path: str) -> str | None:
        config = self.config()
        if os.path.normcase(config["selected_model"]) == os.path.normcase(model_path):
            projector = config["selected_projector"]
            return projector if projector and Path(projector).is_file() else None
        projector = self._auto_projector(model_path)
        return projector if projector and Path(projector).is_file() else None

    def _model_info(self, item: dict[str, Any]) -> dict[str, Any]:
        model_path = item["path"]
        projector = self._selected_projector(model_path)
        runtime_ready = self._server_ready()
        native_context = item.get("context_length")
        profiles = ["low", "standard", "extended", "large", "maximum"]
        context_sizes = {"low": 8192, "standard": 16384, "extended": 24576, "large": 32768, "maximum": 49152}
        if isinstance(native_context, int) and native_context > 0:
            profiles = [name for name in profiles if context_sizes[name] <= native_context]
        verified_model = item["kind"] == "model"
        reasoning_effort = item.get("reasoning_effort")
        reasoning_effort_values = list(item.get("reasoning_effort_values") or [])
        return {
            "id": model_path,
            "name": Path(model_path).stem,
            "metadata_name": item.get("metadata_name"),
            "family": "gguf",
            "path": model_path,
            "projector": projector,
            "format": "GGUF",
            "role": "managed-llama-server",
            "recommended_context": "extended" if reasoning_effort == "low" else "standard",
            "context_profiles": profiles,
            "auto_context_ladder": False,
            "thinking": bool(item.get("thinking")),
            "runtime_ready": runtime_ready,
            "model_ready": True,
            "missing_dependencies": [] if runtime_ready else ["llama-server.exe"],
            "setup_message": None if runtime_ready else "Select an official llama-server executable in Direct GGUF settings.",
            "runtime_requirement": {"state": "ready" if runtime_ready else "missing"},
            "runtime_version": None,
            "runtime_supported": runtime_ready,
            "metadata_status": item["metadata_status"],
            "metadata_error": item.get("metadata_error"),
            "architecture": item.get("architecture"),
            "architecture_adapter": (
                item.get("architecture")
                if item.get("architecture") in {"qwen35", "qwen35moe", "qwen3vl"}
                else "llama-server"
            ),
            "architecture_recognized": verified_model,
            "configuration_verified": False,
            "verification_status": "metadata_detected" if verified_model else "unverified",
            "vision_status": "selected_unverified" if projector else "missing",
            "capability_message": None if projector else "No vision projector is selected. T2VA and Music3 remain available.",
            "native_context_tokens": native_context,
            "embedding_length": item.get("embedding_length"),
            "model_policy": item.get("model_policy"),
            "model_policy_supported": bool(item.get("model_policy")),
            "reasoning_effort": reasoning_effort,
            "reasoning_effort_values": reasoning_effort_values,
            "template_controls": {
                "enable_thinking": bool(item.get("thinking")),
                "reasoning_effort": bool(item.get("template_reasoning_control")),
            },
            "detected_capabilities": {"thinking": bool(item.get("thinking")), "vision_projector": bool(projector)},
            "verified_capabilities": {"text": False, "vision": False},
            "capabilities": {"images": bool(projector), "video_frames": bool(projector), "audio": False},
            "source_label": "Managed local llama-server",
        }

    def catalog(self) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        discovery = self.discover()
        model_items = [item for item in discovery["files"] if item["kind"] in {"model", "unknown"}]
        models = [self._model_info(item) for item in model_items]
        diagnostics = {
            "roots": [
                {
                    "path": root["path"],
                    "exists": root["exists"],
                    "model_files": [item["path"] for item in model_items if item["path"].startswith(root["path"])],
                    "projector_files": [
                        item["path"] for item in discovery["files"]
                        if item["kind"] == "projector" and item["path"].startswith(root["path"])
                    ],
                    "issues": [root["error"]] if root["error"] else [],
                }
                for root in discovery["roots"]
            ],
            "totals": {
                "models": len(models),
                "projectors": sum(item["kind"] == "projector" for item in discovery["files"]),
                "ready_models": sum(model["runtime_ready"] for model in models),
                "incomplete_models": sum(not model["runtime_ready"] for model in models),
            },
        }
        return models, diagnostics

    def find_model(self, model_id: str) -> dict[str, Any] | None:
        normalized = os.path.normcase(str(_resolved(model_id))) if model_id else ""
        for model in self.catalog()[0]:
            if os.path.normcase(model["id"]) == normalized:
                return model
        return None

    def state(self, *, refresh: bool = False) -> dict[str, Any]:
        config = self.config()
        return {
            "config": config,
            "runtime": self.runtime.status(),
            "discovery": self.discover(refresh=refresh),
            "server_selected": bool(config["server_path"] and Path(config["server_path"]).is_file()),
        }


class ManagedGGUFBackend:
    manages_gpu_memory = False
    externally_managed = False

    def __init__(
        self,
        controller: ManagedGGUFController,
        external_backend: Any,
        model_error: type[Exception],
        context_profiles: dict[str, int],
    ) -> None:
        self.controller = controller
        self.external = external_backend
        self.model_error = model_error
        self.context_profiles = context_profiles
        self._active_model_id: str | None = None
        self._remote_model: dict[str, Any] | None = None
        self._unload_requested = False
        self._lock = threading.RLock()

    def status(self) -> dict[str, Any]:
        runtime = self.controller.runtime.status()
        return {
            "loaded_model_id": self._active_model_id if runtime["running"] else None,
            "loaded": runtime["running"],
            "loaded_context_tokens": (self._remote_model or {}).get("server_context_tokens"),
            "loaded_kv_cache": "server" if runtime["running"] else None,
            "managed_llama_server": True,
        }

    def prepare_request(self) -> None:
        self._unload_requested = False
        self.external.prepare_request()

    def cancel(self) -> bool:
        return bool(self.external.cancel())

    def request_unload(self) -> bool:
        self._unload_requested = True
        return self.cancel()

    def unload(self) -> None:
        with self._lock:
            self.external.cancel()
            self.controller.runtime.stop()
            self._active_model_id = None
            self._remote_model = None

    def _configuration(self, model: dict[str, Any]) -> tuple[Path, Path, Path | None]:
        config = self.controller.config()
        binary_value = config["server_path"]
        if not binary_value or not Path(binary_value).is_file():
            raise self.model_error("MANAGED_SERVER_MISSING", "Select llama-server.exe in Direct GGUF settings.")
        model_path = Path(model["path"])
        if not model_path.is_file():
            raise self.model_error("MODEL_NOT_FOUND", f"The selected GGUF no longer exists: {model_path}")
        projector_value = model.get("projector")
        projector = Path(projector_value) if projector_value else None
        if projector is not None and not projector.is_file():
            raise self.model_error("PROJECTOR_NOT_FOUND", f"The selected projector no longer exists: {projector}")
        return Path(binary_value), model_path, projector

    def preflight(
        self,
        model: dict[str, Any],
        assembled: dict[str, Any],
        *,
        context_profile: str | None,
        kv_cache: str | None,
        thinking: bool,
        context_tokens: int | None = None,
        generation_budget: int | None = None,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        binary, model_path, projector = self._configuration(model)
        requested_profile = str(context_profile or "auto").lower()
        if requested_profile == "custom":
            if not isinstance(context_tokens, int) or isinstance(context_tokens, bool) or context_tokens < 1024:
                raise self.model_error(
                    "INVALID_CUSTOM_CONTEXT",
                    "Custom Context must be an integer of at least 1,024 tokens.",
                )
            native_context = model.get("native_context_tokens")
            if isinstance(native_context, int) and native_context > 0 and context_tokens > native_context:
                raise self.model_error(
                    "CONTEXT_EXCEEDS_NATIVE",
                    "Custom Context cannot exceed the model's native context.",
                    {"context_tokens": context_tokens, "native_context_tokens": native_context},
                )
            profile = "custom"
            selected_context_tokens = context_tokens
        else:
            available_profiles = list(model.get("context_profiles") or [])
            if not available_profiles:
                raise self.model_error(
                    "MODEL_NATIVE_CONTEXT_UNSUPPORTED",
                    "The model's native context is smaller than the available Context presets. Select Custom Context.",
                    {"native_context_tokens": model.get("native_context_tokens")},
                )
            recommended = model.get("recommended_context", "standard")
            profile = (
                recommended if recommended in available_profiles else available_profiles[0]
            ) if requested_profile == "auto" else requested_profile
            selected_context_tokens = int(self.context_profiles.get(profile, 0))
        if profile != "custom" and (
            profile not in self.context_profiles or profile not in model.get("context_profiles", [])
        ):
            raise self.model_error("INVALID_CONTEXT_PROFILE", "Select a supported context profile.")
        if generation_budget is not None and (
            not isinstance(generation_budget, int)
            or isinstance(generation_budget, bool)
            or generation_budget <= 0
        ):
            raise self.model_error(
                "INVALID_GENERATION_BUDGET",
                "Generation budget must be a positive integer number of tokens.",
            )
        requested_effort = str(reasoning_effort or "auto").strip().lower()
        supported_efforts = list(model.get("reasoning_effort_values") or [])
        if thinking and requested_effort != "auto" and requested_effort not in supported_efforts:
            raise self.model_error(
                "DIRECT_REASONING_EFFORT_UNAVAILABLE",
                "The selected reasoning effort is not supported by this model's chat template.",
                {"reasoning_effort": requested_effort, "supported_reasoning_efforts": supported_efforts},
            )
        effective_effort = None if not thinking else (
            model.get("reasoning_effort") if requested_effort == "auto" else requested_effort
        )
        requested_kv = str(kv_cache or "auto").lower()
        try:
            runtime = self.controller.runtime.start(
                binary=binary,
                model=model_path,
                projector=projector,
                context_tokens=selected_context_tokens,
                kv_cache=requested_kv,
            )
            remote = self.external.probe_model({"url": runtime["endpoint"], "model": "h3-managed"})
        except self.model_error:
            self.controller.runtime.stop()
            raise
        except Exception as error:
            self.controller.runtime.stop()
            raise self.model_error(
                "MANAGED_SERVER_START_FAILED",
                "llama-server could not load the selected GGUF configuration.",
                {"reason": str(error), "log_path": str(self.controller.runtime.log_path)},
            ) from error
        with self._lock:
            self._active_model_id = model["id"]
            self._remote_model = remote
        try:
            plan = self.external.preflight(
                remote,
                assembled,
                context_profile="auto",
                kv_cache="auto",
                thinking=thinking,
            )
        except Exception:
            self.unload()
            raise
        if generation_budget is not None:
            safety_tokens = int(plan["reserved_output_tokens"]) - int(plan["max_output_tokens"])
            minimum_required = int(plan["estimated_input_tokens"]) + generation_budget + safety_tokens
            if minimum_required > selected_context_tokens:
                self.unload()
                raise self.model_error(
                    "CONTEXT_BUDGET_EXCEEDED",
                    "This request and Generation budget do not fit the selected Context.",
                    {
                        "estimated_input_tokens": plan["estimated_input_tokens"],
                        "generation_budget": generation_budget,
                        "safety_tokens": safety_tokens,
                        "context_tokens": selected_context_tokens,
                        "suggestion": "Reduce Generation budget, remove references, or shorten the creative brief.",
                    },
                )
            plan.update({
                "max_output_tokens": generation_budget,
                "reserved_output_tokens": generation_budget + safety_tokens,
                "generation_budget_manual": True,
            })
        plan.update({
            "requested_context_profile": requested_profile,
            "context_profile": profile,
            "requested_kv_cache": requested_kv,
            "kv_cache": requested_kv if requested_kv != "auto" else "server",
            "requested_reasoning_effort": requested_effort,
            "reasoning_effort": effective_effort,
        })
        return plan

    def generate(self, model: dict[str, Any], assembled: dict[str, Any], session_id: str, **options: Any) -> dict[str, Any]:
        with self._lock:
            remote = copy.deepcopy(self._remote_model)
        if remote is None:
            raise self.model_error("MANAGED_SERVER_NOT_READY", "The managed llama-server is not ready.")
        unload_after = bool(options.get("unload_after", True))
        delegated = dict(options)
        delegated.update({"unload_after": False, "context_profile": "auto", "kv_cache": "auto"})
        configure_model = getattr(self.external, "configure_managed_model", None)
        if callable(configure_model):
            configured_model = copy.deepcopy(model)
            configured_model["reasoning_effort"] = options.get("runtime_plan", {}).get("reasoning_effort")
            configure_model(configured_model)
        remote.update({
            key: copy.deepcopy(model[key])
            for key in ("architecture_adapter", "model_policy", "reasoning_effort", "template_controls")
            if key in model
        })
        try:
            result = self.external.generate(remote, assembled, session_id, **delegated)
            result.update({"managed_llama_server": True, "external_server": False})
            return result
        finally:
            if unload_after or self._unload_requested:
                self.unload()


def managed_runtime_diagnostics(controller: ManagedGGUFController, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
    config = controller.config()
    selected = bool(config["server_path"] and Path(config["server_path"]).is_file())
    return {
        # The managed backend itself is available even before a binary is chosen.
        # Selection is request configuration, not a Python native-runtime health check.
        "status": "ok",
        "message": "A user-supplied llama-server is selected." if selected else "llama-server starts after it is selected.",
        "package_version": None,
        "gpu_offload": None,
        "backend": "managed llama-server",
        "onboarding": {"state": "ready", "install_command": None},
    }
