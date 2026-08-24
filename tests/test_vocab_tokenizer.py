import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import vocab_tokenizer
from backend.text_normalization import normalize_unicode_text
from backend.vocab_tokenizer import TokenizerPreflightError, VocabOnlyTokenizerClient, model_identity


class VocabTokenizerTests(unittest.TestCase):
    def test_worker_imports_sibling_normalizer_in_isolated_python(self):
        worker = Path(__file__).parents[1] / "backend" / "gguf_tokenizer_worker.py"
        result = subprocess.run(
            [sys.executable, "-I", "-X", "utf8", str(worker)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )

        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {"ready": False, "error": "Expected one GGUF model path."},
        )
        self.assertNotIn("ModuleNotFoundError", result.stderr)

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
                multilingual = "Русский 中文 العربية 😀 broken:\udc90"
                self.assertEqual(client.count(multilingual), len(normalize_unicode_text(multilingual)))
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

    def test_startup_timeout_terminates_the_spawned_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model.gguf"
            model.write_bytes(b"fixture")
            worker = root / "worker.py"
            worker.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
            processes = []
            real_popen = subprocess.Popen

            def tracked_popen(*args, **kwargs):
                process = real_popen(*args, **kwargs)
                processes.append(process)
                return process

            try:
                with (
                    patch.object(vocab_tokenizer.subprocess, "Popen", side_effect=tracked_popen),
                    self.assertRaises(TokenizerPreflightError) as raised,
                ):
                    VocabOnlyTokenizerClient(model, worker_path=worker, startup_timeout=0.05)

                self.assertIn("timed out", str(raised.exception))
                self.assertEqual(len(processes), 1)
                deadline = time.monotonic() + 2
                while processes[0].poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertIsNotNone(processes[0].poll())
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
