import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import media


class MediaResampleTests(unittest.TestCase):
    def test_auto_video_sampling_uses_six_frames(self):
        self.assertEqual(media._selected_frame_count("auto"), 6)
        self.assertEqual(media._selected_frame_count("4"), 4)
        self.assertEqual(media._selected_frame_count("6"), 6)
        self.assertEqual(media._selected_frame_count("8"), 8)

    def test_contact_sheet_columns_make_complete_two_row_grids(self):
        self.assertEqual(media._contact_sheet_columns(4), 2)
        self.assertEqual(media._contact_sheet_columns(6), 3)
        self.assertEqual(media._contact_sheet_columns(8), 4)

    def test_four_frame_resample_changes_all_derived_media_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.touch()
            old_frame = root / "old-frame.jpg"
            old_frame.touch()
            store = media.MediaStore()
            store.sessions["session"] = [{
                "id": "asset",
                "session_id": "session",
                "mode": "Reference",
                "type": "video",
                "_original_path": str(source),
                "_preview_path": str(old_frame),
                "_contact_sheet_path": str(root / "sheet.jpg"),
                "_frames": [{"timestamp": 0.0, "path": str(old_frame)}],
                "frame_count_mode": "auto",
                "include_endpoints": True,
                "sample_index": 0,
            }]
            new_frames = [
                {"timestamp": float(index), "path": str(root / f"frame-{index}.jpg")}
                for index in range(4)
            ]
            processed = {
                "_preview_path": new_frames[0]["path"],
                "_contact_sheet_path": str(root / "sheet.jpg"),
                "_frames": new_frames,
                "frame_count_mode": "4",
                "frame_count": 4,
                "include_endpoints": True,
                "sample_index": 0,
            }

            with patch.object(media, "process_video", return_value=processed) as process_video:
                result = store.resample("session", "asset", "4", True)

        self.assertEqual(len(result["frames"]), 4)
        self.assertEqual(result["frame_count_mode"], "4")
        self.assertIn("revision=1", result["preview_url"])
        self.assertIn("revision=1", result["contact_sheet_url"])
        self.assertTrue(all("revision=1" in frame["url"] for frame in result["frames"]))
        self.assertEqual(process_video.call_args.kwargs["frame_count_mode"], "4")

    def test_each_resample_advances_content_revision(self):
        store = media.MediaStore()
        store.sessions["session"] = [{
            "id": "asset",
            "session_id": "session",
            "mode": "Reference",
            "type": "video",
            "_original_path": "missing.mp4",
            "_frames": [],
            "frame_count_mode": "6",
            "include_endpoints": True,
            "sample_index": 0,
            "content_revision": 3,
        }]
        processed = {
            "_frames": [],
            "frame_count_mode": "6",
            "include_endpoints": True,
            "sample_index": 1,
        }

        with patch.object(media, "process_video", return_value=processed):
            result = store.resample("session", "asset", "6", True)

        self.assertEqual(result["content_revision"], 4)


if __name__ == "__main__":
    unittest.main()
