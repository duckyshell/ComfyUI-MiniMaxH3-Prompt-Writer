import unittest

from backend.prompt_repair import (
    audit_failures,
    explicit_constraint_violations,
    multimodal_repair_messages,
    narrow_repair_messages,
    reference_tags,
    unexpected_audio_task,
)


class GGUFRepairTests(unittest.TestCase):
    def test_reference_tags_are_normalized(self):
        self.assertEqual(
            reference_tags("Use <picture 1>, <Video 2>, and <AUDIO 3>."),
            {"<Picture 1>", "<Video 2>", "<Audio 3>"},
        )

    def test_audio_task_without_audio_asset_is_hard_error(self):
        expected = {"<Picture 1>", "<Video 1>"}
        self.assertTrue(unexpected_audio_task("reference generation + audio reference", expected))
        self.assertFalse(unexpected_audio_task("reference generation", expected))
        self.assertFalse(unexpected_audio_task("reference generation + audio reference", expected | {"<Audio 1>"}))

    def test_motion_only_provenance_check_is_narrow(self):
        brief = "Use Video 1 only as the motion reference."
        bad = "<Subject 2> is the studio environment from <Video 1>."
        good = "A new target street frames the choreography from <Video 1>."
        self.assertTrue(explicit_constraint_violations(brief, bad))
        self.assertEqual(explicit_constraint_violations(brief, good), [])

    def test_explicit_no_cuts_is_enforced_but_unspecified_camera_is_not(self):
        prompt = "[Shot 1] A tracking shot. [Shot 2] Cut to a close-up."
        self.assertTrue(explicit_constraint_violations("Use one continuous shot with no cuts.", prompt))
        self.assertEqual(explicit_constraint_violations("Make it cinematic.", prompt), [])

    def test_narrow_repair_receives_original_request_and_exact_violations(self):
        assembled = {
            "messages": [
                {"role": "system", "content": "guide"},
                {"role": "user", "content": "Creative brief:\nUse Video 1 only for motion. Add some music."},
            ],
        }
        messages = narrow_repair_messages(
            assembled,
            "[reference generation + audio reference] draft with <Audio 1>",
            ["unexpected reference tags: <Audio 1>"],
            {"<Picture 1>", "<Video 1>"},
            10,
        )
        self.assertIn("not a new prompt-generation pass", messages[0]["content"])
        self.assertIn("unexpected reference tags: <Audio 1>", messages[0]["content"])
        self.assertIn("Use Video 1 only for motion", messages[1]["content"])

    def test_failure_summary_contains_only_objective_checks(self):
        failures = audit_failures({
            "missing_task_label": True,
            "unexpected_reference_tags": ["<Audio 1>"],
            "unexpected_audio_task": True,
        })
        self.assertIn("missing summary task label", failures)
        self.assertIn("unexpected reference tags: <Audio 1>", failures)
        self.assertFalse(any("word" in failure for failure in failures))

    def test_multimodal_repair_continues_original_conversation(self):
        original = [
            {"role": "system", "content": "guide"},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
                {"type": "text", "text": "Brief in any language"},
            ]},
        ]
        messages = multimodal_repair_messages(
            original,
            "draft with <Picture 1>",
            ["missing reference tags: <Picture 2>"],
            {"<Picture 1>", "<Picture 2>"},
            10,
        )
        self.assertEqual(messages[:2], original)
        self.assertEqual(messages[2]["role"], "assistant")
        self.assertIn("missing reference tags: <Picture 2>", messages[3]["content"])
        self.assertIn("does not need to become a primary scene element", messages[3]["content"])


if __name__ == "__main__":
    unittest.main()
