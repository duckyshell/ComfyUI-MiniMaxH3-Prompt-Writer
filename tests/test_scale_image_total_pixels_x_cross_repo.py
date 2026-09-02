import os
from pathlib import Path
import unittest


class ScaleImageToTotalPixelsXCrossRepositoryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = os.environ.get("SCALE_IMAGE_TOTAL_PIXELS_X_SOURCE", "").strip()
        if not raw:
            raise unittest.SkipTest("SCALE_IMAGE_TOTAL_PIXELS_X_SOURCE is not set")
        cls.source = (Path(raw) / "__init__.py").read_text("utf-8")

    def test_reviewed_node_identity_and_public_controls_are_pinned(self):
        for token in (
            "class ImageScaleToTotalPixelsX:",
            '"ImageScaleToTotalPixelsX": ImageScaleToTotalPixelsX',
            '"megapixels"',
            '"multiple_of"',
            '"resize_mode"',
            '"upscale_method"',
            '"stretch"',
            '"crop"',
            '"pad"',
            '"lanczos"',
        ):
            self.assertIn(token, self.source)

    def test_reviewed_geometry_and_lanczos_contract_matches_materializer(self):
        for token in (
            "total = int(megapixels * 1000000)",
            "scale_by = math.sqrt(total / (ow * oh))",
            "target_width = target_width - (target_width % multiple_of)",
            "target_height = target_height - (target_height % multiple_of)",
            "ratio = max(target_width / ow, target_height / oh)",
            "x = (new_width - target_width) // 2",
            "y = (new_height - target_height) // 2",
            "comfy.utils.lanczos(samples, resize_width, resize_height)",
            "outputs = outputs[:, y:y2, x:x2, :]",
        ):
            self.assertIn(token, self.source)


if __name__ == "__main__":
    unittest.main()
