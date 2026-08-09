import unittest

from backend.media import MediaError, validate_reference_durations


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


if __name__ == "__main__":
    unittest.main()
