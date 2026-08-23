import unittest

from backend.context import ContextPlanError, estimate_visual_tokens, plan_context


def request(text="short brief", visual_count=0, mode="T2VA"):
    return {
        "messages": [
            {"role": "system", "content": "guide"},
            {"role": "user", "content": text},
        ],
        "media_inputs": [
            {"type": "image", "asset_id": str(index)}
            for index in range(visual_count)
        ],
        "input": {"mode": mode},
    }


class ContextPlanTests(unittest.TestCase):
    @staticmethod
    def qwen_model(*, native_context=262_144, adapter="qwen35"):
        return {
            "architecture_adapter": adapter,
            "recommended_context": "standard",
            "context_profiles": ["standard", "extended", "large", "maximum"],
            "auto_context_ladder": True,
            "native_context_tokens": native_context,
            "projector_metadata": {
                "vision_patch_size": 16,
                "vision_spatial_merge_size": 2,
            },
        }

    def test_auto_uses_model_recommendation_and_q8(self):
        result = plan_context(
            request(),
            {"recommended_context": "low"},
            requested_context="auto",
            requested_kv_cache="auto",
            thinking=False,
        )
        self.assertEqual(result["context_tokens"], 8192)
        self.assertEqual(result["kv_cache"], "q8")

    def test_auto_escalates_low_recommendation_for_thinking(self):
        result = plan_context(
            request(),
            {"recommended_context": "low"},
            requested_context="auto",
            requested_kv_cache="q8",
            thinking=True,
        )
        self.assertEqual(result["context_profile"], "standard")
        self.assertEqual(result["max_output_tokens"], 8192)

    def test_manual_low_context_rejects_thinking_before_load(self):
        with self.assertRaises(ContextPlanError) as raised:
            plan_context(
                request(),
                {"recommended_context": "low"},
                requested_context="8k",
                requested_kv_cache="q8",
                thinking=True,
            )
        self.assertEqual(raised.exception.code, "THINKING_DISABLED_LOW_CONTEXT")

    def test_auto_escalates_to_standard_when_request_needs_it(self):
        result = plan_context(
            request("x" * 20_000, visual_count=8),
            {"recommended_context": "low"},
            requested_context="auto",
            requested_kv_cache="q8",
            thinking=False,
        )
        self.assertEqual(result["context_profile"], "standard")
        self.assertEqual(result["max_output_tokens"], 2048)

    def test_music_keeps_its_separate_non_thinking_output_budget(self):
        result = plan_context(
            request(mode="Music3"),
            {"recommended_context": "standard"},
            requested_context="auto",
            requested_kv_cache="q8",
            thinking=False,
        )

        self.assertEqual(result["context_profile"], "standard")
        self.assertEqual(result["max_output_tokens"], 1536)
        self.assertEqual(result["reserved_output_tokens"], 2048)

    def test_auto_thinking_selects_extended_for_full_completion_budget(self):
        result = plan_context(
            request("x" * 30_000),
            {"recommended_context": "standard"},
            requested_context="auto",
            requested_kv_cache="q8",
            thinking=True,
        )

        self.assertEqual(result["context_profile"], "extended")
        self.assertEqual(result["context_tokens"], 24576)
        self.assertEqual(result["max_output_tokens"], 8192)
        self.assertFalse(result["thinking_budget_reduced"])

    def test_opt_in_auto_ladder_selects_the_smallest_sufficient_tier(self):
        standard = plan_context(
            request("x" * 20_000, visual_count=8),
            {"recommended_context": "low", "auto_context_ladder": True},
            requested_context="auto",
            requested_kv_cache="auto",
            thinking=False,
        )
        extended = plan_context(
            request("x" * 50_000),
            {"recommended_context": "low", "auto_context_ladder": True},
            requested_context="auto",
            requested_kv_cache="auto",
            thinking=False,
        )

        self.assertEqual(standard["context_profile"], "standard")
        self.assertEqual(extended["context_profile"], "extended")

    def test_opt_in_auto_ladder_rejects_requests_larger_than_24k(self):
        with self.assertRaises(ContextPlanError) as raised:
            plan_context(
                request("x" * 80_000),
                {"recommended_context": "low", "auto_context_ladder": True},
                requested_context="auto",
                requested_kv_cache="auto",
                thinking=False,
            )

        self.assertEqual(raised.exception.code, "CONTEXT_BUDGET_EXCEEDED")
        self.assertEqual(raised.exception.details["context_profile"], "extended")
        self.assertIsNone(raised.exception.details["suggested_context_profile"])

    def test_manual_thinking_context_is_not_silently_degraded(self):
        with self.assertRaises(ContextPlanError) as raised:
            plan_context(
                request("x" * 30_000),
                {"recommended_context": "standard"},
                requested_context="16k",
                requested_kv_cache="q8",
                thinking=True,
            )

        self.assertEqual(raised.exception.code, "THINKING_CONTEXT_INSUFFICIENT")
        self.assertEqual(raised.exception.details["minimum_output_tokens"], 8192)
        self.assertEqual(raised.exception.details["suggested_context_profile"], "extended")

    def test_preflight_suggests_larger_profile_without_dropping_media(self):
        with self.assertRaises(ContextPlanError) as raised:
            plan_context(
                request("x" * 20_000, visual_count=8),
                {"recommended_context": "low"},
                requested_context="8k",
                requested_kv_cache="q8",
                thinking=False,
            )
        self.assertEqual(raised.exception.code, "CONTEXT_BUDGET_EXCEEDED")
        self.assertEqual(raised.exception.details["suggested_context_profile"], "standard")

    def test_qwen_auto_uses_exact_tokenizer_counts_across_16_24_32_48k(self):
        cases = (
            (4_000, "standard", 16_384),
            (10_000, "extended", 24_576),
            (20_000, "large", 32_768),
            (32_000, "maximum", 49_152),
        )
        for exact_tokens, profile, tokens in cases:
            with self.subTest(exact_tokens=exact_tokens):
                result = plan_context(
                    request(),
                    self.qwen_model(),
                    requested_context="auto",
                    requested_kv_cache="auto",
                    thinking=True,
                    count_text_tokens=lambda _text, value=exact_tokens: value,
                )
                self.assertEqual(result["context_profile"], profile)
                self.assertEqual(result["context_tokens"], tokens)
                self.assertEqual(result["estimated_text_tokens"], exact_tokens)
                self.assertEqual(result["text_token_source"], "vocab_only")

    def test_qwen_visual_tokens_use_prepared_dimensions_and_projector_patch_policy(self):
        assembled = request()
        assembled["media_inputs"] = [
            {"type": "image", "asset_id": "landscape", "visual_width": 1_536, "visual_height": 768},
            {"type": "video", "asset_id": "sheet", "visual_width": 1_152, "visual_height": 488},
        ]

        total, details, applied = estimate_visual_tokens(assembled, self.qwen_model())

        self.assertEqual(total, 1_152 + 576)
        self.assertEqual([item["tokens"] for item in details], [1_152, 576])
        self.assertTrue(applied)

    def test_qwen3vl_visual_budget_uses_projector_grid_not_response_usage(self):
        assembled = request()
        assembled["media_inputs"] = [
            {"type": "image", "asset_id": "live-smoke", "visual_width": 1_504, "visual_height": 2_720},
        ]

        total, details, applied = estimate_visual_tokens(
            assembled,
            self.qwen_model(adapter="qwen3vl"),
        )

        self.assertEqual(total, 47 * 85)
        self.assertEqual(details[0]["tokens"], 3_995)
        self.assertTrue(applied)

    def test_qwen_missing_dimensions_use_conservative_media_maxima(self):
        total, details, applied = estimate_visual_tokens(
            request(visual_count=1),
            self.qwen_model(),
        )

        self.assertEqual(total, 2_304)
        self.assertEqual(details[0]["width"], 1_536)
        self.assertTrue(applied)

    def test_maximum_reference_budget_selects_48k(self):
        assembled = request(mode="Reference")
        assembled["media_inputs"] = [
            *[
                {"type": "image", "asset_id": f"image-{index}", "visual_width": 1_536, "visual_height": 1_536}
                for index in range(9)
            ],
            *[
                {"type": "video", "asset_id": f"video-{index}", "visual_width": 1_152, "visual_height": 1_080}
                for index in range(3)
            ],
        ]

        result = plan_context(
            assembled,
            self.qwen_model(),
            requested_context="auto",
            requested_kv_cache="q8",
            thinking=True,
            count_text_tokens=lambda _text: 7_427,
        )

        self.assertEqual(result["estimated_visual_tokens"], 24_408)
        self.assertEqual(result["context_profile"], "maximum")
        self.assertEqual(result["context_tokens"], 49_152)
        self.assertTrue(result["vision_budget_applied"])

    def test_qwen_never_allocates_a_tier_above_native_context(self):
        with self.assertRaises(ContextPlanError) as raised:
            plan_context(
                request(),
                self.qwen_model(native_context=32_768),
                requested_context="auto",
                requested_kv_cache="q8",
                thinking=True,
                count_text_tokens=lambda _text: 32_000,
            )

        self.assertEqual(raised.exception.details["context_profile"], "large")
        self.assertIsNone(raised.exception.details["suggested_context_profile"])

    def test_48k_manual_profile_is_qwen_only(self):
        result = plan_context(
            request(),
            self.qwen_model(),
            requested_context="48k",
            requested_kv_cache="q8",
            thinking=False,
            count_text_tokens=lambda _text: 100,
        )
        self.assertEqual(result["context_profile"], "maximum")

        with self.assertRaises(ContextPlanError):
            plan_context(
                request(),
                {"recommended_context": "standard"},
                requested_context="48k",
                requested_kv_cache="q8",
                thinking=False,
            )


if __name__ == "__main__":
    unittest.main()
