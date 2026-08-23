import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


sys.modules.setdefault(
    "folder_paths",
    types.SimpleNamespace(
        get_folder_paths=lambda _name: [],
        get_temp_directory=lambda: tempfile.gettempdir(),
    ),
)

from backend import catalog  # noqa: E402
from backend.catalog import model_setup_catalog  # noqa: E402
from tests.test_gguf_metadata import TYPE_BOOL, TYPE_STRING, TYPE_UINT32, write_gguf  # noqa: E402


def write_model(
    path: Path,
    *,
    architecture: str = "gemma4",
    dimension: int = 3_840,
    name: str = "Gemma test",
    reasoning_effort: bool = False,
    thinking_control: bool = True,
    context_length: int = 262_144,
) -> None:
    template = "{% if enable_thinking %}thinking{% endif %}" if thinking_control else "{{ messages }}"
    if reasoning_effort:
        template += "{{ reasoning_effort }}"
    write_gguf(path, [
        ("general.architecture", TYPE_STRING, architecture),
        ("general.name", TYPE_STRING, name),
        (f"{architecture}.context_length", TYPE_UINT32, context_length),
        (f"{architecture}.embedding_length", TYPE_UINT32, dimension),
        ("tokenizer.chat_template", TYPE_STRING, template),
    ])


def write_projector(
    path: Path,
    *,
    projector_type: str = "gemma4uv",
    dimension: int = 3_840,
) -> None:
    write_gguf(path, [
        ("general.architecture", TYPE_STRING, "clip"),
        ("clip.has_vision_encoder", TYPE_BOOL, True),
        ("clip.vision.projector_type", TYPE_STRING, projector_type),
        ("clip.vision.projection_dim", TYPE_UINT32, dimension),
    ])


class ModelSetupCatalogTests(unittest.TestCase):
    def test_every_recommended_model_has_an_exact_model_and_projector_link(self):
        entries = model_setup_catalog()

        self.assertEqual([entry["vram_gb"] for entry in entries], [8, 12, 16, 24, 32, None, None])
        for entry in entries:
            self.assertTrue(entry["model_file"].endswith(".gguf"))
            self.assertIn("mmproj", entry["projector_file"].lower())
            self.assertTrue(entry["source_label"].startswith("Hugging Face · "))
            self.assertIn("/blob/", entry["model_url"])
            self.assertIn("/blob/", entry["projector_url"])
            self.assertNotIn("download=true", entry["model_url"])
            self.assertNotIn("download=true", entry["projector_url"])
            self.assertIn(entry["model_file"], entry["model_url"])
            self.assertIn(entry["projector_file"], entry["projector_url"])

        by_id = {entry["id"]: entry for entry in entries}
        self.assertEqual(by_id["qwen3.8-27b-ud-q4-k-xl-gguf"]["model_file"], "Qwen3.8-27B-UD-Q4_K_XL.gguf")
        self.assertEqual(by_id["qwen3.8-27b-ud-q4-k-xl-gguf"]["minimum_runtime"], "0.3.35")
        self.assertEqual(by_id["qwen3-vl-8b-instruct-q4-k-m-gguf"]["projector_file"], "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf")


