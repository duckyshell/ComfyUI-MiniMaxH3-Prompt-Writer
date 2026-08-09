import unittest

from backend.assembly import _final_contract
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


if __name__ == "__main__":
    unittest.main()
