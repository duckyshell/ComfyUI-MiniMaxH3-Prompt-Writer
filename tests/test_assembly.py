import unittest
from unittest.mock import patch

from backend.assembly import AssemblyError, _final_contract, assemble_refinement, assemble_request
from backend.system_prompts import (
    MAX_SYSTEM_PROMPT_CHARS,
    REFERENCE_SYSTEM_WRAPPER,
    SYSTEM_WRAPPER,
    SystemPromptError,
    resolve_system_prompt,
    system_prompt_for_mode,
)


class SystemPromptTests(unittest.TestCase):
    def test_standard_modes_share_one_default(self):
        self.assertEqual(system_prompt_for_mode("T2VA"), SYSTEM_WRAPPER)
        self.assertEqual(system_prompt_for_mode("FL2VA"), SYSTEM_WRAPPER)

    def test_reference_has_its_own_default(self):
        self.assertEqual(system_prompt_for_mode("Reference"), REFERENCE_SYSTEM_WRAPPER)
        self.assertNotEqual(REFERENCE_SYSTEM_WRAPPER, SYSTEM_WRAPPER)
        self.assertIn("transfer only that role", REFERENCE_SYSTEM_WRAPPER)
        self.assertIn("must not contribute its performer identity", REFERENCE_SYSTEM_WRAPPER)
        self.assertIn("never invent or pad details solely", REFERENCE_SYSTEM_WRAPPER)
        self.assertIn("preserve user-supplied dialogue, lyrics, and visible text verbatim", REFERENCE_SYSTEM_WRAPPER)
        self.assertNotIn("never return fewer", REFERENCE_SYSTEM_WRAPPER)
        self.assertNotIn("spins", REFERENCE_SYSTEM_WRAPPER)
        self.assertNotIn("kisses", REFERENCE_SYSTEM_WRAPPER)
        self.assertNotIn("GRWM", REFERENCE_SYSTEM_WRAPPER)
        self.assertIn("unsupported subject actions, expressions, events, transitions", REFERENCE_SYSTEM_WRAPPER)

    def test_custom_prompt_fully_replaces_default(self):
        prompt, custom = resolve_system_prompt("Reference", "  Custom instruction.  ")
        self.assertEqual(prompt, "Custom instruction.")
        self.assertTrue(custom)

    def test_oversized_custom_prompt_is_rejected(self):
        with self.assertRaises(SystemPromptError) as raised:
            resolve_system_prompt("T2VA", "x" * (MAX_SYSTEM_PROMPT_CHARS + 1))
        self.assertEqual(raised.exception.code, "SYSTEM_PROMPT_TOO_LONG")

    def test_reference_contract_bounds_creative_completion(self):
        contract = _final_contract("Reference", "Use Video 1 only for motion. Add some music.")
        self.assertIn("every explicitly assigned reference role as exclusive", contract)
        self.assertIn("are not required", contract)
        self.assertIn("may be designed as new target content", contract)
        self.assertIn("never described as facts derived from a reference", contract)
        self.assertIn("must not create audio-reference or audio-reuse semantics", contract)
        self.assertIn("concrete visible object, character, scene, or effect", contract)
        self.assertIn("through an appropriate <Subject N>", contract)
        self.assertIn("do not automatically create a separate subject for ordinary motion transfer", contract)
        self.assertIn("non_diegetic_music must be N/A", contract)

    def test_standard_contract_does_not_invent_music(self):
        contract = _final_contract("FL2VA", "Transform cocoa into sand with no cut.")
        self.assertIn("does not explicitly request non-diegetic music", contract)
        self.assertIn("N/A for non_diegetic_music", contract)


