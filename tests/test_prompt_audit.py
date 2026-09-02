import unittest

from backend.h3_pipeline import _audit, validate_media_capabilities
from backend.prompt_audit import audit_prompt
from backend.models.contract import ModelError
from backend.prompt_repair import continuum_chunk_repair_messages


def reference_prompt(word_count: int, *, include_soundscape: bool = True) -> str:
    detailed = " ".join(["visible"] * word_count)
    soundscape = "overall_soundscape:\nN/A\n\n" if include_soundscape else ""
    return (
        "subject_definitions:\n<Subject 1> comes from <Picture 1>.\n\n"
        "summary:\n[reference generation] A restrained shot.\n\n"
        "retention_analysis:\n<Subject 1>: fully_preserved.\n\n"
        f"detailed_description:\n[Shot 1] {detailed}\n\n"
        f"{soundscape}"
        "non_diegetic_music:\nN/A"
    )


class PromptAuditTests(unittest.TestCase):
    def test_340_words_is_accepted_without_repair(self):
        result = audit_prompt(reference_prompt(340))
        self.assertTrue(result["official_format_pass"])
        self.assertFalse(result["generation_word_target_met"])
        self.assertEqual(result["detailed_description_length_status"], "acceptable_below_target")
        self.assertFalse(result["repair_required"])

    def test_250_to_299_words_is_internal_warning_only(self):
        result = audit_prompt(reference_prompt(270))
        self.assertEqual(result["detailed_description_length_status"], "short_internal_warning")
        self.assertFalse(result["repair_required"])

    def test_under_250_words_is_a_quality_warning_not_a_repair(self):
        result = audit_prompt(reference_prompt(249))
        self.assertEqual(result["detailed_description_length_status"], "severely_short_internal_warning")
        self.assertIn("severely short detailed_description", result["quality_warnings"])
        self.assertFalse(result["repair_required"])

    def test_missing_section_requires_repair_regardless_of_length(self):
        result = audit_prompt(reference_prompt(360, include_soundscape=False))
        self.assertIn("overall_soundscape", result["missing_sections"])
        self.assertFalse(result["structure_pass"])
        self.assertTrue(result["repair_required"])

    def test_malformed_timestamp_requires_repair(self):
        prompt = reference_prompt(340).replace("A restrained shot.", "At 00:153, a restrained shot.")
        result = audit_prompt(prompt, duration_seconds=10)
        self.assertEqual(result["invalid_timestamps"], ["00:153"])
        self.assertTrue(result["repair_required"])

    def test_timestamp_beyond_duration_requires_repair(self):
        prompt = reference_prompt(340).replace("A restrained shot.", "At 00:12.000, a restrained shot.")
        result = audit_prompt(prompt, duration_seconds=10)
        self.assertEqual(result["invalid_timestamps"], ["00:12.000"])
        self.assertTrue(result["repair_required"])

    def test_valid_timestamp_is_accepted(self):
        prompt = reference_prompt(340).replace("A restrained shot.", "At 00:03.500, a restrained shot.")
        result = audit_prompt(prompt, duration_seconds=10)
        self.assertEqual(result["invalid_timestamps"], [])
        self.assertFalse(result["repair_required"])

    def test_unrequested_camera_direction_is_not_a_hard_error(self):
        prompt = reference_prompt(340).replace("A restrained shot.", "The shot cuts to a close-up and slowly zooms in.")
        result = audit_prompt(prompt, camera_structure_allowed=False)
        self.assertEqual(result["unsupported_camera_directions"], ["cuts to", "zooms in"])
        self.assertFalse(result["repair_required"])

    def test_requested_camera_direction_is_accepted(self):
        prompt = reference_prompt(340).replace("A restrained shot.", "The shot cuts to a close-up and slowly zooms in.")
        result = audit_prompt(prompt, camera_structure_allowed=True)
        self.assertEqual(result["unsupported_camera_directions"], [])
        self.assertFalse(result["repair_required"])

    def test_internal_video_sheet_language_requires_repair(self):
        prompt = reference_prompt(340).replace(
            "A restrained shot.",
            "Follow the sampled frames and the gesture at the 5.507s mark.",
        )
        result = audit_prompt(prompt)
        self.assertEqual(result["internal_video_representation_terms"], ["sampled frames", "5.507s mark"])
        self.assertTrue(result["repair_required"])

    def test_dialogue_without_speaker_id_requires_repair(self):
        prompt = reference_prompt(340).replace("A restrained shot.", "She says <d>Hello.</d>")
        result = audit_prompt(prompt)
        self.assertTrue(result["missing_dialogue_source"])
        self.assertTrue(result["repair_required"])

    def test_dialogue_with_speaker_id_is_accepted(self):
        prompt = reference_prompt(340).replace("A restrained shot.", "(S1) says <d>Hello.</d>")
        result = audit_prompt(prompt)
        self.assertFalse(result["missing_dialogue_source"])
        self.assertFalse(result["repair_required"])

    def test_missing_task_label_requires_repair(self):
        result = audit_prompt(reference_prompt(340).replace("[reference generation] ", ""))
        self.assertTrue(result["missing_task_label"])
        self.assertTrue(result["repair_required"])

    def test_missing_shot_marker_requires_repair(self):
        result = audit_prompt(reference_prompt(340).replace("[Shot 1] ", ""))
        self.assertTrue(result["missing_shot_marker"])
        self.assertTrue(result["repair_required"])


    def test_text_only_direct_allows_workflow_only_continuum_conditioning(self):
        model = {
            "family": "gguf",
            "capabilities": {"images": False, "video_frames": False},
        }
        assembled = {
            "input": {
                "mode": "FL2VA",
                "generation_target": "continuum",
            },
            "media_inputs": [],
        }
        validate_media_capabilities(model, assembled)

    def test_text_only_direct_rejects_prompt_writer_visual_analysis_for_continuum(self):
        model = {
            "family": "gguf",
            "capabilities": {"images": False, "video_frames": False},
        }
        assembled = {
            "input": {
                "mode": "FL2VA",
                "generation_target": "continuum",
            },
            "media_inputs": [
                {"type": "image", "requires_capability": "images"},
            ],
        }
        with self.assertRaises(ModelError) as raised:
            validate_media_capabilities(model, assembled)
        self.assertEqual(raised.exception.code, "DIRECT_VISION_REQUIRED")

    def test_continuum_planner_internal_t2va_marker_does_not_bypass_visual_requirement(self):
        model = {
            "family": "gguf",
            "capabilities": {"images": False, "video_frames": False},
        }
        assembled = {
            "input": {
                "mode": "T2VA",
                "underlying_mode": "FL2VA",
                "generation_target": "continuum",
            },
            "media_inputs": [
                {"type": "image", "requires_capability": "images"},
            ],
        }
        with self.assertRaises(ModelError) as raised:
            validate_media_capabilities(model, assembled)
        self.assertEqual(raised.exception.code, "DIRECT_VISION_REQUIRED")
        self.assertEqual(raised.exception.details["mode"], "FL2VA")

    def test_continuum_reference_chunk_skips_standalone_reference_structure_audit(self):
        assembled = {
            "input": {
                "mode": "Reference",
                "generation_target": "continuum",
                "continuum_stage": "chunk",
                "continuum_chunk_allowed_references": ["<Picture 1>"],
                "continuum_plan": {
                    "global": {"sequence_preamble": "Keep <Picture 1> identity consistent."}
                },
                "creative_brief": "Keep <Picture 1> consistent.",
                "duration_seconds": 5,
            }
        }
        result, policy, _intent, _duration, _camera = _audit(
            "The subject continues walking while the camera tracks beside them.",
            assembled,
        )
        self.assertIsNone(result["official_format_pass"])
        self.assertEqual(result["reference_understanding"], "continuum_timeline_chunk")
        self.assertNotIn("missing_sections", result)
        self.assertEqual(policy.allowed, {"<Picture 1>"})

    def test_continuum_chunk_repair_contract_preserves_chunk_shape_and_exact_tag_scope(self):
        assembled = {
            "messages": [
                {"role": "system", "content": "Continuum chunk system."},
                {"role": "user", "content": "Write Chunk 2 only."},
            ]
        }
        messages = continuum_chunk_repair_messages(
            assembled,
            "Reset to <Picture 1>.",
            ["unexpected reference tags: <Picture 1>"],
            set(),
            set(),
        )
        system = messages[0]["content"]
        self.assertIn("Continuum Timeline chunk body", system)
        self.assertIn("Do not add a shared preamble, Timeline header", system)
        self.assertIn("standalone I2VA/FL2VA/L2VA alignment line", system)
        self.assertIn("must remain in this chunk body are: none", system)
        self.assertIn("permitted in this chunk are: none", system)
        self.assertIn("Reset to <Picture 1>.", messages[1]["content"])

    def test_continuum_chunk_audit_repairs_standalone_wrapper_or_repeated_preamble(self):
        assembled = {
            "input": {
                "mode": "FL2VA",
                "generation_target": "continuum",
                "continuum_stage": "chunk",
                "continuum_chunk_allowed_references": [],
                "continuum_plan": {
                    "global": {
                        "sequence_preamble": "Stable identity and camera language."
                    }
                },
                "creative_brief": "Continue the same scene.",
                "duration_seconds": 5,
            }
        }
        result, _policy, _intent, _duration, _camera = _audit(
            "Stable identity and camera language.\n\nintegrated_multimodal_description: [Shot 1] Continue.",
            assembled,
        )
        self.assertTrue(result["repair_required"])
        self.assertIn(
            "repeated shared sequence preamble",
            result["format_violations"],
        )
        self.assertTrue(
            any(
                item.startswith("standalone H3 field labels:")
                for item in result["format_violations"]
            )
        )
        self.assertIn(
            "standalone [Shot N] wrapper",
            result["format_violations"],
        )

    def test_continuum_chunk_audit_still_reports_out_of_scope_reference_tags(self):
        assembled = {
            "input": {
                "mode": "Reference",
                "generation_target": "continuum",
                "continuum_stage": "chunk",
                "continuum_chunk_allowed_references": [],
                "continuum_plan": {"global": {"sequence_preamble": "Stable scene."}},
                "creative_brief": "Continue the scene.",
                "duration_seconds": 5,
            }
        }
        result, _policy, _intent, _duration, _camera = _audit(
            "Reset to <Picture 1>.",
            assembled,
        )
        self.assertEqual(result["unexpected_reference_tags"], ["<Picture 1>"])
        self.assertTrue(result["repair_required"])

if __name__ == "__main__":
    unittest.main()
