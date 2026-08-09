import unittest

from backend.context import ContextPlanError, plan_context


def request(text="short brief", visual_count=0):
    return {
        "messages": [
            {"role": "system", "content": "guide"},
            {"role": "user", "content": text},
        ],
        "media_inputs": [
            {"type": "image", "asset_id": str(index)}
            for index in range(visual_count)
        ],
    }


class ContextPlanTests(unittest.TestCase):
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

    def test_thinking_budget_is_dynamic(self):
        result = plan_context(
            request("x" * 30_000),
            {"recommended_context": "standard"},
            requested_context="16k",
            requested_kv_cache="q8",
            thinking=True,
        )
        self.assertLess(result["max_output_tokens"], 6144)
        self.assertGreaterEqual(result["max_output_tokens"], 1536)
        self.assertTrue(result["thinking_budget_reduced"])

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


if __name__ == "__main__":
    unittest.main()
