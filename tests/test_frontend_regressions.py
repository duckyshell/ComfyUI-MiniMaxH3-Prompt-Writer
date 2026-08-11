import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "Node.js is required for frontend regression tests")
class FrontendRegressionTests(unittest.TestCase):
    def test_frontend_regression_suite(self):
        result = subprocess.run(
            [NODE, "--test", str(ROOT / "tests" / "frontend_regressions.mjs")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
