from __future__ import annotations

import copy
import importlib.metadata
import importlib.util
import re
import sys
import threading
from pathlib import Path
from typing import Any


MINIMUM_VERSION = (0, 3, 34)
MAXIMUM_VERSION = (0, 4, 0)
TESTED_WINDOWS_CUDA13_INSTALL_COMMAND = (
    '.\\python_embeded\\python.exe -m pip install --only-binary=:all: '
    '--extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 '
    '"llama-cpp-python>=0.3.35,<0.4"'
)
_CACHE: dict[str, Any] | None = None
_CACHE_LOCK = threading.Lock()


def _version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", value)[:3])


def _host_accelerator() -> dict[str, Any] | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        return {
            "name": torch.cuda.get_device_name(0),
            "cuda_version": getattr(torch.version, "cuda", None),
            "hip_version": getattr(torch.version, "hip", None),
        }
    except Exception:
        return None


def _is_tested_windows_cuda13_environment(accelerator: dict[str, Any] | None) -> bool:
    executable_parent = Path(sys.executable).parent.name.lower()
    cuda_version = str((accelerator or {}).get("cuda_version") or "")
    return sys.platform == "win32" and executable_parent == "python_embeded" and cuda_version.startswith("13.")


def _runtime_onboarding(diagnostics: dict[str, Any]) -> dict[str, Any]:
    if diagnostics.get("package_version") is None:
        tested_environment = _is_tested_windows_cuda13_environment(diagnostics.get("accelerator"))
        return {
            "state": "missing",
            "tested_environment": tested_environment,
            "install_command": TESTED_WINDOWS_CUDA13_INSTALL_COMMAND if tested_environment else None,
        }
    if diagnostics.get("status") == "ok":
        return {"state": "ready", "tested_environment": False, "install_command": None}
    return {"state": "broken", "tested_environment": False, "install_command": None}


def _runtime_actions(diagnostics: dict[str, Any]) -> dict[str, Any]:
    tested_environment = _is_tested_windows_cuda13_environment(diagnostics.get("accelerator"))
    return {
        "tested_environment": tested_environment,
        "install_or_upgrade_command": TESTED_WINDOWS_CUDA13_INSTALL_COMMAND if tested_environment else None,
    }


def _module_available() -> bool:
    try:
        return importlib.util.find_spec("llama_cpp") is not None
    except (ImportError, AttributeError, ValueError):
        return False


def _run_probe() -> dict[str, Any]:
    accelerator = _host_accelerator()
    result: dict[str, Any] = {
        "status": "unavailable",
        "package_version": None,
        "gpu_offload": None,
        "backend": None,
        "system_info": None,
        "environment": {},
        "accelerator": accelerator,
        "warnings": [],
    }
    try:
        package_version = importlib.metadata.version("llama-cpp-python")
    except importlib.metadata.PackageNotFoundError:
        result.update({
            "error_type": "PackageNotFoundError",
            "error": "No package metadata was found for llama-cpp-python.",
            "message": "llama-cpp-python is not installed in the ComfyUI Python environment.",
        })
        return result

    result["package_version"] = package_version
    version = _version_tuple(package_version)
    if version < MINIMUM_VERSION or version >= MAXIMUM_VERSION:
        result.update({
            "error_type": "RuntimeVersionError",
            "error": "llama-cpp-python 0.3.34 or newer from the 0.3.x series is required.",
            "message": "The installed llama-cpp-python version is outside the supported range.",
        })
        return result
    if not _module_available():
        result.update({
            "error_type": "ModuleNotFoundError",
            "error": "The llama_cpp module could not be located.",
            "message": "llama-cpp-python metadata exists, but its Python module is unavailable.",
        })
        return result

    result.update({
        "status": "ok",
        "message": "The llama-cpp-python package is available. Native compatibility is checked when a Direct GGUF model loads.",
    })
    return result


def get_gguf_runtime_diagnostics(*, force: bool = False) -> dict[str, Any]:
    global _CACHE
    with _CACHE_LOCK:
        if _CACHE is None or force:
            _CACHE = _run_probe()
            _CACHE["actions"] = _runtime_actions(_CACHE)
            _CACHE["onboarding"] = _runtime_onboarding(_CACHE)
        return copy.deepcopy(_CACHE)


def cached_gguf_runtime_diagnostics() -> dict[str, Any] | None:
    with _CACHE_LOCK:
        return copy.deepcopy(_CACHE)
