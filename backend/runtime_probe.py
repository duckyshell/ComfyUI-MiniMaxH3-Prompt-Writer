"""Standalone native llama.cpp backend probe.

This file runs in a child process and never imports the ComfyUI backend, so a
diagnostics request can inspect the native libraries without loading them into
the ComfyUI process. It prints one JSON object on stdout; native loader output
is isolated on stderr and ignored by the caller.
"""

from __future__ import annotations

import ctypes
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


def _empty_result() -> dict:
    return {
        "ok": False,
        "cuda": False,
        "cpu": False,
        "gpu_device": False,
        "device_count": 0,
        "registries": 0,
        "error": None,
    }


def _collect() -> dict:
    result = _empty_result()
    import llama_cpp.llama_cpp as llama_cpp_lib
    from llama_cpp import _ggml

    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        llama_cpp_lib.llama_backend_init()
        lib_dir = Path(llama_cpp_lib.__file__).resolve().parent / "lib"
        _ggml.ggml_backend_load_all_from_path(ctypes.c_char_p(str(lib_dir).encode("utf-8")))
        result["registries"] = int(_ggml.ggml_backend_reg_count())
        result["cuda"] = bool(_ggml.ggml_backend_reg_by_name(b"CUDA"))
        result["cpu"] = bool(_ggml.ggml_backend_reg_by_name(b"CPU"))
        result["device_count"] = int(_ggml.ggml_backend_dev_count())
        device_type = getattr(_ggml, "GGMLBackendDevType", None)
        gpu_type = getattr(device_type, "GGML_BACKEND_DEVICE_TYPE_GPU", 1)
        result["gpu_device"] = bool(_ggml.ggml_backend_dev_by_type(int(gpu_type)))
    result["ok"] = True
    return result


def main() -> int:
    try:
        result = _collect()
    except BaseException as error:
        result = _empty_result()
        result["error"] = f"{type(error).__name__}: {error}"
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
