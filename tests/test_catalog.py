import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


sys.modules.setdefault(
    "folder_paths",
    types.SimpleNamespace(get_folder_paths=lambda _name: []),
)

from backend import catalog  # noqa: E402
from backend.catalog import model_setup_catalog  # noqa: E402


class ModelSetupCatalogTests(unittest.TestCase):
    def test_every_recommended_model_has_an_exact_model_and_projector_link(self):
        entries = model_setup_catalog()

        self.assertEqual([entry["vram_gb"] for entry in entries], [8, 12, 16, 24, 32])
        for entry in entries:
            self.assertTrue(entry["model_file"].endswith(".gguf"))
            self.assertIn("mmproj", entry["projector_file"].lower())
            self.assertTrue(entry["source_label"].startswith("Hugging Face · unsloth/"))
            self.assertIn("/blob/", entry["model_url"])
            self.assertIn("/blob/", entry["projector_url"])
            self.assertNotIn("download=true", entry["model_url"])
            self.assertNotIn("download=true", entry["projector_url"])
            self.assertIn(entry["model_file"], entry["model_url"])
            self.assertIn(entry["projector_file"], entry["projector_url"])


class ModelDiscoveryTests(unittest.TestCase):
    def discover(self, root: Path):
        with (
            patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root)]),
            patch.object(catalog.importlib.util, "find_spec", return_value=object()),
        ):
            return catalog.discover_models()

    def discover_with_diagnostics(self, roots: list[Path]):
        with (
            patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root) for root in roots]),
            patch.object(catalog.importlib.util, "find_spec", return_value=object()),
        ):
            return catalog.discover_models_with_diagnostics()

    def find(self, root: Path, model_path: Path):
        with (
            patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root)]),
            patch.object(catalog.importlib.util, "find_spec", return_value=object()),
        ):
            return catalog.find_model(str(model_path.resolve()))

    def test_single_flat_pair_is_paired_automatically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gemma-4-test-Q4.gguf").touch()
            projector = root / "mmproj-BF16.gguf"
            projector.touch()

            models = self.discover(root)

            self.assertEqual(len(models), 1)
            self.assertEqual(models[0]["projector"], str(projector.resolve()))
            self.assertTrue(models[0]["runtime_ready"])
            self.assertIsNone(models[0]["setup_message"])

    def test_multiple_flat_pairs_are_not_guessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gemma-4-a.gguf").touch()
            (root / "gemma-4-b.gguf").touch()
            (root / "mmproj-a.gguf").touch()
            (root / "mmproj-b.gguf").touch()

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
            (root / "gemma-4-test.gguf").touch()
            (root / "mmproj-BF16.gguf").touch()
            (root / "mmproj-F16.gguf").touch()

            model = self.discover(root)[0]

        self.assertIsNone(model["projector"])
        self.assertTrue(model["runtime_ready"])
        self.assertEqual(model["vision_status"], "ambiguous")
        self.assertIn("separate subfolder", model["capability_message"])

    def test_separate_subfolders_pair_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("a", "b"):
                folder = root / name
                folder.mkdir()
                (folder / f"gemma-4-{name}.gguf").touch()
                (folder / "mmproj-BF16.gguf").touch()

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
            model_path.touch()

            models, diagnostics = self.discover_with_diagnostics([root])

            self.assertEqual(len(models), 1)
            self.assertEqual(diagnostics["roots"][0]["model_files"], [str(model_path.resolve())])
            self.assertEqual(diagnostics["roots"][0]["projector_files"], [])
            self.assertIn("no mmproj GGUF", diagnostics["roots"][0]["issues"][0])
            self.assertTrue(models[0]["runtime_ready"])
            self.assertEqual(models[0]["vision_status"], "projector_missing")
            self.assertEqual(models[0]["capabilities"], {"images": False, "video_frames": False, "audio": False})
            self.assertEqual(diagnostics["totals"]["incomplete_models"], 0)

    def test_missing_runtime_still_blocks_text_only_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gemma-4-test.gguf").touch()

            with (
                patch.object(catalog.folder_paths, "get_folder_paths", return_value=[str(root)]),
                patch.object(catalog.importlib.util, "find_spec", return_value=None),
            ):
                model = catalog.discover_models()[0]

            self.assertFalse(model["runtime_ready"])
            self.assertEqual(model["missing_dependencies"], ["llama-cpp-python"])
            self.assertEqual(model["vision_status"], "projector_missing")

    def test_discovery_summary_preserves_ready_pairing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gemma-4-test.gguf").touch()
            (root / "mmproj-BF16.gguf").touch()

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
            model_path.touch()
            projector.touch()

            with patch.object(catalog.Path, "rglob", side_effect=AssertionError("recursive discovery was used")):
                model = self.find(root, model_path)

            self.assertEqual(model["id"], str(model_path.resolve()))
            self.assertEqual(model["projector"], str(projector.resolve()))

    def test_find_model_cache_invalidates_when_sibling_gguf_files_change(self):
        catalog._find_model_in_directory.cache_clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_path = root / "gemma-4-test.gguf"
            model_path.touch()

            first = self.find(root, model_path)
            second = self.find(root, model_path)
            cache_after_repeat = catalog._find_model_in_directory.cache_info()
            projector = root / "mmproj-BF16.gguf"
            projector.touch()
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
            model_path.touch()

            self.assertIsNone(self.find(root, model_path))


if __name__ == "__main__":
    unittest.main()
