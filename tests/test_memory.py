import unittest

from backend.memory import assess_free_vram, estimated_free_vram_mb, unmeasured_vram_warning


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

    def test_measured_model_has_no_unmeasured_warning(self):
        self.assertIsNone(unmeasured_vram_warning(
            MODEL,
            {"context_profile": "standard", "context_tokens": 16384, "kv_cache": "q8"},
            {"free_mb": 6000, "total_mb": 12000},
        ))

    def test_unmeasured_model_warns_without_blocking(self):
        model = {"id": "custom-gguf", "name": "Custom GGUF", "estimated_free_vram_mb": None}
        plan = {"context_profile": "standard", "context_tokens": 16384, "kv_cache": "q8"}
        memory = {"free_mb": 6000.4, "total_mb": 24576}

        warning = unmeasured_vram_warning(model, plan, memory)

        self.assertEqual(warning, {
            "free_mb": 6000,
            "total_mb": 24576,
            "model_name": "Custom GGUF",
            "context_profile": "standard",
            "context_tokens": 16384,
            "kv_cache": "q8",
        })
        self.assertIsNone(assess_free_vram(model, plan, memory))

    def test_unmeasured_warning_requires_gpu_memory(self):
        self.assertIsNone(unmeasured_vram_warning(
            {"estimated_free_vram_mb": None},
            {"context_profile": "standard"},
            None,
        ))


if __name__ == "__main__":
    unittest.main()
