import unittest

from backend.text_normalization import normalize_unicode_text


class TextNormalizationTests(unittest.TestCase):
    def test_arbitrary_languages_and_valid_emoji_are_unchanged(self):
        text = "English · Русский · 中文 · العربية · हिन्दी · 😀"

        self.assertEqual(normalize_unicode_text(text), text)
        self.assertEqual(normalize_unicode_text(text).encode("utf-8").decode("utf-8"), text)

    def test_unpaired_surrogates_are_replaced(self):
        self.assertEqual(normalize_unicode_text("before\udc90after"), "before\ufffdafter")
        self.assertEqual(normalize_unicode_text("\ud800middle\udfff"), "\ufffdmiddle\ufffd")

    def test_valid_surrogate_pair_is_combined(self):
        self.assertEqual(normalize_unicode_text("pair: \ud83d\ude00"), "pair: 😀")


if __name__ == "__main__":
    unittest.main()
