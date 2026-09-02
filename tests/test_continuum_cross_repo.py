from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest

from backend.continuum import prompt_hash, resolved_chunk_prompt, serialize_timeline


def _load_continuum_prompts(source_root: Path):
    package_name = "_h3_continuum_contract"
    package = types.ModuleType(package_name)
    package.__path__ = [str(source_root)]
    sys.modules[package_name] = package

    v2_name = f"{package_name}.v2"
    v2_package = types.ModuleType(v2_name)
    v2_package.__path__ = [str(source_root / "v2")]
    sys.modules[v2_name] = v2_package

    for module_name, path in (
        (f"{package_name}.constants", source_root / "constants.py"),
        (f"{package_name}.version", source_root / "version.py"),
        (f"{v2_name}.prompts", source_root / "v2" / "prompts.py"),
    ):
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Could not load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    return sys.modules[f"{v2_name}.prompts"]


@unittest.skipUnless(os.environ.get("H3_CONTINUUM_SOURCE"), "H3_CONTINUUM_SOURCE is required for cross-repo contract CI")
class ContinuumCrossRepositoryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(os.environ["H3_CONTINUUM_SOURCE"]).resolve()
        cls.source_root = root
        cls.prompts = _load_continuum_prompts(root)

    def assert_writer_matches_continuum(self, preamble, bodies, chunk_seconds):
        script = serialize_timeline(preamble, bodies, chunk_seconds)
        plan = self.prompts.make_prompt_plan(
            mode="Timeline",
            script=script,
            chunks=len(bodies),
            chunk_seconds=chunk_seconds,
        )
        expected = [resolved_chunk_prompt(preamble, body) for body in bodies]
        self.assertEqual(plan["mode"], self.prompts.PROMPT_MODE_TIMELINE)
        self.assertNotIn("used Fixed prompt fallback", plan.get("notes", []))
        self.assertEqual(plan["prompts"], expected)
        self.assertEqual(plan["hashes"], [prompt_hash(prompt) for prompt in expected])
        return script, plan

    def test_current_public_sampler_family_matches_frontend_discovery(self):
        constants_source = (self.source_root / "constants.py").read_text(encoding="utf-8")
        base_source = (self.source_root / "v3" / "nodes.py").read_text(encoding="utf-8")
        driving_source = (self.source_root / "v3" / "driving_nodes.py").read_text(encoding="utf-8")
        root_source = (self.source_root / "nodes.py").read_text(encoding="utf-8")

        self.assertIn("CHUNK_SECONDS_MIN = 4.0", constants_source)
        self.assertIn("CHUNK_SECONDS_MAX = 30.0", constants_source)
        self.assertIn('"sequence_prompt": (', base_source)
        self.assertIn('"first_frame": (', base_source)
        self.assertIn('"last_frame": ("IMAGE",)', base_source)
        for index in range(1, 4):
            self.assertIn(f'"reference_image_{index}": ("IMAGE",)', base_source)

        # Official upstream exposes three persistent image-reference sockets.
        # Writer discovery remains tolerant of extension facades with additional
        # sockets, but the reviewed upstream contract itself is exactly 1–3.
        self.assertNotIn("for index in range(4, 9):", driving_source)
        self.assertIn('optional["reference_video_1"] = (', driving_source)
        self.assertIn('optional["driving_audio"] = (', driving_source)
        self.assertIn('optional["reference_audio_1"] = (', driving_source)
        self.assertIn('optional["guide"] = (', driving_source)
        self.assertIn("class H3ContinuumSamplerV35(H3ContinuumSamplerV34)", driving_source)
        self.assertIn("class H3ContinuumSamplerV36(H3ContinuumSamplerV35)", driving_source)
        self.assertIn("class H3ContinuumSamplerV37(H3ContinuumSamplerV36)", driving_source)
        for node_id in (
            "H3ContinuumSamplerV34",
            "H3ContinuumSamplerV35",
            "H3ContinuumSamplerV36",
            "H3ContinuumSamplerV37",
        ):
            self.assertIn(f'"{node_id}"', root_source)

    def test_integer_timeline_preamble_and_hashes_match_real_continuum_parser(self):
        script, plan = self.assert_writer_matches_continuum(
            "Stable subject identity, wardrobe, environment, film treatment, and room tone persist.",
            ["The subject enters frame.", "The subject crosses the room.", "The subject reaches the window."],
            5,
        )
        self.assertIn("[0-5s]\n", script)
        self.assertEqual(len(plan["prompts"]), 3)

    def test_fractional_timeline_boundaries_match_real_continuum_parser(self):
        script, _plan = self.assert_writer_matches_continuum(
            "Global continuity.",
            ["One.", "Two.", "Three."],
            6.5,
        )
        self.assertIn("[0-6.5s]\n", script)
        self.assertIn("[6.5-13s]\n", script)
        self.assertIn("[13-19.5s]\n", script)

    def test_local_body_edit_preserves_real_continuum_prefix_hashes(self):
        preamble = "Persistent identity and camera language."
        bodies = ["One.", "Two.", "Three."]
        _script, before = self.assert_writer_matches_continuum(preamble, bodies, 5)
        changed = list(bodies)
        changed[2] = "Changed three."
        _script, after = self.assert_writer_matches_continuum(preamble, changed, 5)
        self.assertEqual(after["hashes"][:2], before["hashes"][:2])
        self.assertNotEqual(after["hashes"][2], before["hashes"][2])

    def test_preamble_edit_changes_all_real_continuum_hashes(self):
        bodies = ["One.", "Two.", "Three."]
        _script, before = self.assert_writer_matches_continuum("Global A.", bodies, 5)
        _script, after = self.assert_writer_matches_continuum("Global B.", bodies, 5)
        self.assertTrue(all(a != b for a, b in zip(before["hashes"], after["hashes"], strict=True)))


if __name__ == "__main__":
    unittest.main()
