import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from backend import history


class PromptHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "history"
        self.media = Path(self.temp.name) / "media"
        self.media.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def picture(self, name="original.png"):
        path = self.media / name
        Image.new("RGB", (900, 600), "orange").save(path)
        return path

    def test_add_list_and_serve_files(self):
        original = self.picture()
        assets = [
            {"type": "image", "reference": "<Picture 1>", "filename": "cat.png", "_original_path": str(original), "_preview_path": str(original)},
            {"type": "audio", "reference": "<Audio 1>", "filename": "voice.wav"},
        ]
        entry = history.add_entry({"mode": "Reference", "brief": "brief", "prompt": "prompt", "duration": 8}, assets, root=self.root)

        listed = history.list_entries(root=self.root)
        self.assertEqual([item["id"] for item in listed], [entry["id"]])
        public = history.public_entry(listed[0], "/h3studio")
        self.assertEqual(public["assets"][0]["thumb_url"], f"/h3studio/history/{entry['id']}/file/thumb/0")
        self.assertIn("media_url", public["assets"][0])
        self.assertNotIn("thumb_url", public["assets"][1])

        thumb = history.entry_file(entry["id"], "thumb", 0, root=self.root)
        with Image.open(thumb) as image:
            self.assertLessEqual(max(image.size), history.THUMB_SIZE)
        media = history.entry_file(entry["id"], "media", 0, root=self.root)
        self.assertEqual(media.read_bytes(), original.read_bytes())
        with self.assertRaises(history.HistoryError):
            history.entry_file(entry["id"], "media", 1, root=self.root)

    def test_entries_survive_source_media_removal(self):
        original = self.picture()
        entry = history.add_entry({"mode": "I2VA", "prompt": "p"}, [{"type": "image", "_original_path": str(original)}], root=self.root)
        original.unlink()
        self.assertTrue(history.entry_file(entry["id"], "media", 0, root=self.root).is_file())

    def test_rejects_music_and_empty_prompts(self):
        with self.assertRaises(history.HistoryError):
            history.add_entry({"mode": "Music3", "prompt": "p"}, [], root=self.root)
        with self.assertRaises(history.HistoryError):
            history.add_entry({"mode": "T2VA", "prompt": "   "}, [], root=self.root)

    def test_newest_first_and_pruned(self):
        for index in range(history.MAX_ENTRIES + 3):
            history.add_entry({"mode": "T2VA", "prompt": f"p{index}"}, [], root=self.root, now=float(index))
        entries = history.list_entries(root=self.root)
        self.assertEqual(len(entries), history.MAX_ENTRIES)
        self.assertEqual(entries[0]["prompt"], f"p{history.MAX_ENTRIES + 2}")

    def test_delete_clear_and_path_safety(self):
        first = history.add_entry({"mode": "T2VA", "prompt": "a"}, [], root=self.root)
        history.add_entry({"mode": "T2VA", "prompt": "b"}, [], root=self.root)
        history.delete_entry(first["id"], root=self.root)
        self.assertEqual(len(history.list_entries(root=self.root)), 1)
        with self.assertRaises(history.HistoryError):
            history.delete_entry("../../etc", root=self.root)
        self.assertEqual(history.clear_entries(root=self.root), 1)
        self.assertEqual(history.list_entries(root=self.root), [])

    def test_tampered_manifest_cannot_escape_entry_folder(self):
        entry = history.add_entry({"mode": "T2VA", "prompt": "a"}, [], root=self.root)
        manifest = self.root / entry["id"] / "entry.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["assets"] = [{"type": "image", "thumb": "../../secret.txt"}]
        manifest.write_text(json.dumps(data), encoding="utf-8")
        (self.root.parent / "secret.txt").write_text("x")
        with self.assertRaises(history.HistoryError):
            history.entry_file(entry["id"], "thumb", 0, root=self.root)


if __name__ == "__main__":
    unittest.main()
