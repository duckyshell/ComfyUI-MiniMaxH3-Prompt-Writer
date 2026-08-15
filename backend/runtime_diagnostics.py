from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any


PROBE_MARKER = "__H3PS_RUNTIME_DIAGNOSTICS__="
PROBE_TIMEOUT_SECONDS = 12
TESTED_WINDOWS_CUDA13_INSTALL_COMMAND = (
    '.\\python_embeded\\python.exe -m pip install --only-binary=:all: '
    '--extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 '
    '"llama-cpp-python>=0.3.34,<0.4"'
)
_CACHE: dict[str, Any] | None = None
_CACHE_LOCK = threading.Lock()

_CHILD_PROBE = f"""
import importlib.metadata
import json
import platform
import re

result = {{
    "status": "unavailable",
    "python": platform.python_version(),
    "platform": platform.platform(),
    "package_version": None,
    "gpu_offload": None,
    "system_info": None,
}}
try:
    result["package_version"] = importlib.metadata.version("llama-cpp-python")
    version = tuple(int(part) for part in re.findall(r"\\d+", result["package_version"])[:3])
    if version < (0, 3, 34) or version >= (0, 4, 0):
        raise RuntimeError("llama-cpp-python 0.3.34 or newer from the 0.3.x series is required")
    from llama_cpp import Llama, LogitsProcessorList
    try:
        from llama_cpp import GGML_TYPE_F16, GGML_TYPE_Q8_0
    except ImportError:
        from llama_cpp._ggml import GGMLType
        GGML_TYPE_F16 = GGMLType.GGML_TYPE_F16.value
        GGML_TYPE_Q8_0 = GGMLType.GGML_TYPE_Q8_0.value
    from llama_cpp.llama_chat_format import Gemma4ChatHandler
    from llama_cpp import llama_cpp as native
    result["gpu_offload"] = bool(native.llama_supports_gpu_offload())
    result["system_info"] = native.llama_print_system_info().decode("utf-8", "replace")
    result["status"] = "ok"
except Exception as error:
    result["error_type"] = type(error).__name__
    result["error"] = str(error)
print({PROBE_MARKER!r} + json.dumps(result, ensure_ascii=False))
"""


def _backend_from_system_info(system_info: str | None) -> str | None:
    value = system_info or ""
    patterns = (
        ("CUDA", r"(?:^|\|)\s*CUDA\s*:"),
        ("ROCm", r"(?:^|\|)\s*(?:ROCM|HIP)\s*:|HIPBLAS"),
        ("Vulkan", r"(?:^|\|)\s*VULKAN\s*:"),
    )
    for label, pattern in patterns:
        if re.search(pattern, value, flags=re.IGNORECASE):
            return label
    return None


def _configured_runtime_paths() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name in ("CUDA_PATH", "HIP_PATH"):
        value = os.environ.get(name)
        if not value:
            continue
        root = Path(value)
        result[name] = {
            "path": value,
            "exists": root.exists(),
            "bin_exists": (root / "bin").is_dir(),
            "lib_exists": (root / "lib").is_dir(),
        }
    return result


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


def _environment_warnings(paths: dict[str, dict[str, Any]], accelerator: dict[str, Any] | None) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    for name, details in paths.items():
        if details["exists"] and details["bin_exists"] and details["lib_exists"]:
            continue
        if name == "HIP_PATH" and accelerator and "nvidia" in str(accelerator.get("name", "")).lower():
            message = (
                "HIP_PATH points to an incomplete or missing AMD ROCm installation while ComfyUI reports an NVIDIA GPU. "
                "The installed native runtime or environment is likely misconfigured."
            )
        else:
            message = f"{name} points to an incomplete or missing runtime directory."
        warnings.append({"code": f"INVALID_{name}", "message": message})
    return warnings


def _is_tested_windows_cuda13_environment(accelerator: dict[str, Any] | None) -> bool:
    executable_parent = Path(sys.executable).parent.name.lower()
    cuda_version = str((accelerator or {}).get("cuda_version") or "")
    return sys.platform == "win32" and executable_parent == "python_embeded" and cuda_version.startswith("13.")


