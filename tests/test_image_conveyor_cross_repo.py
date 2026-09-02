import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest


class _FakeLoadImage:
    calls = []

    def load_image(self, annotated):
        self.calls.append(annotated)
        return f"image:{annotated}", f"mask:{annotated}"


def _load_conveyor(source_root: Path):
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.exists_annotated_filepath = lambda _value: True
    folder_paths.get_annotated_filepath = lambda value: value
    nodes = types.ModuleType("nodes")
    nodes.LoadImage = _FakeLoadImage
    previous = {name: sys.modules.get(name) for name in ("folder_paths", "nodes")}
    sys.modules["folder_paths"] = folder_paths
    sys.modules["nodes"] = nodes
    try:
        spec = importlib.util.spec_from_file_location(
            "reviewed_image_conveyor",
            source_root / "image_conveyor.py",
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


def _item(name):
    return {
        "id": name,
        "annotated": f"{name}.png [input]",
        "filename": f"{name}.png",
        "subfolder": "",
        "source_path": "",
        "type": "input",
        "status": "pending",
        "added_at": 0,
        "last_queued_at": 0,
        "last_processed_at": 0,
    }


def _reference(name):
    return {
        "annotated": f"{name}.png [input]",
        "filename": f"{name}.png",
        "subfolder": "",
        "type": "input",
    }


class ImageConveyorCrossRepositoryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = os.environ.get("IMAGE_CONVEYOR_SOURCE", "").strip()
        if not raw:
            raise unittest.SkipTest("IMAGE_CONVEYOR_SOURCE is not set")
        cls.root = Path(raw)
        cls.conveyor = _load_conveyor(cls.root)

    def setUp(self):
        _FakeLoadImage.calls.clear()

    def test_output_slots_and_aliases_match_prompt_writer_adapter(self):
        self.assertEqual(
            (
                "image",
                "mask",
                "path",
                "index",
                "remaining_pending",
                "source_path",
                "ref_image_1",
                "ref_image_2",
                "ref_image_3",
                "ref_image_4",
                "ref_image_5",
                "ref_image_6",
                "ref_image_7",
                "ref_image_8",
                "last_frame",
            ),
            self.conveyor.ImageConveyor.RETURN_NAMES,
        )
        self.assertIs(
            self.conveyor.NODE_CLASS_MAPPINGS["ImageConveyor"],
            self.conveyor.NODE_CLASS_MAPPINGS["SequentialBatchImageLoader"],
        )
        self.assertEqual(8, self.conveyor._REFERENCE_SLOT_COUNT)
        self.assertEqual(9, self.conveyor._MAX_IMAGES_PER_EXECUTION)
        self.assertEqual("persistent_refs", self.conveyor._OUTPUT_MODE_PERSISTENT)
        self.assertEqual("queue_group", self.conveyor._OUTPUT_MODE_QUEUE_GROUP)

    def test_persistent_reference_outputs_are_fixed_shelf_slots_and_empty_slots_are_none(self):
        state = self.conveyor._default_state()
        state["output_mode"] = "persistent_refs"
        state["reference_slots"] = [_reference("one"), None, _reference("three"), *([None] * 5)]
        queued = json.dumps({
            "reference_output_slots": [1, 2],
            "queue_output_slots": [],
            "main_output_enabled": False,
        })
        result = self.conveyor.ImageConveyor().load_next(
            json.dumps(state),
            queue_item_json=queued,
        )["result"]
        self.assertEqual("image:one.png [input]", result[6])
        self.assertIsNone(result[7])
        self.assertIsNone(result[8])
        self.assertIsNone(result[0])
        self.assertIsNone(result[14])

    def test_queue_group_mapping_matches_images_per_execution_and_last_frame_alias(self):
        state = self.conveyor._default_state()
        state["output_mode"] = "queue_group"
        state["images_per_execution"] = 3
        state["dont_consume"] = True
        state["items"] = [_item("A"), _item("B"), _item("C")]
        queued = json.dumps({
            "id": "A",
            "annotated": "A.png [input]",
            "items": [
                {"id": "A", "annotated": "A.png [input]"},
                {"id": "B", "annotated": "B.png [input]"},
                {"id": "C", "annotated": "C.png [input]"},
            ],
        })
        result = self.conveyor.ImageConveyor().load_next(
            json.dumps(state),
            queue_item_json=queued,
        )["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual("image:B.png [input]", result[6])
        self.assertEqual("image:C.png [input]", result[7])
        self.assertIsNone(result[8])
        self.assertEqual(result[6], result[14])

    def test_frontend_toggle_property_and_snapshot_names_are_pinned(self):
        reference_source = (self.root / "web" / "image_conveyor_reference_toggles.js").read_text("utf-8")
        last_frame_source = (self.root / "web" / "image_conveyor_last_frame_toggle.js").read_text("utf-8")
        sync_source = (self.root / "web" / "image_conveyor_toggle_state_sync.js").read_text("utf-8")
        math_source = (self.root / "web" / "image_conveyor_toggle_state_math.mjs").read_text("utf-8")
        for token in (
            "image_conveyor_reference_enabled",
            "image_conveyor_main_enabled",
            "reference_output_enabled",
            "main_output_enabled",
        ):
            self.assertIn(token, reference_source)
        self.assertIn("image_conveyor_last_frame_enabled", last_frame_source)
        self.assertIn("image_conveyor_last_frame_enabled", sync_source)
        for token in (
            "last_frame_output_enabled",
            "queue_output_slots",
            "reference_output_slots",
        ):
            self.assertIn(token, math_source)


if __name__ == "__main__":
    unittest.main()
