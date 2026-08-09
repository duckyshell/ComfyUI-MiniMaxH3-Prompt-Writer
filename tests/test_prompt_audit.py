import unittest

from backend.prompt_audit import audit_prompt


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


if __name__ == "__main__":
    unittest.main()
