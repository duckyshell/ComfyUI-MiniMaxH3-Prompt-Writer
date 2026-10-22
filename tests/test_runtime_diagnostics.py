import inspect
import unittest
from unittest.mock import patch

from backend import runtime_diagnostics


NATIVE_CUDA = {
    "ok": True,
    "cuda": True,
    "cpu": True,
    "gpu_device": True,
    "device_count": 2,
    "registries": 2,
    "error": None,
}
NATIVE_CPU = {
    "ok": True,
    "cuda": False,
    "cpu": True,
    "gpu_device": False,
    "device_count": 1,
    "registries": 1,
    "error": None,
}


class RuntimeDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        runtime_diagnostics._CACHE = None

    def probe(self, version: str = "0.3.46", *, module_available: bool = True, native: dict | None = None):
        with (
            patch.object(runtime_diagnostics.importlib.metadata, "version", return_value=version),
            patch.object(runtime_diagnostics, "_module_available", return_value=module_available),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value={"name": "NVIDIA Test"}),
            patch.object(
                runtime_diagnostics,
                "_run_native_probe",
                return_value=(NATIVE_CUDA if native is None else native, None),
            ),
        ):
            return runtime_diagnostics.get_gguf_runtime_diagnostics()

    def test_supported_package_is_ready_without_native_import(self):
        result = self.probe()

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["package_version"], "0.3.46")
        self.assertTrue(result["gpu_offload"])
        self.assertEqual(result["backend"], "CUDA")
        self.assertEqual(result["native"], {
            "registries": 2,
            "device_count": 2,
            "cuda_backend": True,
            "cpu_backend": True,
        })
        self.assertEqual(result["onboarding"]["state"], "ready")
        source = inspect.getsource(runtime_diagnostics)
        self.assertNotIn("from llama_cpp", source)
        self.assertNotIn("import llama_cpp", source)

    def test_cpu_only_native_runtime_reports_no_gpu_offload(self):
        result = self.probe(native=NATIVE_CPU)

        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["gpu_offload"])
        self.assertEqual(result["backend"], "CPU")
        self.assertEqual(result["onboarding"]["state"], "ready")
        self.assertTrue(any("CUDA" in warning for warning in result["warnings"]))

    def test_native_initialization_failure_is_a_broken_runtime(self):
        result = self.probe(native={
            "ok": False,
            "cuda": False,
            "cpu": False,
            "gpu_device": False,
            "device_count": 0,
            "registries": 0,
            "error": "OSError: [WinError 126] The specified module could not be found",
        })

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error_type"], "NativeBackendError")
        self.assertIn("WinError 126", result["error"])
        self.assertIsNone(result["gpu_offload"])
        self.assertEqual(result["onboarding"]["state"], "broken")

    def test_unavailable_probe_subprocess_keeps_runtime_ready_with_warning(self):
        with (
            patch.object(runtime_diagnostics.importlib.metadata, "version", return_value="0.3.46"),
            patch.object(runtime_diagnostics, "_module_available", return_value=True),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=None),
            patch.object(
                runtime_diagnostics,
                "_run_native_probe",
                return_value=(None, "TimeoutExpired: probe timed out"),
            ),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["status"], "ok")
        self.assertIsNone(result["gpu_offload"])
        self.assertIsNone(result["backend"])
        self.assertEqual(result["onboarding"]["state"], "ready")
        self.assertTrue(any("did not complete" in warning for warning in result["warnings"]))

    def test_missing_package_exposes_non_native_missing_state(self):
        with (
            patch.object(
                runtime_diagnostics.importlib.metadata,
                "version",
                side_effect=runtime_diagnostics.importlib.metadata.PackageNotFoundError,
            ),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=None),
            patch.object(runtime_diagnostics, "_is_tested_windows_cuda13_environment", return_value=False),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["package_version"])
        self.assertEqual(result["onboarding"], {
            "state": "missing",
            "tested_environment": False,
            "install_command": None,
        })

    def test_missing_runtime_exposes_tested_cuda13_install_command(self):
        accelerator = {"name": "NVIDIA Test", "cuda_version": "13.0"}
        with (
            patch.object(
                runtime_diagnostics.importlib.metadata,
                "version",
                side_effect=runtime_diagnostics.importlib.metadata.PackageNotFoundError,
            ),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=accelerator),
            patch.object(runtime_diagnostics, "_is_tested_windows_cuda13_environment", return_value=True),
        ):
            result = runtime_diagnostics.get_gguf_runtime_diagnostics()

        self.assertEqual(result["onboarding"], {
            "state": "missing",
            "tested_environment": True,
            "install_command": runtime_diagnostics.TESTED_WINDOWS_CUDA13_INSTALL_COMMAND,
        })
        self.assertTrue(result["onboarding"]["install_command"].startswith(".\\python_embeded\\python.exe"))
        self.assertIn("llama-cpp-python==0.3.35", result["onboarding"]["install_command"])

    def test_ready_tested_runtime_exposes_the_same_safe_upgrade_action(self):
        with patch.object(runtime_diagnostics, "_is_tested_windows_cuda13_environment", return_value=True):
            result = self.probe("0.3.34")

        self.assertEqual(result["onboarding"]["state"], "ready")
        self.assertEqual(result["actions"], {
            "tested_environment": True,
            "install_or_upgrade_command": runtime_diagnostics.TESTED_WINDOWS_CUDA13_INSTALL_COMMAND,
        })

    def test_tested_environment_requires_windows_embedded_python_and_cuda13(self):
        with (
            patch.object(runtime_diagnostics.sys, "platform", "win32"),
            patch.object(
                runtime_diagnostics.sys,
                "executable",
                "C:\\ComfyUI_windows_portable\\python_embeded\\python.exe",
            ),
            patch.object(runtime_diagnostics, "Path") as path_cls,
        ):
            path_cls.return_value.parent.name = "python_embeded"
            self.assertTrue(runtime_diagnostics._is_tested_windows_cuda13_environment({"cuda_version": "13.0"}))
            self.assertFalse(runtime_diagnostics._is_tested_windows_cuda13_environment({"cuda_version": "12.9"}))
            self.assertFalse(runtime_diagnostics._is_tested_windows_cuda13_environment(None))

    def test_unsupported_version_is_a_troubleshooting_state(self):
        result = self.probe("0.4.0")

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error_type"], "RuntimeVersionError")
        self.assertEqual(result["onboarding"]["state"], "broken")

    def test_missing_module_with_package_metadata_is_broken(self):
        result = self.probe(module_available=False)

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error_type"], "ModuleNotFoundError")
        self.assertEqual(result["onboarding"]["state"], "broken")

    def test_probe_is_cached_and_force_refreshes_it(self):
        with (
            patch.object(runtime_diagnostics.importlib.metadata, "version", return_value="0.3.46") as version,
            patch.object(runtime_diagnostics, "_module_available", return_value=True),
            patch.object(runtime_diagnostics, "_host_accelerator", return_value=None),
            patch.object(
                runtime_diagnostics,
                "_run_native_probe",
                return_value=(NATIVE_CUDA, None),
            ) as native_probe,
        ):
            first = runtime_diagnostics.get_gguf_runtime_diagnostics()
            second = runtime_diagnostics.get_gguf_runtime_diagnostics()
            refreshed = runtime_diagnostics.get_gguf_runtime_diagnostics(force=True)

        self.assertEqual(first, second)
        self.assertEqual(second, refreshed)
        self.assertEqual(version.call_count, 2)
        self.assertEqual(native_probe.call_count, 2)


if __name__ == "__main__":
    unittest.main()
