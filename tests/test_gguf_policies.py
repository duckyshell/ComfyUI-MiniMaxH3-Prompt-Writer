import unittest

from backend.models.gguf_policies import (
    QWEN36_POLICY,
    QWEN38_LINEAGE,
    QWEN38_POLICY,
    identify_model_policy,
    non_policy_configuration_is_verified,
    policy_is_verified_configuration,
    resolve_model_lineage,
    sampling_options,
    template_kwargs,
)


class GGUFPolicyTests(unittest.TestCase):
    def test_policy_requires_exact_metadata_lineage_not_architecture_alone(self):
        self.assertIs(identify_model_policy("qwen35", "Qwen3.8-27B"), QWEN38_POLICY)
        self.assertIs(identify_model_policy("qwen35moe", "Qwen3.6-35B-A3B"), QWEN36_POLICY)
        self.assertIsNone(identify_model_policy("qwen35", "Custom Qwen fine-tune"))
        self.assertIsNone(identify_model_policy("qwen35moe", "Qwen3.6-35B-A3B-Uncensored"))
        self.assertIsNone(identify_model_policy("qwen35moe", "Qwen3.8-27B"))
        self.assertIsNone(identify_model_policy("qwen3vl", "Qwen3Vl 8b Instruct"))
        self.assertIsNone(identify_model_policy("qwen3vlmoe", "Qwen3 VL MoE"))

    def test_qwen38_derivative_uses_full_structural_fingerprint_without_names(self):
        values = {
            **dict(QWEN38_LINEAGE.structural_fingerprint),
            "general.file_type": 17,
            "tokenizer.chat_template": "custom template",
        }

        match = resolve_model_lineage("qwen35", "Abl 27b", values)

        self.assertIsNotNone(match)
        self.assertIs(match.lineage, QWEN38_LINEAGE)
        self.assertEqual(match.source, "structural_fingerprint")
        self.assertIs(identify_model_policy("qwen35", "Abl 27b", values), QWEN38_POLICY)

    def test_qwen38_fingerprint_requires_every_architecture_value(self):
        values = dict(QWEN38_LINEAGE.structural_fingerprint)
        values["qwen35.ssm.inner_size"] = 6_143

        self.assertIsNone(resolve_model_lineage("qwen35", "Abl 27b", values))
        self.assertIsNone(identify_model_policy("qwen35", "Abl 27b", values))

    def test_unknown_provenance_blocks_fingerprint_fallback(self):
        values = {
            **dict(QWEN38_LINEAGE.structural_fingerprint),
            "general.base_model.count": 1,
            "general.base_model.0.name": "Different qwen35 base",
            "general.base_model.0.repo_url": "https://huggingface.co/example/different-base",
        }

        self.assertIsNone(resolve_model_lineage("qwen35", "Qwen3.8-27B", values))
        self.assertIsNone(identify_model_policy("qwen35", "Qwen3.8-27B", values))

    def test_matching_provenance_has_priority_over_structural_metadata(self):
        values = {
            "general.base_model.count": 1,
            "general.base_model.0.name": "Qwen3.8 27B",
            "general.base_model.0.repo_url": "https://huggingface.co/Qwen/Qwen3.8-27B/",
            "qwen35.block_count": 1,
        }

        match = resolve_model_lineage("qwen35", "Renamed derivative", values)

        self.assertIsNotNone(match)
        self.assertIs(match.lineage, QWEN38_LINEAGE)
        self.assertEqual(match.source, "provenance")

    def test_qwen38_sampling_uses_llama_cpp_parameter_names(self):
        fallback = {"temperature": 0.2, "top_p": 0.3, "top_k": 64}

        thinking = sampling_options({"model_policy": QWEN38_POLICY.id}, thinking=True, fallback=fallback)
        non_thinking = sampling_options({"model_policy": QWEN38_POLICY.id}, thinking=False, fallback=fallback)

        self.assertEqual(thinking, {
            "temperature": 1.0,
            "top_p": 0.95,
            "top_k": 20,
            "min_p": 0.0,
            "presence_penalty": 0.0,
            "repeat_penalty": 1.0,
        })
        self.assertEqual(non_thinking["temperature"], 0.7)
        self.assertEqual(non_thinking["top_p"], 0.8)
        self.assertEqual(non_thinking["presence_penalty"], 1.5)
        self.assertIn("repeat_penalty", non_thinking)
        self.assertNotIn("repetition_penalty", non_thinking)

    def test_reasoning_effort_low_requires_both_policy_and_template_control(self):
        base = {
            "model_policy": QWEN38_POLICY.id,
            "template_controls": {"enable_thinking": True, "reasoning_effort": True},
        }
        self.assertEqual(template_kwargs(base, thinking=True), {
            "enable_thinking": True,
            "reasoning_effort": "low",
        })
        self.assertEqual(template_kwargs(base, thinking=False), {"enable_thinking": False})
        self.assertEqual(
            template_kwargs({**base, "model_policy": None}, thinking=True),
            {"enable_thinking": True},
        )
        self.assertEqual(
            template_kwargs({**base, "template_controls": {"enable_thinking": True}}, thinking=True),
            {"enable_thinking": True},
        )

    def test_only_the_live_spiked_quant_is_marked_verified(self):
        self.assertTrue(policy_is_verified_configuration(QWEN38_POLICY, "Qwen3.8-27B-UD-Q4_K_XL.gguf"))
        self.assertFalse(policy_is_verified_configuration(QWEN38_POLICY, "Qwen3.8-27B-Q8_0.gguf"))

    def test_qwen3vl_pair_verification_does_not_create_a_sampling_policy(self):
        self.assertTrue(non_policy_configuration_is_verified(
            "qwen3vl",
            "Qwen3Vl 8b Instruct",
            "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
            "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
        ))
        self.assertFalse(non_policy_configuration_is_verified(
            "qwen3vl",
            "Qwen3Vl 8b Instruct",
            "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
            "mmproj-custom.gguf",
        ))
        fallback = {"temperature": 0.2, "top_p": 0.3, "top_k": 64}
        self.assertEqual(
            sampling_options({"model_policy": None}, thinking=False, fallback=fallback),
            fallback,
        )
        self.assertEqual(
            template_kwargs({
                "model_policy": None,
                "template_controls": {"enable_thinking": False, "reasoning_effort": False},
            }, thinking=False),
            {},
        )


if __name__ == "__main__":
    unittest.main()
