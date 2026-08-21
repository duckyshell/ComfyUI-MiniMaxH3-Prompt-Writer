from __future__ import annotations

import copy
import importlib.util
import json
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import quote

import folder_paths


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
            "recommended_context": item.get("recommended_context", "standard"),
            "model_file": model_file,
            "projector_file": projector_file,
            "repo_url": base,
            "source_label": f"Hugging Face · {repo}",
            "model_url": f"{base}/blob/{revision}/{quote(model_file)}",
            "projector_url": f"{base}/blob/{revision}/{quote(projector_file)}",
        })
    return result


def _gemma_capabilities(name: str) -> dict[str, bool | None]:
    normalized = name.lower().replace("_", "-")
    is_gemma4 = "gemma-4" in normalized or "gemma4" in normalized
    if not is_gemma4:
        return {"images": None, "video_frames": None, "audio": None}
    return {"images": True, "video_frames": True, "audio": False}


def _display_name(path: Path) -> str:
    return path.stem


def _model_candidate(
    model_path: Path,
    sibling_models: list[Path],
    sibling_projectors: list[Path],
    *,
    runtime_available: bool,
) -> tuple[dict[str, Any], str | None]:
    model_id = str(model_path.resolve())
    name = _display_name(model_path)
    ambiguous_projector = len(sibling_models) > 1 or len(sibling_projectors) > 1
    projector = sibling_projectors[0] if len(sibling_models) == 1 and len(sibling_projectors) == 1 else None
    missing_dependencies = []
    setup_message = None
    pairing_issue = None
    if not runtime_available:
        missing_dependencies.append("llama-cpp-python")
    if ambiguous_projector:
        missing_dependencies.append("unambiguous mmproj GGUF")
        setup_message = "Multiple models or vision projectors share this folder. Keep each model and its matching projector in a separate subfolder."
        pairing_issue = f"{model_path.parent}: multiple model or mmproj files make pairing ambiguous."
    elif projector is None:
        missing_dependencies.append("mmproj GGUF")
        pairing_issue = f"{model_path}: no mmproj GGUF was found in the same folder."
    configured = _configured_models().get(model_path.name, {})
    return {
        "id": model_id,
        "name": name,
        "family": "gguf",
        "path": model_id,
        "projector": str(projector.resolve()) if projector else None,
        "format": "GGUF",
        "role": configured.get("role", "gguf-custom"),
        "recommended_context": configured.get("recommended_context", "standard"),
        "estimated_free_vram_mb": configured.get("estimated_free_vram_mb"),
        "f16_kv_extra_mb_16k": configured.get("f16_kv_extra_mb_16k", 0),
        "thinking": "gemma-4" in name.lower(),
        "runtime_ready": not missing_dependencies,
        "missing_dependencies": missing_dependencies,
        "setup_message": setup_message,
        "capabilities": _gemma_capabilities(name),
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

        gguf_files = [path for path in root.rglob("*.gguf") if "mmproj" not in path.name.lower()]
        projectors = [path for path in root.rglob("*.gguf") if "mmproj" in path.name.lower()]
        root_diagnostics["model_files"] = [str(path.resolve()) for path in sorted(gguf_files)]
        root_diagnostics["projector_files"] = [str(path.resolve()) for path in sorted(projectors)]
        if not gguf_files and not projectors:
            root_diagnostics["issues"].append("No GGUF model or mmproj files were found.")
        elif not gguf_files:
            root_diagnostics["issues"].append("Vision projector files were found, but no model GGUF was found.")
        runtime_available = importlib.util.find_spec("llama_cpp") is not None
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

    candidate = _find_model_in_directory(
        str(model_path),
        _directory_signature(model_path.parent),
        importlib.util.find_spec("llama_cpp") is not None,
    )
    return copy.deepcopy(candidate)
