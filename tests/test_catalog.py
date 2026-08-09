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
            self.assertTrue(all(not model["runtime_ready"] for model in models))
            self.assertTrue(all("separate subfolder" in model["setup_message"] for model in models))

    def test_multiple_projectors_next_to_one_model_are_not_guessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gemma-4-test.gguf").touch()
            (root / "mmproj-BF16.gguf").touch()
            (root / "mmproj-F16.gguf").touch()

            model = self.discover(root)[0]

            self.assertIsNone(model["projector"])
            self.assertFalse(model["runtime_ready"])
            self.assertIn("separate subfolder", model["setup_message"])

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


if __name__ == "__main__":
    unittest.main()
