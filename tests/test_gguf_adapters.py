import unittest

from backend.models.gguf_adapters import (
    GEMMA_ADAPTER,
    QWEN35_ADAPTER,
    QWEN3VL_ADAPTER,
    QWEN3VL_MOE_ADAPTER,
    architecture_adapter,
    projector_is_compatible,
    runtime_supports,
)


class GGUFAdapterTests(unittest.TestCase):
    def test_architecture_is_not_a_qwen_version_or_lineage_policy(self):
        adapter = architecture_adapter("qwen35")

        self.assertIs(adapter, QWEN35_ADAPTER)
        self.assertFalse(hasattr(adapter, "reasoning_effort"))
        self.assertFalse(hasattr(adapter, "model_version"))
        self.assertIsNone(architecture_adapter("future_custom"))

    def test_qwen3vl_architectures_use_generic_mtmd_adapters(self):
        self.assertIs(architecture_adapter("qwen3vl"), QWEN3VL_ADAPTER)
        self.assertIs(architecture_adapter("QWEN3VLMOE"), QWEN3VL_MOE_ADAPTER)
        self.assertEqual(QWEN3VL_ADAPTER.projector_types, ("qwen3vl_merger",))
        self.assertEqual(QWEN3VL_MOE_ADAPTER.projector_types, ("qwen3vl_merger",))

    def test_runtime_support_is_adapter_and_version_specific(self):
        self.assertTrue(runtime_supports(GEMMA_ADAPTER, "0.3.34", module_available=True))
        self.assertFalse(runtime_supports(QWEN35_ADAPTER, "0.3.34", module_available=True))
        self.assertTrue(runtime_supports(QWEN35_ADAPTER, "0.3.35", module_available=True))
        self.assertTrue(runtime_supports(QWEN3VL_ADAPTER, "0.3.35", module_available=True))
        self.assertTrue(runtime_supports(QWEN3VL_MOE_ADAPTER, "0.3.35", module_available=True))
        self.assertFalse(runtime_supports(QWEN35_ADAPTER, "0.4.0", module_available=True))
        self.assertFalse(runtime_supports(QWEN35_ADAPTER, "0.3.35", module_available=False))
        self.assertFalse(runtime_supports(None, "0.3.35", module_available=True))

    def test_qwen_projector_requires_type_vision_and_matching_projection(self):
        model = {"embedding_length": 5_120}
        projector = {
            "architecture": "clip",
            "has_vision_encoder": True,
            "projector_type": "qwen3vl_merger",
            "projector_projection_dim": 5_120,
        }

        self.assertTrue(projector_is_compatible(QWEN35_ADAPTER, model, projector))
        self.assertTrue(projector_is_compatible(QWEN3VL_ADAPTER, model, projector))
        self.assertTrue(projector_is_compatible(QWEN3VL_MOE_ADAPTER, model, projector))
        self.assertFalse(projector_is_compatible(QWEN35_ADAPTER, model, {**projector, "projector_projection_dim": 2_048}))
        self.assertFalse(projector_is_compatible(QWEN35_ADAPTER, model, {**projector, "projector_type": "gemma4uv"}))
        self.assertFalse(projector_is_compatible(QWEN35_ADAPTER, model, {**projector, "has_vision_encoder": False}))


if __name__ == "__main__":
    unittest.main()
