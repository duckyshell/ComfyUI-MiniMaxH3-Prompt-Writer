from __future__ import annotations

import copy
import importlib.metadata
import importlib.util
import json
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import quote

import folder_paths

from .gguf_metadata import GGUFMetadataError, read_gguf_metadata
from .context import CONTEXT_PROFILES
from .models.gguf_adapters import (
    QWEN_VISION_ADAPTER_IDS,
    architecture_adapter,
    projector_is_compatible,
    runtime_supports,
    version_tuple,
)
from .models.gguf_policies import (
    non_policy_configuration_is_verified,
    policy_for_lineage,
    policy_is_verified_configuration,
    resolve_model_lineage,
)


CONFIG_PATH = Path(__file__).resolve().parents[1] / "models.json"


@lru_cache(maxsize=1)
def _configured_models() -> dict[str, dict[str, Any]]:
    try:
        configured = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))["models"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    return {
        filename: item
        for item in configured
        for filename in item.get("files", [])
        if filename.lower().endswith(".gguf") and "mmproj" not in filename.lower()
    }


def model_setup_catalog() -> list[dict[str, Any]]:
    try:
        configured = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))["models"]
    except (OSError, ValueError, KeyError, TypeError):
        return []
    result = []
    for item in configured:
        files = item.get("files", [])
        model_file = next((name for name in files if name.lower().endswith(".gguf") and "mmproj" not in name.lower()), None)
        projector_file = next((name for name in files if "mmproj" in name.lower()), None)
        repo = item.get("repo")
        revision = item.get("revision", "main")
        if not repo or not model_file or not projector_file:
            continue
        base = f"https://huggingface.co/{repo}"
        result.append({
            "id": item.get("id", model_file),
            "name": item.get("display_name", Path(model_file).stem),
            "vram_gb": item.get("vram_gb"),
            "minimum_runtime": item.get("minimum_runtime"),
            "recommended_context": item.get("recommended_context", "standard"),
            "model_file": model_file,
            "projector_file": projector_file,
            "repo_url": base,
            "source_label": f"Hugging Face · {repo}",
            "model_url": f"{base}/blob/{revision}/{quote(model_file)}",
            "projector_url": f"{base}/blob/{revision}/{quote(projector_file)}",
        })
    return result


def _vision_capabilities() -> dict[str, bool]:
    return {"images": True, "video_frames": True, "audio": False}


def _text_only_capabilities() -> dict[str, bool]:
    return {"images": False, "video_frames": False, "audio": False}


def _display_name(path: Path) -> str:
    return path.stem


def _runtime_version() -> str | None:
    try:
        return importlib.metadata.version("llama-cpp-python")
    except importlib.metadata.PackageNotFoundError:
        return None


