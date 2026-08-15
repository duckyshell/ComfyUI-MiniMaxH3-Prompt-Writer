import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend import runtime_diagnostics


def completed(payload: dict, *, stderr: str = "", returncode: int = 0):
    stdout = runtime_diagnostics.PROBE_MARKER + json.dumps(payload)
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


class RuntimeDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        runtime_diagnostics._CACHE = None

    def test_probe_matches_the_direct_gemma_loader_contract(self):
        self.assertIn("version < (0, 3, 34) or version >= (0, 4, 0)", runtime_diagnostics._CHILD_PROBE)
        self.assertIn("from llama_cpp import Llama, LogitsProcessorList", runtime_diagnostics._CHILD_PROBE)
        self.assertIn("from llama_cpp import GGML_TYPE_F16, GGML_TYPE_Q8_0", runtime_diagnostics._CHILD_PROBE)
        self.assertIn("from llama_cpp._ggml import GGMLType", runtime_diagnostics._CHILD_PROBE)
        self.assertIn("Gemma4ChatHandler", runtime_diagnostics._CHILD_PROBE)

    def test_cuda_is_reported_only_when_system_info_names_it(self):
        payload = {
            "status": "ok",
            "package_version": "0.3.34",
            "python": "3.13.0",
            "platform": "Windows",
            "gpu_offload": True,
            "system_info": "CUDA : ARCHS = 890 | CPU : AVX2 = 1",
        }
        with (
            patch.object(runtime_diagnostics.subprocess, "run", return_value=completed(payload)),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value={"name": "NVIDIA Test"}),
            patch.dict(os.environ, {}, clear=True),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertTrue(result["gpu_offload"])
        self.assertEqual(result["backend"], "CUDA")

    def test_gpu_offload_does_not_invent_a_backend(self):
        payload = {
            "status": "ok",
            "gpu_offload": True,
            "system_info": "CPU : AVX2 = 1",
        }
        with (
            patch.object(runtime_diagnostics.subprocess, "run", return_value=completed(payload)),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=None),
            patch.dict(os.environ, {}, clear=True),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertTrue(result["gpu_offload"])
        self.assertIsNone(result["backend"])

    def test_native_crash_returns_exit_code_without_claiming_a_cause(self):
        crash = SimpleNamespace(stdout="", stderr="fatal native exception", returncode=0xC000001D)
        with (
            patch.object(runtime_diagnostics.subprocess, "run", return_value=crash),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=None),
            patch.dict(os.environ, {}, clear=True),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["status"], "crashed")
        self.assertEqual(result["return_code_hex"], "0xC000001D")
        self.assertNotIn("AVX", result["message"])

    def test_stale_hip_path_on_nvidia_is_reported_as_environment_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            missing_rocm = Path(directory) / "missing-rocm"
            payload = {"status": "unavailable", "gpu_offload": None, "system_info": None, "error": "path not found"}
            with (
                patch.object(runtime_diagnostics.subprocess, "run", return_value=completed(payload)),
                patch.object(runtime_diagnostics, "_host_accelerator", return_value={"name": "NVIDIA GeForce"}),
                patch.dict(os.environ, {"HIP_PATH": str(missing_rocm)}, clear=True),
            ):
                result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["warnings"][0]["code"], "INVALID_HIP_PATH")
        self.assertIn("NVIDIA", result["message"])

    def test_probe_is_cached(self):
        payload = {"status": "ok", "gpu_offload": False, "system_info": "CPU : AVX2 = 1"}
        with (
            patch.object(runtime_diagnostics.subprocess, "run", return_value=completed(payload)) as run,
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=None),
            patch.dict(os.environ, {}, clear=True),
        ):
            first = runtime_diagnostics.get_gguf_runtime_diagnostics()
            second = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(first, second)
        self.assertEqual(first["onboarding"]["state"], "broken")
        run.assert_called_once()

    def test_missing_runtime_exposes_tested_cuda13_install_command(self):
        payload = {
            "status": "unavailable",
            "package_version": None,
            "gpu_offload": None,
            "system_info": None,
            "error_type": "PackageNotFoundError",
            "error": "No package metadata was found for llama-cpp-python",
        }
        with (
            patch.object(runtime_diagnostics.subprocess, "run", return_value=completed(payload)),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value={"name": "NVIDIA Test", "cuda_version": "13.0"}),
            patch.object(runtime_diagnostics, "_is_tested_windows_cuda13_environment", return_value=True),
            patch.dict(os.environ, {}, clear=True),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["onboarding"]["state"], "missing")
        self.assertTrue(result["onboarding"]["install_command"].startswith(".\\python_embeded\\python.exe"))
        self.assertIn("llama-cpp-python>=0.3.34,<0.4", result["onboarding"]["install_command"])

    def test_missing_runtime_does_not_invent_a_command_for_other_environments(self):
        payload = {
            "status": "unavailable",
            "package_version": None,
            "gpu_offload": None,
            "system_info": None,
            "error_type": "PackageNotFoundError",
            "error": "No package metadata was found for llama-cpp-python",
        }
        with (
            patch.object(runtime_diagnostics.subprocess, "run", return_value=completed(payload)),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=None),
            patch.object(runtime_diagnostics, "_is_tested_windows_cuda13_environment", return_value=False),
            patch.dict(os.environ, {}, clear=True),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["onboarding"]["state"], "missing")
        self.assertIsNone(result["onboarding"]["install_command"])

    def test_installed_but_unusable_runtime_is_a_troubleshooting_state(self):
        payload = {
            "status": "unavailable",
            "package_version": "0.3.46",
            "gpu_offload": None,
            "system_info": None,
            "error_type": "ImportError",
            "error": "cannot import name GGML_TYPE_F16",
        }
        with (
            patch.object(runtime_diagnostics.subprocess, "run", return_value=completed(payload)),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value={"name": "NVIDIA Test", "cuda_version": "13.0"}),
            patch.dict(os.environ, {}, clear=True),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["onboarding"]["state"], "broken")
        self.assertIsNone(result["onboarding"]["install_command"])

    def test_timeout_is_nonfatal(self):
        timeout = subprocess.TimeoutExpired(["python"], 12, output=b"partial", stderr=b"waiting")
        with (
            patch.object(runtime_diagnostics.subprocess, "run", side_effect=timeout),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=None),
            patch.dict(os.environ, {}, clear=True),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["status"], "timeout")
        self.assertIsNone(result["gpu_offload"])
        self.assertEqual(result["stdout"], "partial")
        self.assertEqual(result["stderr"], "waiting")


if __name__ == "__main__":
    unittest.main()
