import struct
import tempfile
import unittest
from pathlib import Path

from backend.gguf_metadata import GGUFMetadataError, classify_gguf_file, read_gguf_metadata


TYPE_UINT32 = 4
TYPE_BOOL = 7
TYPE_STRING = 8
TYPE_ARRAY = 9


def pack_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return struct.pack("<Q", len(encoded)) + encoded


def pack_value(value_type: int, value) -> bytes:
    if value_type == TYPE_STRING:
        return pack_string(value)
    if value_type == TYPE_UINT32:
        return struct.pack("<I", value)
    if value_type == TYPE_BOOL:
        return struct.pack("<?", value)
    if value_type == TYPE_ARRAY:
        element_type, entries = value
        return struct.pack("<IQ", element_type, len(entries)) + b"".join(pack_value(element_type, item) for item in entries)
    raise AssertionError(value_type)


def write_gguf(path: Path, entries: list[tuple[str, int, object]], *, tensor_names: tuple[str, ...] = ()) -> None:
    body = b"".join(
        pack_string(key) + struct.pack("<I", value_type) + pack_value(value_type, value)
        for key, value_type, value in entries
    )
    tensors = b"".join(
        pack_string(name) + struct.pack("<IQQIQ", 2, 1, 1, 0, 0)
        for name in tensor_names
    )
    path.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, len(tensor_names), len(entries)) + body + tensors)


class GGUFMetadataTests(unittest.TestCase):
    def test_reads_architecture_template_and_projector_fields_without_arrays(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.gguf"
            write_gguf(path, [
                ("general.architecture", TYPE_STRING, "qwen35"),
                ("general.name", TYPE_STRING, "Qwen custom"),
                ("qwen35.context_length", TYPE_UINT32, 262_144),
                ("qwen35.embedding_length", TYPE_UINT32, 5_120),
                ("tokenizer.ggml.tokens", TYPE_ARRAY, (TYPE_STRING, ["a", "b"])),
                ("tokenizer.chat_template", TYPE_STRING, "{% if enable_thinking %}{{ reasoning_effort }}{% endif %}"),
                ("clip.has_vision_encoder", TYPE_BOOL, True),
                ("clip.projector_type", TYPE_STRING, "qwen3vl_merger"),
                ("clip.vision.projection_dim", TYPE_UINT32, 5_120),
                ("clip.vision.patch_size", TYPE_UINT32, 16),
                ("clip.vision.spatial_merge_size", TYPE_UINT32, 2),
                ("qwen35.mtp.block_count", TYPE_UINT32, 1),
            ], tensor_names=("blk.0.attn.weight", "blk.64.nextn.eh_proj.weight"))

            metadata = read_gguf_metadata(path)

        self.assertEqual(metadata["architecture"], "qwen35")
        self.assertEqual(metadata["context_length"], 262_144)
        self.assertEqual(metadata["embedding_length"], 5_120)
        self.assertEqual(metadata["projector_type"], "qwen3vl_merger")
        self.assertEqual(metadata["projector_projection_dim"], 5_120)
        self.assertEqual(metadata["vision_patch_size"], 16)
        self.assertEqual(metadata["vision_spatial_merge_size"], 2)
        self.assertEqual(metadata["template_controls"], {"enable_thinking": True, "reasoning_effort": True})
        self.assertEqual(metadata["reasoning_effort_values"], [])
        self.assertTrue(metadata["mtp_detected"])
        self.assertNotIn("tokenizer.ggml.tokens", metadata["values"])

    def test_extracts_explicit_reasoning_effort_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.gguf"
            write_gguf(path, [
                ("general.architecture", TYPE_STRING, "qwen35"),
                ("tokenizer.chat_template", TYPE_STRING, "{% if reasoning_effort == 'high' %}{% endif %}{% if reasoning_effort not in ('xhigh', 'medium', 'low') %}bad{% endif %}"),
            ])
            metadata = read_gguf_metadata(path)

        self.assertEqual(metadata["reasoning_effort_values"], ["low", "medium", "high", "xhigh"])

    def test_classification_uses_metadata_without_filename_fallback(self):
        self.assertEqual(classify_gguf_file({"architecture": "qwen35"}, "mmproj-renamed.gguf"), "model")
        self.assertEqual(classify_gguf_file({
            "architecture": "clip",
            "has_vision_encoder": True,
        }, "vision-sidecar.gguf"), "projector")
        self.assertEqual(classify_gguf_file({"architecture": "clip"}, "mmproj-legacy.gguf"), "unknown")
        self.assertEqual(classify_gguf_file(None, "mmproj-legacy.gguf"), "unknown")
        self.assertEqual(classify_gguf_file(None, "custom.gguf"), "unknown")

    def test_rejects_non_gguf_and_truncated_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            invalid = root / "invalid.gguf"
            invalid.write_bytes(b"nope")
            truncated = root / "truncated.gguf"
            truncated.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 1))

            with self.assertRaises(GGUFMetadataError):
                read_gguf_metadata(invalid)
            with self.assertRaises(GGUFMetadataError):
                read_gguf_metadata(truncated)


if __name__ == "__main__":
    unittest.main()