class AssemblyReferenceManifestTests(unittest.TestCase):
    session_id = "11111111-2222-4333-8444-555555555555"

    @staticmethod
    def manifest(*assets):
        return {
            "session_id": AssemblyReferenceManifestTests.session_id,
            "mode": "Reference",
            "assets": list(assets),
            "counts": {
                kind: len([asset for asset in assets if asset["type"] == kind])
                for kind in ("image", "video", "audio")
            },
            "violations": [],
            "valid": True,
        }

    def body(self, brief="A restrained cinematic shot."):
        return {
            "session_id": self.session_id,
            "mode": "Reference",
            "duration_seconds": 6,
            "aspect_ratio": "16:9",
            "creative_brief": brief,
        }

    def test_missing_canonical_reference_is_rejected_before_inference(self):
        picture = {"id": "p", "type": "image", "filename": "p.png", "reference": "<Picture 1>", "content_url": "/p", "frames": []}
        cases = [
            (self.manifest(), "Use <Picture 1>.", "<Picture 1>"),
            (self.manifest(picture), "Use <Picture 9>.", "<Picture 9>"),
            (self.manifest(picture), "Use <Video 2>.", "<Video 2>"),
        ]
        for manifest, brief, expected in cases:
            with self.subTest(reference=expected), patch("backend.assembly.STORE.manifest", return_value=manifest):
                with self.assertRaises(AssemblyError) as raised:
                    assemble_request(self.body(brief))
                self.assertEqual(raised.exception.code, "REFERENCE_NOT_FOUND")
                self.assertEqual(raised.exception.details, {"reference": expected})
                self.assertEqual(raised.exception.message, f"{expected} doesn't exist. Add the reference or remove it from the Creative Brief.")

    def test_natural_language_reference_mentions_are_not_interpreted_as_tags(self):
        with patch("backend.assembly.STORE.manifest", return_value=self.manifest()):
            assembled = assemble_request(self.body("Use Picture 1, video 2, second video, второе видео, <picture 2>, and < Video 3 > as ideas."))
        self.assertEqual(assembled["media_inputs"], [])

    def test_all_manifest_assets_are_active_but_audio_bytes_are_not_attached(self):
        picture = {"id": "p", "type": "image", "filename": "p.png", "reference": "<Picture 1>", "content_url": "/p", "frames": []}
        video = {"id": "v", "type": "video", "filename": "v.mp4", "reference": "<Video 1>", "content_url": "/v", "frames": []}
        audio = {"id": "a", "type": "audio", "filename": "a.wav", "reference": "<Audio 1>", "content_url": "/a", "frames": []}
        with patch("backend.assembly.STORE.manifest", return_value=self.manifest(picture, video, audio)):
            assembled = assemble_request(self.body("Use <Picture 1>, <Video 1>, and <Audio 1>."))
        self.assertEqual([item["asset_id"] for item in assembled["media_inputs"]], ["p", "v"])
        self.assertEqual([item["reference"] for item in assembled["input"]["media_manifest"]["assets"]], ["<Picture 1>", "<Video 1>", "<Audio 1>"])

        with patch("backend.assembly.STORE.manifest", return_value=self.manifest(picture, video, audio)):
            unmentioned = assemble_request(self.body("A shot whose uploaded references need no explicit enumeration."))
        self.assertEqual([item["asset_id"] for item in unmentioned["media_inputs"]], ["p", "v"])

    def test_refinement_prefers_matching_mode_cache_and_falls_back_to_current_context(self):
        with patch("backend.assembly.STORE.manifest", return_value=self.manifest()):
            cached = assemble_refinement(
                {**self.body("Current brief"), "current_prompt": "Current prompt", "instruction": "Make it slower."},
                {"mode": "Reference", "duration_seconds": 12, "aspect_ratio": "9:16", "creative_brief": "Original brief", "prompt": "First pass"},
            )
            fallback = assemble_refinement(
                {**self.body("Current brief"), "current_prompt": "Current prompt", "instruction": "Make it slower."},
                None,
            )
            wrong_mode_cache = assemble_refinement(
                {**self.body("Current brief"), "current_prompt": "Current prompt", "instruction": "Make it slower."},
                {"mode": "T2VA", "duration_seconds": 19, "aspect_ratio": "1:1", "creative_brief": "Wrong mode", "prompt": "Wrong pass"},
            )
        self.assertEqual((cached["input"]["duration_seconds"], cached["input"]["aspect_ratio"], cached["input"]["creative_brief"]), (12, "9:16", "Original brief"))
        self.assertIn("Cached first-pass observation:\nFirst pass", cached["messages"][-1]["content"])
        self.assertEqual((fallback["input"]["duration_seconds"], fallback["input"]["aspect_ratio"], fallback["input"]["creative_brief"]), (6, "16:9", "Current brief"))
        self.assertEqual((wrong_mode_cache["input"]["duration_seconds"], wrong_mode_cache["input"]["aspect_ratio"], wrong_mode_cache["input"]["creative_brief"]), (6, "16:9", "Current brief"))


if __name__ == "__main__":
    unittest.main()
