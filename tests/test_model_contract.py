import unittest

from backend.models.contract import ModelError, final_message_text


class ModelContractTests(unittest.TestCase):
    def test_qwen_reasoning_prefix_without_opening_tag_is_removed(self):
        final, reasoning = final_message_text(
            {"content": "inspect the request carefully</think>final H3 prompt<eos>"},
            thinking=True,
            qwen_reasoning_contract=True,
        )

        self.assertEqual(final, "final H3 prompt")
        self.assertEqual(reasoning, "inspect the request carefully")

    def test_complete_qwen_think_block_is_removed(self):
        final, reasoning = final_message_text(
            {"content": "<think>private reasoning</think>public prompt"},
            thinking=True,
            qwen_reasoning_contract=True,
        )

        self.assertEqual(final, "public prompt")
        self.assertEqual(reasoning, "private reasoning")

    def test_separate_reasoning_content_is_never_mixed_into_final(self):
        final, reasoning = final_message_text(
            {"reasoning_content": "private reasoning", "content": "public prompt"},
            thinking=True,
            qwen_reasoning_contract=True,
        )

        self.assertEqual(final, "public prompt")
        self.assertEqual(reasoning, "private reasoning")

    def test_missing_qwen_closing_tag_is_a_truncated_thinking_response(self):
        with self.assertRaises(ModelError) as raised:
            final_message_text(
                {"content": "reasoning continued without a final prompt"},
                thinking=True,
                qwen_reasoning_contract=True,
            )

        self.assertEqual(raised.exception.code, "THINKING_TRUNCATED")


if __name__ == "__main__":
    unittest.main()
