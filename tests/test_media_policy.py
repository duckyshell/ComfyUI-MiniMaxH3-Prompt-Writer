import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageChops

from backend.media import (
    MediaError,
    materialize_workflow_image,
    normalize_workflow_materialization_plan,
    validate_reference_durations,
)


def clip(kind: str, duration: float) -> dict:
    return {"mode": "Reference", "type": kind, "duration": duration}


class ReferenceDurationTests(unittest.TestCase):
    def test_nominal_fifteen_second_metadata_is_accepted(self):
        validate_reference_durations([], clip("video", 15.08))

    def test_each_clip_has_its_own_limit(self):
        existing = [clip("audio", 10.0), clip("audio", 12.0)]
        validate_reference_durations(existing, clip("audio", 14.0))

    def test_genuinely_long_clip_is_rejected(self):
        with self.assertRaises(MediaError) as raised:
            validate_reference_durations([], clip("video", 15.11))
        self.assertEqual(raised.exception.code, "UNSUPPORTED_DURATION")


class WorkflowMaterializationTests(unittest.TestCase):
    @staticmethod
    def plan(**overrides):
        value = {
            "kind": "image_scale_to_total_pixels_x",
            "version": 1,
            "node_class": "ImageScaleToTotalPixelsX",
            "contract_sha": "79e831097bb7a76ade3a28359300e62332086c42",
            "megapixels": 0.70,
            "multiple_of": 32,
            "resize_mode": "crop",
            "upscale_method": "lanczos",
        }
        value.update(overrides)
        return value

    def test_reviewed_lanczos_crop_matches_scale_x_geometry_and_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            target = root / "materialized.png"
            image = Image.new("RGB", (640, 480))
            pixels = image.load()
            for y in range(image.height):
                for x in range(image.width):
                    pixels[x, y] = (x % 256, y % 256, (x + y) % 256)
            image.save(source)

            result = materialize_workflow_image(source, target, self.plan())
            self.assertEqual((result["width"], result["height"]), (960, 704))

            expected = image.resize((960, 720), Image.Resampling.LANCZOS).crop((0, 8, 960, 712))
            with Image.open(target) as actual:
                self.assertEqual(actual.size, (960, 704))
                self.assertIsNone(ImageChops.difference(actual.convert("RGB"), expected).getbbox())

    def test_reviewed_plan_is_strictly_pinned_and_non_lanczos_methods_fail_closed(self):
        normalized = normalize_workflow_materialization_plan(self.plan(resize_mode="pad"))
        self.assertEqual(normalized["contract_sha"], "79e831097bb7a76ade3a28359300e62332086c42")
        with self.assertRaises(MediaError) as raised:
            normalize_workflow_materialization_plan(self.plan(contract_sha="changed"))
        self.assertEqual(raised.exception.code, "WORKFLOW_MATERIALIZATION_CONTRACT_DRIFT")
        with self.assertRaises(MediaError) as raised:
            normalize_workflow_materialization_plan(self.plan(upscale_method="bicubic"))
        self.assertEqual(raised.exception.code, "WORKFLOW_MATERIALIZATION_UNSUPPORTED")


if __name__ == "__main__":
    unittest.main()
