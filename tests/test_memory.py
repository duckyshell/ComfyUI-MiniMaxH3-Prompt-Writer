import unittest

from backend.memory import assess_free_vram, estimated_free_vram_mb


MODEL = {
    "name": "Measured model",
    "estimated_free_vram_mb": {"low": 5000, "standard": 9000, "extended": 12000},
    "f16_kv_extra_mb_16k": 2000,
}


class MemoryPreflightTests(unittest.TestCase):
    def test_q8_uses_measured_profile_estimate(self):
        result = estimated_free_vram_mb(
            MODEL,
            {"context_profile": "standard", "context_tokens": 16384, "kv_cache": "q8"},
        )
        self.assertEqual(result, 9000)

    def test_f16_adds_context_scaled_kv_cost(self):
        result = estimated_free_vram_mb(
            MODEL,
            {"context_profile": "extended", "context_tokens": 24576, "kv_cache": "f16"},
        )
        self.assertEqual(result, 15000)

    def test_shortfall_returns_actionable_details(self):
        result = assess_free_vram(
            MODEL,
            {"context_profile": "standard", "context_tokens": 16384, "kv_cache": "q8"},
            {"free_mb": 6000, "total_mb": 12000},
        )
        self.assertEqual(result["required_free_mb"], 9000)
        self.assertEqual(result["shortfall_mb"], 3000)

    def test_loaded_matching_runtime_skips_guard(self):
        result = assess_free_vram(
            MODEL,
            {"context_profile": "standard", "context_tokens": 16384, "kv_cache": "q8"},
            {"free_mb": 100},
            already_loaded=True,
        )
        self.assertIsNone(result)

    def test_unknown_model_is_not_guessed(self):
        self.assertIsNone(assess_free_vram({}, {"context_profile": "standard"}, {"free_mb": 100}))


if __name__ == "__main__":
    unittest.main()
