from __future__ import annotations

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


def discover_models() -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    for root_name in folder_paths.get_folder_paths("LLM"):
        root = Path(root_name)
        if not root.exists():
            continue

        gguf_files = [path for path in root.rglob("*.gguf") if "mmproj" not in path.name.lower()]
        projectors = [path for path in root.rglob("*.gguf") if "mmproj" in path.name.lower()]
        for model_path in gguf_files:
            model_id = str(model_path.resolve())
            if model_id in seen:
                continue
            seen.add(model_id)
            name = _display_name(model_path)
            sibling_models = [p for p in gguf_files if p.parent == model_path.parent]
            sibling_projectors = [p for p in projectors if p.parent == model_path.parent]
            ambiguous_projector = len(sibling_models) > 1 or len(sibling_projectors) > 1
            projector = sibling_projectors[0] if len(sibling_models) == 1 and len(sibling_projectors) == 1 else None
            missing_dependencies = []
            setup_message = None
            if importlib.util.find_spec("llama_cpp") is None:
                missing_dependencies.append("llama-cpp-python")
            if ambiguous_projector:
                missing_dependencies.append("unambiguous mmproj GGUF")
                setup_message = "Multiple models or vision projectors share this folder. Keep each model and its matching projector in a separate subfolder."
            elif projector is None:
                missing_dependencies.append("mmproj GGUF")
            capabilities = _gemma_capabilities(name)
            configured = _configured_models().get(model_path.name, {})
            candidates.append(
                {
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
                    "capabilities": capabilities,
                }
            )

    return sorted(candidates, key=lambda item: item["name"].lower())


def find_model(model_id: str) -> dict[str, Any] | None:
    return next((model for model in discover_models() if model["id"] == model_id), None)
