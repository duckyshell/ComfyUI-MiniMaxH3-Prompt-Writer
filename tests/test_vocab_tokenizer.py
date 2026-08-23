import os
import tempfile
import textwrap
import unittest
from pathlib import Path

from backend.vocab_tokenizer import VocabOnlyTokenizerClient, model_identity


class VocabTokenizerTests(unittest.TestCase):
    def test_cached_worker_protocol_forces_cpu_vocab_only_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model.gguf"
            model.write_bytes(b"fixture")
            worker = root / "worker.py"
            worker.write_text(textwrap.dedent("""
                import json
                import os
                import sys
                print(json.dumps({
                    "ready": True,
                    "vocab_only": True,
                    "n_gpu_layers": 0,
                    "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
                }), flush=True)
                for line in sys.stdin:
                    request = json.loads(line)
                    if request.get("operation") == "shutdown":
                        break
                    print(json.dumps({"id": request["id"], "count": len(request["text"])}), flush=True)
            """), encoding="utf-8")

            client = VocabOnlyTokenizerClient(model, worker_path=worker, startup_timeout=5, request_timeout=5)
            try:
                self.assertEqual(client.count("four"), 4)
                self.assertEqual(client.count("sixsix"), 6)
                self.assertTrue(client.startup["vocab_only"])
                self.assertEqual(client.startup["n_gpu_layers"], 0)
                self.assertEqual(client.startup["cuda_visible_devices"], "-1")
            finally:
                client.close()

    def test_model_identity_changes_with_file_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.gguf"
            path.write_bytes(b"a")
            first = model_identity(path)
            path.write_bytes(b"different")
            os.utime(path, None)
            second = model_identity(path)

        self.assertNotEqual(first[1:], second[1:])


if __name__ == "__main__":
    unittest.main()
