import os
import tempfile
import unittest
from pathlib import Path

from backend.text_normalization import normalize_unicode_text
from backend.vocab_tokenizer import TokenizerPreflightError, VocabOnlyTokenizerClient, model_identity


class FakeTokenizerModel:
    def __init__(self, **kwargs):
        self.options = kwargs
        self.closed = False

    def tokenize(self, value, *, add_bos):
        assert add_bos is True
        return list(normalize_unicode_text(value.decode("utf-8")))

    def close(self):
        self.closed = True


class VocabTokenizerTests(unittest.TestCase):
    def test_cached_handle_forces_cpu_vocab_only_mode(self):
        created = []

        def factory(**kwargs):
            model = FakeTokenizerModel(**kwargs)
            created.append(model)
            return model

        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "model.gguf"
            model_path.write_bytes(b"fixture")
            client = VocabOnlyTokenizerClient(model_path, model_factory=factory)
            try:
                self.assertEqual(client.count("four"), 4)
                self.assertEqual(client.count("sixsix"), 6)
                multilingual = "Русский 中文 العربية 😀 broken:\udc90"
                self.assertEqual(client.count(multilingual), len(normalize_unicode_text(multilingual)))
                self.assertEqual(len(created), 1)
                self.assertTrue(created[0].options["vocab_only"])
                self.assertEqual(created[0].options["n_gpu_layers"], 0)
                self.assertFalse(created[0].options["verbose"])
            finally:
                client.close()

        self.assertTrue(created[0].closed)

    def test_model_identity_changes_with_file_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.gguf"
            path.write_bytes(b"a")
            first = model_identity(path)
            path.write_bytes(b"different")
            os.utime(path, None)
            second = model_identity(path)

        self.assertNotEqual(first[1:], second[1:])

    def test_model_startup_failure_is_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.gguf"
            path.write_bytes(b"fixture")

            def failing_factory(**_kwargs):
                raise RuntimeError("bad fixture")

            with self.assertRaises(TokenizerPreflightError) as raised:
                VocabOnlyTokenizerClient(path, model_factory=failing_factory)

        self.assertIn("bad fixture", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