def _runtime_onboarding(diagnostics: dict[str, Any]) -> dict[str, Any]:
    error_type = str(diagnostics.get("error_type") or "")
    error_text = str(diagnostics.get("error") or "")
    package_missing = (
        diagnostics.get("status") == "unavailable"
        and diagnostics.get("package_version") is None
        and (error_type == "PackageNotFoundError" or "No package metadata was found" in error_text)
    )
    if package_missing:
        tested_environment = _is_tested_windows_cuda13_environment(diagnostics.get("accelerator"))
        return {
            "state": "missing",
            "tested_environment": tested_environment,
            "install_command": TESTED_WINDOWS_CUDA13_INSTALL_COMMAND if tested_environment else None,
        }
    if diagnostics.get("status") == "ok" and diagnostics.get("gpu_offload") is True:
        return {"state": "ready", "tested_environment": False, "install_command": None}
    return {"state": "broken", "tested_environment": False, "install_command": None}


def _child_payload(stdout: str) -> dict[str, Any] | None:
    for line in reversed(stdout.splitlines()):
        if not line.startswith(PROBE_MARKER):
            continue
        try:
            value = json.loads(line[len(PROBE_MARKER):])
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) else None
    return None


def _return_code_hex(return_code: int) -> str:
    return f"0x{return_code & 0xFFFFFFFF:08X}"


def _text_tail(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    return (value or "")[-4000:]


def _run_probe() -> dict[str, Any]:
    paths = _configured_runtime_paths()
    accelerator = _host_accelerator()
    warnings = _environment_warnings(paths, accelerator)
    try:
        completed = subprocess.run(
            [sys.executable, "-c", _CHILD_PROBE],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_SECONDS,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as error:
        return {
            "status": "timeout",
            "message": "The native runtime compatibility check timed out.",
            "gpu_offload": None,
            "backend": None,
            "environment": paths,
            "accelerator": accelerator,
            "warnings": warnings,
            "stdout": _text_tail(error.stdout),
            "stderr": _text_tail(error.stderr),
        }

    if completed.returncode != 0:
        return {
            "status": "crashed",
            "message": "The native runtime crashed during the isolated compatibility check.",
            "return_code": completed.returncode,
            "return_code_hex": _return_code_hex(completed.returncode),
            "gpu_offload": None,
            "backend": None,
            "environment": paths,
            "accelerator": accelerator,
            "warnings": warnings,
            "stdout": completed.stdout[-4000:],
            "stderr": completed.stderr[-4000:],
        }

    payload = _child_payload(completed.stdout)
    if payload is None:
        return {
            "status": "invalid_response",
            "message": "The native runtime compatibility check returned no readable result.",
            "gpu_offload": None,
            "backend": None,
            "environment": paths,
            "accelerator": accelerator,
            "warnings": warnings,
            "stdout": completed.stdout[-4000:],
            "stderr": completed.stderr[-4000:],
        }

    payload.update({
        "backend": _backend_from_system_info(payload.get("system_info")),
        "environment": paths,
        "accelerator": accelerator,
        "warnings": warnings,
    })
    if payload.get("status") == "ok":
        payload["message"] = "The native runtime compatibility check completed."
    else:
        payload["message"] = warnings[0]["message"] if warnings else "The llama-cpp-python runtime could not be imported."
    if completed.stderr:
        payload["stderr"] = completed.stderr[-4000:]
    return payload


def get_gguf_runtime_diagnostics(*, force: bool = False) -> dict[str, Any]:
    global _CACHE
    with _CACHE_LOCK:
        if _CACHE is None or force:
            _CACHE = _run_probe()
            _CACHE["onboarding"] = _runtime_onboarding(_CACHE)
        return copy.deepcopy(_CACHE)


def cached_gguf_runtime_diagnostics() -> dict[str, Any] | None:
    with _CACHE_LOCK:
        return copy.deepcopy(_CACHE)