def _metadata_result(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        return read_gguf_metadata(path), None
    except (GGUFMetadataError, OSError, RuntimeError) as error:
        return None, str(error)


def _pair_projector(
    model_metadata: dict[str, Any],
    sibling_models: list[Path],
    sibling_projectors: list[Path],
) -> tuple[Path | None, str, str | None]:
    if not sibling_projectors:
        return None, "missing", "No mmproj GGUF was found in the same folder."
    if len(sibling_models) > 1:
        return None, "ambiguous", "Multiple model GGUF files share this folder. Keep each model and its matching projector in a separate subfolder."

    adapter = architecture_adapter(model_metadata.get("architecture"))
    compatible: list[Path] = []
    for projector_path in sibling_projectors:
        projector_metadata, _error = _metadata_result(projector_path)
        if projector_metadata and projector_is_compatible(adapter, model_metadata, projector_metadata):
            compatible.append(projector_path)
    if len(compatible) == 1:
        return compatible[0], "compatible", None
    if len(compatible) > 1:
        return None, "ambiguous", "Multiple compatible vision projectors share this folder. Keep only the intended projector beside the model."
    return None, "incompatible", "The mmproj files in this folder are not metadata-compatible with this model."


def _model_candidate(
    model_path: Path,
    sibling_models: list[Path],
    sibling_projectors: list[Path],
    *,
    runtime_available: bool,
    runtime_version: str | None,
) -> tuple[dict[str, Any], str | None]:
    model_id = str(model_path.resolve())
    metadata, metadata_error = _metadata_result(model_path)
    architecture = metadata.get("architecture") if metadata else None
    adapter = architecture_adapter(architecture)
    architecture_recognized = adapter is not None
    installed_runtime_support = runtime_supports(adapter, runtime_version, module_available=runtime_available)
    minimum_runtime = ".".join(str(part) for part in adapter.minimum_runtime) if adapter else None
    parsed_runtime = version_tuple(runtime_version)
    if not architecture_recognized:
        runtime_requirement_state = "not_applicable"
    elif not runtime_available:
        runtime_requirement_state = "missing"
    elif installed_runtime_support:
        runtime_requirement_state = "ready"
    elif parsed_runtime and adapter and parsed_runtime < adapter.minimum_runtime:
        runtime_requirement_state = "update_required"
    else:
        runtime_requirement_state = "incompatible"

    missing_dependencies: list[str] = []
    setup_message = None
    if metadata is None:
        missing_dependencies.append("readable GGUF metadata")
        setup_message = f"Writer could not read this GGUF header: {metadata_error}"
    elif not architecture_recognized:
        missing_dependencies.append("supported GGUF architecture")
        setup_message = f"Architecture {architecture or 'unknown'} is discoverable but not supported by Direct GGUF."
    elif not runtime_available:
        missing_dependencies.append("llama-cpp-python")
    elif not installed_runtime_support:
        missing_dependencies.append(f"llama-cpp-python>={minimum_runtime} for {adapter.id}")
        setup_message = f"The installed llama-cpp-python {runtime_version or 'version'} does not support the {adapter.id} Direct adapter."

    if metadata:
        projector, vision_status, pairing_message = _pair_projector(metadata, sibling_models, sibling_projectors)
    else:
        projector, vision_status, pairing_message = None, "incompatible", "Vision is disabled because the model metadata could not be read."
    pairing_issue = f"{model_path}: {pairing_message}" if pairing_message else None
    text_fallback = " T2VA remains available." if not missing_dependencies else ""
    capability_message = None if vision_status == "compatible" else f"Vision unavailable: {pairing_message}{text_fallback}"

    configured = _configured_models().get(model_path.name, {}) if metadata and architecture_recognized else {}
    metadata_name = str((metadata or {}).get("name") or "") or None
    lineage_match = resolve_model_lineage(
        architecture,
        metadata_name,
        (metadata or {}).get("values"),
    )
    model_policy = policy_for_lineage(lineage_match.lineage.id if lineage_match else None)
    qwen_context = adapter is not None and adapter.id in QWEN_VISION_ADAPTER_IDS
    non_policy_verified = non_policy_configuration_is_verified(
        architecture,
        metadata_name,
        model_path,
        projector,
    )
    if qwen_context and model_policy is None and not non_policy_verified:
        configured = {}
    name = str(configured.get("display_name") or _display_name(model_path))
    template_controls = (metadata or {}).get("template_controls") or {
        "enable_thinking": False,
        "reasoning_effort": False,
    }
    configuration_verified = bool(metadata) and architecture_recognized and (
        (bool(configured) and not qwen_context)
        or policy_is_verified_configuration(model_policy, model_path, projector)
        or non_policy_verified
    )
    native_context = (metadata or {}).get("context_length")
    context_profiles = (
        ["standard", "extended", "large", "maximum"]
        if qwen_context
        else ["low", "standard", "extended"]
    )
    if isinstance(native_context, int) and native_context > 0:
        context_profiles = [
            profile for profile in context_profiles
            if CONTEXT_PROFILES[profile] <= native_context
        ]
    return {
        "id": model_id,
        "name": name,
        "family": "gguf",
        "path": model_id,
        "projector": str(projector.resolve()) if projector else None,
        "format": "GGUF",
        "role": configured.get("role", "gguf-custom"),
        "recommended_context": configured.get("recommended_context", "standard"),
        "context_profiles": context_profiles,
        "auto_context_ladder": qwen_context,
        "estimated_free_vram_mb": configured.get("estimated_free_vram_mb"),
        "f16_kv_extra_mb_16k": configured.get("f16_kv_extra_mb_16k", 0),
        "thinking": bool(template_controls["enable_thinking"]),
        "discovery_status": "found",
        "metadata_status": "readable" if metadata else "invalid",
        "metadata_error": metadata_error,
        "architecture": architecture,
        "architecture_adapter": adapter.id if adapter else "unknown",
        "architecture_recognized": architecture_recognized,
        "metadata_name": metadata_name,
        "model_lineage": lineage_match.lineage.id if lineage_match else None,
        "model_lineage_source": lineage_match.source if lineage_match else None,
        "model_policy": model_policy.id if model_policy else None,
        "model_policy_supported": model_policy is not None,
        "runtime_version": runtime_version,
        "runtime_supported": installed_runtime_support,
        "runtime_ready": not missing_dependencies,
        "model_ready": metadata is not None and architecture_recognized,
        "runtime_requirement": {
            "state": runtime_requirement_state,
            "installed_version": runtime_version,
            "minimum_version": minimum_runtime,
            "adapter": adapter.id if adapter else None,
        },
        "missing_dependencies": missing_dependencies,
        "setup_message": setup_message,
        "vision_status": vision_status,
        "capability_message": capability_message,
        "configuration_verified": configuration_verified,
        "verification_status": "verified" if configuration_verified else "compatible_unverified" if architecture_recognized else "unsupported",
        "verified_capabilities": {
            "text": configuration_verified,
            "vision": configuration_verified and projector is not None,
        },
        "native_context_tokens": native_context,
        "embedding_length": (metadata or {}).get("embedding_length"),
        "template_controls": template_controls,
        "mtp_detected": bool((metadata or {}).get("mtp_detected")),
        "detected_capabilities": {
            "thinking": bool(template_controls["enable_thinking"]),
            "reasoning_effort": bool(template_controls["reasoning_effort"]),
            "vision_projector": projector is not None,
        },
        "projector_metadata": {
            key: value
            for key, value in ((_metadata_result(projector)[0] if projector else {}) or {}).items()
            if key not in {"values", "chat_template"}
        },
        "capabilities": _vision_capabilities() if projector else _text_only_capabilities(),
    }, pairing_issue


def discover_models_with_diagnostics() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    scanned_roots: list[dict[str, Any]] = []

    for root_name in folder_paths.get_folder_paths("LLM"):
        root = Path(root_name)
        root_diagnostics: dict[str, Any] = {
            "path": str(root),
            "exists": root.exists(),
            "model_files": [],
            "projector_files": [],
            "issues": [],
        }
        scanned_roots.append(root_diagnostics)
        if not root.exists():
            root_diagnostics["issues"].append("Directory does not exist.")
            continue

        gguf_files = [
            path for path in root.rglob("*.gguf")
            if path.is_file() and "mmproj" not in path.name.lower()
        ]
        projectors = [
            path for path in root.rglob("*.gguf")
            if path.is_file() and "mmproj" in path.name.lower()
        ]
        root_diagnostics["model_files"] = [str(path.resolve()) for path in sorted(gguf_files)]
        root_diagnostics["projector_files"] = [str(path.resolve()) for path in sorted(projectors)]
        if not gguf_files and not projectors:
            root_diagnostics["issues"].append("No GGUF model or mmproj files were found.")
        elif not gguf_files:
            root_diagnostics["issues"].append("Vision projector files were found, but no model GGUF was found.")
        runtime_available = importlib.util.find_spec("llama_cpp") is not None
        runtime_version = _runtime_version() if runtime_available else None
        for model_path in gguf_files:
            model_id = str(model_path.resolve())
            if model_id in seen:
                continue
            seen.add(model_id)
            sibling_models = [p for p in gguf_files if p.parent == model_path.parent]
            sibling_projectors = [p for p in projectors if p.parent == model_path.parent]
            candidate, pairing_issue = _model_candidate(
                model_path,
                sibling_models,
                sibling_projectors,
                runtime_available=runtime_available,
                runtime_version=runtime_version,
            )
            candidates.append(candidate)
            if pairing_issue:
                root_diagnostics["issues"].append(pairing_issue)

    models = sorted(candidates, key=lambda item: item["name"].lower())
    diagnostics = {
        "roots": scanned_roots,
        "totals": {
            "models": len(models),
            "projectors": sum(len(root["projector_files"]) for root in scanned_roots),
            "ready_models": sum(1 for model in models if model["runtime_ready"]),
            "incomplete_models": sum(1 for model in models if not model["runtime_ready"]),
        },
    }
    return models, diagnostics


def discover_models() -> list[dict[str, Any]]:
    return discover_models_with_diagnostics()[0]


def _directory_signature(directory: Path) -> tuple[tuple[str, int, int], ...]:
    entries = []
    for path in directory.glob("*.gguf"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        entries.append((path.name, stat.st_size, stat.st_mtime_ns))
    return tuple(sorted(entries))


@lru_cache(maxsize=32)
def _find_model_in_directory(
    model_id: str,
    signature: tuple[tuple[str, int, int], ...],
    runtime_available: bool,
    runtime_version: str | None,
) -> dict[str, Any] | None:
    model_path = Path(model_id)
    files = [model_path.parent / name for name, _size, _mtime in signature]
    sibling_models = [path for path in files if "mmproj" not in path.name.lower()]
    sibling_projectors = [path for path in files if "mmproj" in path.name.lower()]
    if model_path not in sibling_models:
        return None
    candidate, _pairing_issue = _model_candidate(
        model_path,
        sibling_models,
        sibling_projectors,
        runtime_available=runtime_available,
        runtime_version=runtime_version,
    )
    return candidate


def find_model(model_id: str) -> dict[str, Any] | None:
    try:
        model_path = Path(model_id).resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if not model_path.is_file() or model_path.suffix.lower() != ".gguf" or "mmproj" in model_path.name.lower():
        return None

    roots = []
    for root_name in folder_paths.get_folder_paths("LLM"):
        try:
            roots.append(Path(root_name).resolve(strict=True))
        except (OSError, RuntimeError):
            continue
    if not any(model_path.is_relative_to(root) for root in roots):
        return None

    runtime_available = importlib.util.find_spec("llama_cpp") is not None
    candidate = _find_model_in_directory(
        str(model_path),
        _directory_signature(model_path.parent),
        runtime_available,
        _runtime_version() if runtime_available else None,
    )
    return copy.deepcopy(candidate)