class ModelDiscoveryTests(unittest.TestCase):
    def discover(self, root: Path):
        with (
            patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root)]),
            patch.object(catalog.importlib.util, "find_spec", return_value=object()),
            patch.object(catalog, "_runtime_version", return_value="0.3.35"),
        ):
            return catalog.discover_models()

    def discover_with_diagnostics(self, roots: list[Path]):
        with (
            patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root) for root in roots]),
            patch.object(catalog.importlib.util, "find_spec", return_value=object()),
            patch.object(catalog, "_runtime_version", return_value="0.3.35"),
        ):
            return catalog.discover_models_with_diagnostics()

    def find(self, root: Path, model_path: Path):
        with (
            patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root)]),
            patch.object(catalog.importlib.util, "find_spec", return_value=object()),
            patch.object(catalog, "_runtime_version", return_value="0.3.35"),
        ):
            return catalog.find_model(str(model_path.resolve()))

    def test_single_flat_pair_is_paired_automatically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(root / "gemma-4-test-Q4.gguf")
            projector = root / "mmproj-BF16.gguf"
            write_projector(projector)

            models = self.discover(root)

            self.assertEqual(len(models), 1)
            self.assertEqual(models[0]["projector"], str(projector.resolve()))
            self.assertTrue(models[0]["runtime_ready"])
            self.assertIsNone(models[0]["setup_message"])

    def test_multiple_flat_pairs_are_not_guessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(root / "gemma-4-a.gguf")
            write_model(root / "gemma-4-b.gguf")
            write_projector(root / "mmproj-a.gguf")
            write_projector(root / "mmproj-b.gguf")

            models = self.discover(root)

            self.assertEqual(len(models), 2)
            self.assertTrue(all(model["projector"] is None for model in models))
            self.assertTrue(all(model["runtime_ready"] for model in models))
            self.assertTrue(all(model["vision_status"] == "ambiguous" for model in models))
            self.assertTrue(all(model["capabilities"]["images"] is False for model in models))
            self.assertTrue(all("separate subfolder" in model["capability_message"] for model in models))

    def test_multiple_projectors_next_to_one_model_are_not_guessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(root / "gemma-4-test.gguf")
            write_projector(root / "mmproj-BF16.gguf")
            write_projector(root / "mmproj-F16.gguf")

            model = self.discover(root)[0]

        self.assertIsNone(model["projector"])
        self.assertTrue(model["runtime_ready"])
        self.assertEqual(model["vision_status"], "ambiguous")
        self.assertIn("Keep only the intended projector", model["capability_message"])

    def test_separate_subfolders_pair_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("a", "b"):
                folder = root / name
                folder.mkdir()
                write_model(folder / f"gemma-4-{name}.gguf")
                write_projector(folder / "mmproj-BF16.gguf")

            models = self.discover(root)

            self.assertEqual(len(models), 2)
            self.assertTrue(all(model["runtime_ready"] for model in models))
            self.assertTrue(all(Path(model["projector"]).parent == Path(model["path"]).parent for model in models))

    def test_discovery_reports_actual_roots_and_missing_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory)
            missing = existing / "missing"

            models, diagnostics = self.discover_with_diagnostics([existing, missing])

            self.assertEqual(models, [])
            self.assertEqual([root["path"] for root in diagnostics["roots"]], [str(existing), str(missing)])
            self.assertEqual(diagnostics["roots"][0]["issues"], ["No GGUF model or mmproj files were found."])
            self.assertEqual(diagnostics["roots"][1]["issues"], ["Directory does not exist."])

    def test_discovery_reports_files_and_missing_projector_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_path = root / "gemma-4-test.gguf"
            write_model(model_path)

            models, diagnostics = self.discover_with_diagnostics([root])

            self.assertEqual(len(models), 1)
            self.assertEqual(diagnostics["roots"][0]["model_files"], [str(model_path.resolve())])
            self.assertEqual(diagnostics["roots"][0]["projector_files"], [])
            self.assertIn("No mmproj GGUF", diagnostics["roots"][0]["issues"][0])
            self.assertTrue(models[0]["runtime_ready"])
            self.assertEqual(models[0]["vision_status"], "missing")
            self.assertEqual(models[0]["capabilities"], {"images": False, "video_frames": False, "audio": False})
            self.assertEqual(diagnostics["totals"]["incomplete_models"], 0)

    def test_missing_runtime_still_blocks_text_only_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(root / "gemma-4-test.gguf")

            with (
                patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root)]),
                patch.object(catalog.importlib.util, "find_spec", return_value=None),
            ):
                model = catalog.discover_models()[0]

            self.assertFalse(model["runtime_ready"])
            self.assertEqual(model["missing_dependencies"], ["llama-cpp-python"])
            self.assertEqual(model["vision_status"], "missing")

    def test_qwen_architecture_is_detected_independently_from_lineage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(
                root / "renamed-custom.gguf",
                architecture="qwen35",
                dimension=5_120,
                name="Custom fine-tune",
            )
            write_projector(
                root / "mmproj.gguf",
                projector_type="qwen3vl_merger",
                dimension=5_120,
            )

            model = self.discover(root)[0]

        self.assertEqual(model["name"], "renamed-custom")
        self.assertEqual(model["metadata_name"], "Custom fine-tune")
        self.assertEqual(model["architecture"], "qwen35")
        self.assertEqual(model["architecture_adapter"], "qwen35")
        self.assertTrue(model["architecture_recognized"])
        self.assertTrue(model["runtime_supported"])
        self.assertTrue(model["runtime_ready"])
        self.assertEqual(model["vision_status"], "compatible")
        self.assertTrue(model["detected_capabilities"]["thinking"])
        self.assertFalse(model["detected_capabilities"]["reasoning_effort"])
        self.assertFalse(model["configuration_verified"])
        self.assertEqual(model["verification_status"], "compatible_unverified")
        self.assertIsNone(model["model_policy"])
        self.assertFalse(model["model_policy_supported"])

    def test_unknown_architecture_is_discoverable_but_not_runtime_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(root / "future.gguf", architecture="future_arch")

            model = self.discover(root)[0]

        self.assertEqual(model["discovery_status"], "found")
        self.assertEqual(model["metadata_status"], "readable")
        self.assertFalse(model["architecture_recognized"])
        self.assertFalse(model["runtime_supported"])
        self.assertFalse(model["runtime_ready"])
        self.assertEqual(model["verification_status"], "unsupported")
        self.assertIn("supported GGUF architecture", model["missing_dependencies"])

    def test_qwen_adapter_requires_the_validated_runtime_floor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(root / "qwen.gguf", architecture="qwen35", dimension=5_120)

            with (
                patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root)]),
                patch.object(catalog.importlib.util, "find_spec", return_value=object()),
                patch.object(catalog, "_runtime_version", return_value="0.3.34"),
            ):
                model = catalog.discover_models()[0]

        self.assertTrue(model["architecture_recognized"])
        self.assertFalse(model["runtime_supported"])
        self.assertFalse(model["runtime_ready"])
        self.assertIn("llama-cpp-python>=0.3.35 for qwen35", model["missing_dependencies"])

    def test_qwen_context_choices_are_capped_by_declared_native_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(
                root / "qwen.gguf",
                architecture="qwen35",
                dimension=5_120,
                context_length=32_768,
            )

            model = self.discover(root)[0]

        self.assertEqual(model["native_context_tokens"], 32_768)
        self.assertEqual(model["context_profiles"], ["standard", "extended", "large"])

    def test_live_spiked_qwen38_configuration_has_known_policy_and_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(
                root / "Qwen3.8-27B-UD-Q4_K_XL.gguf",
                architecture="qwen35",
                dimension=5_120,
                name="Qwen3.8-27B",
                reasoning_effort=True,
            )

            model = self.discover(root)[0]

        self.assertEqual(model["model_policy"], "qwen38-27b")
        self.assertTrue(model["model_policy_supported"])
        self.assertTrue(model["configuration_verified"])
        self.assertEqual(model["verification_status"], "verified")
        self.assertTrue(model["template_controls"]["reasoning_effort"])

    def test_verified_qwen_filename_does_not_override_custom_metadata_lineage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(
                root / "Qwen3.8-27B-UD-Q4_K_XL.gguf",
                architecture="qwen35",
                dimension=5_120,
                name="Custom Qwen fine-tune",
                reasoning_effort=True,
            )

            model = self.discover(root)[0]

        self.assertIsNone(model["model_policy"])
        self.assertFalse(model["configuration_verified"])
        self.assertEqual(model["verification_status"], "compatible_unverified")

    def test_live_spiked_qwen3vl_pair_is_verified_without_a_model_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(
                root / "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
                architecture="qwen3vl",
                dimension=4_096,
                name="Qwen3Vl 8b Instruct",
                thinking_control=False,
            )
            write_projector(
                root / "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
                projector_type="qwen3vl_merger",
                dimension=4_096,
            )

            model = self.discover(root)[0]

        self.assertEqual(model["architecture_adapter"], "qwen3vl")
        self.assertEqual(model["name"], "Qwen3-VL 8B Instruct Q4_K_M")
        self.assertTrue(model["runtime_ready"])
        self.assertTrue(model["configuration_verified"])
        self.assertEqual(model["verification_status"], "verified")
        self.assertTrue(model["verified_capabilities"]["vision"])
        self.assertIsNone(model["model_policy"])
        self.assertFalse(model["thinking"])
        self.assertFalse(model["detected_capabilities"]["reasoning_effort"])

    def test_qwen3vlmoe_is_recognized_but_remains_custom_unverified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(
                root / "custom-qwen3vlmoe.gguf",
                architecture="qwen3vlmoe",
                dimension=4_096,
                name="Custom Qwen3-VL MoE",
                thinking_control=False,
            )
            write_projector(
                root / "mmproj.gguf",
                projector_type="qwen3vl_merger",
                dimension=4_096,
            )

            model = self.discover(root)[0]

        self.assertEqual(model["architecture_adapter"], "qwen3vlmoe")
        self.assertTrue(model["architecture_recognized"])
        self.assertTrue(model["runtime_supported"])
        self.assertTrue(model["runtime_ready"])
        self.assertEqual(model["vision_status"], "compatible")
        self.assertFalse(model["configuration_verified"])
        self.assertEqual(model["verification_status"], "compatible_unverified")
        self.assertIsNone(model["model_policy"])

    def test_incompatible_qwen_projector_disables_vision_without_blocking_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(root / "qwen.gguf", architecture="qwen35", dimension=5_120)
            write_projector(root / "mmproj.gguf", projector_type="qwen3vl_merger", dimension=2_048)

            model = self.discover(root)[0]

        self.assertTrue(model["runtime_ready"])
        self.assertEqual(model["vision_status"], "incompatible")
        self.assertIsNone(model["projector"])
        self.assertFalse(model["capabilities"]["images"])

    def test_invalid_header_is_discoverable_but_not_runtime_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "broken.gguf").write_bytes(b"not a gguf")

            model = self.discover(root)[0]

        self.assertEqual(model["metadata_status"], "invalid")
        self.assertFalse(model["runtime_ready"])
        self.assertIn("readable GGUF metadata", model["missing_dependencies"])

    def test_discovery_summary_preserves_ready_pairing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_model(root / "gemma-4-test.gguf")
            write_projector(root / "mmproj-BF16.gguf")

            models, diagnostics = self.discover_with_diagnostics([root])

            self.assertTrue(models[0]["runtime_ready"])
            self.assertEqual(diagnostics["totals"], {
                "models": 1,
                "projectors": 1,
                "ready_models": 1,
                "incomplete_models": 0,
            })

    def test_find_model_uses_only_the_selected_models_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_path = root / "gemma-4-test.gguf"
            projector = root / "mmproj-BF16.gguf"
            write_model(model_path)
            write_projector(projector)

            with patch.object(catalog.Path, "rglob", side_effect=AssertionError("recursive discovery was used")):
                model = self.find(root, model_path)

            self.assertEqual(model["id"], str(model_path.resolve()))
            self.assertEqual(model["projector"], str(projector.resolve()))

    def test_find_model_cache_invalidates_when_sibling_gguf_files_change(self):
        catalog._find_model_in_directory.cache_clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_path = root / "gemma-4-test.gguf"
            write_model(model_path)

            first = self.find(root, model_path)
            second = self.find(root, model_path)
            cache_after_repeat = catalog._find_model_in_directory.cache_info()
            projector = root / "mmproj-BF16.gguf"
            write_projector(projector)
            after_projector = self.find(root, model_path)
            cache_after_change = catalog._find_model_in_directory.cache_info()

            self.assertIsNone(first["projector"])
            self.assertIsNone(second["projector"])
            self.assertGreaterEqual(cache_after_repeat.hits, 1)
            self.assertEqual(after_projector["projector"], str(projector.resolve()))
            self.assertGreater(cache_after_change.misses, cache_after_repeat.misses)

    def test_find_model_rejects_a_gguf_outside_configured_roots(self):
        with tempfile.TemporaryDirectory() as root_directory, tempfile.TemporaryDirectory() as other_directory:
            root = Path(root_directory)
            model_path = Path(other_directory) / "gemma-4-test.gguf"
            write_model(model_path)

            self.assertIsNone(self.find(root, model_path))


if __name__ == "__main__":
    unittest.main()
