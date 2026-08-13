import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import media


class MediaTransactionTests(unittest.TestCase):
    @staticmethod
    def asset(root: Path, asset_id: str, mode: str, kind: str, reference: str) -> dict:
        asset_dir = root / asset_id
        asset_dir.mkdir()
        original = asset_dir / {"image": "original.png", "video": "original.mp4", "audio": "original.wav"}[kind]
        original.touch()
        return {
            "id": asset_id,
            "session_id": "session",
            "mode": mode,
            "type": kind,
            "filename": original.name,
            "size": 0,
            "mime_type": f"{kind}/test",
            "reference": reference,
            "_original_path": str(original),
        }

    def test_clear_mode_preserves_other_mode_assets_and_removes_only_target_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = self.asset(root, "reference", "Reference", "image", "<Picture 1>")
            first_frame = self.asset(root, "first", "I2VA", "image", "Start image")
            store = media.MediaStore()
            store.sessions["session"] = [reference, first_frame]

            remaining = store.clear_mode("session", "Reference")

            self.assertFalse((root / "reference").exists())
            self.assertTrue((root / "first").exists())
            self.assertEqual([asset["id"] for asset in remaining], ["first"])

    def test_failed_replace_keeps_old_asset_and_files_intact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = self.asset(root, "old", "Reference", "image", "<Picture 1>")
            second = self.asset(root, "second", "Reference", "image", "<Picture 2>")
            new_dir = root / "new"
            new_dir.mkdir()
            incoming = new_dir / "original.png"
            incoming.touch()
            store = media.MediaStore()
            store.sessions["session"] = [old, second]

            with patch.object(media, "process_image", side_effect=RuntimeError("decode failed")):
                with self.assertRaises(media.MediaError) as raised:
                    store.replace("session", "old", "replacement.png", "image/png", incoming)

            self.assertEqual(raised.exception.code, "MEDIA_DECODE_FAILED")
            self.assertIs(store.sessions["session"][0], old)
            self.assertTrue(Path(old["_original_path"]).exists())

    def test_successful_replace_commits_new_asset_before_removing_old_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = self.asset(root, "old", "Reference", "image", "<Picture 1>")
            second = self.asset(root, "second", "Reference", "image", "<Picture 2>")
            new_dir = root / "new"
            new_dir.mkdir()
            incoming = new_dir / "original.png"
            incoming.touch()
            prepared = new_dir / "prepared.jpg"
            preview = new_dir / "preview.jpg"
            prepared.touch()
            preview.touch()
            store = media.MediaStore()
            store.sessions["session"] = [old, second]

            with patch.object(media, "process_image", return_value={"width": 10, "height": 20, "_prepared_path": str(prepared), "_preview_path": str(preview)}):
                result = store.replace("session", "old", "replacement.png", "image/png", incoming)

            self.assertEqual(result["id"], "new")
            self.assertEqual(result["reference"], "<Picture 1>")
            self.assertEqual(store.sessions["session"][0]["id"], "new")
            self.assertEqual([asset["id"] for asset in store.sessions["session"]], ["new", "second"])
            self.assertEqual([asset["reference"] for asset in store.sessions["session"]], ["<Picture 1>", "<Picture 2>"])
            self.assertFalse((root / "old").exists())
            self.assertTrue(incoming.exists())

    def test_failed_resample_preserves_old_derived_media_and_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = self.asset(root, "video", "Reference", "video", "<Video 1>")
            asset_dir = Path(video["_original_path"]).parent
            old_frame = asset_dir / "old-frame.jpg"
            old_sheet = asset_dir / "old-sheet.jpg"
            old_frame.touch()
            old_sheet.touch()
            video.update({
                "_preview_path": str(old_frame),
                "_contact_sheet_path": str(old_sheet),
                "_frames": [{"timestamp": 0.0, "path": str(old_frame)}],
                "frame_count_mode": "auto",
                "include_endpoints": True,
                "sample_index": 0,
                "content_revision": 4,
            })
            store = media.MediaStore()
            store.sessions["session"] = [video]

            with patch.object(media, "process_video", side_effect=RuntimeError("sampling failed")):
                with self.assertRaises(media.MediaError) as raised:
                    store.resample("session", "video", "4", True)

            self.assertEqual(raised.exception.code, "MEDIA_DECODE_FAILED")
            self.assertEqual(video["content_revision"], 4)
            self.assertEqual(video["_preview_path"], str(old_frame))
            self.assertTrue(old_frame.exists())
            self.assertTrue(old_sheet.exists())
            self.assertEqual(list(asset_dir.glob("derived_*")), [])

    def test_successful_resample_commits_new_files_and_then_removes_old_derived_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = self.asset(root, "video", "Reference", "video", "<Video 1>")
            asset_dir = Path(video["_original_path"]).parent
            old_frame = asset_dir / "old-frame.jpg"
            old_sheet = asset_dir / "old-sheet.jpg"
            old_frame.touch()
            old_sheet.touch()
            video.update({
                "_preview_path": str(old_frame),
                "_contact_sheet_path": str(old_sheet),
                "_frames": [{"timestamp": 0.0, "path": str(old_frame)}],
                "frame_count_mode": "auto",
                "include_endpoints": True,
                "sample_index": 0,
                "content_revision": 2,
            })
            store = media.MediaStore()
            store.sessions["session"] = [video]

            def process(_source, target_dir, **_options):
                new_frame = target_dir / "frame.jpg"
                new_sheet = target_dir / "sheet.jpg"
                new_frame.touch()
                new_sheet.touch()
                return {
                    "_preview_path": str(new_frame),
                    "_contact_sheet_path": str(new_sheet),
                    "_frames": [{"timestamp": 0.0, "path": str(new_frame)}],
                    "frame_count_mode": "4",
                    "frame_count": 4,
                    "include_endpoints": True,
                    "sample_index": 0,
                }

            with patch.object(media, "process_video", side_effect=process):
                result = store.resample("session", "video", "4", True)

            self.assertEqual(result["content_revision"], 3)
            self.assertEqual(result["frame_count_mode"], "4")
            self.assertFalse(old_frame.exists())
            self.assertFalse(old_sheet.exists())
            self.assertTrue(Path(video["_preview_path"]).exists())
            self.assertTrue(Path(video["_contact_sheet_path"]).exists())


if __name__ == "__main__":
    unittest.main()
