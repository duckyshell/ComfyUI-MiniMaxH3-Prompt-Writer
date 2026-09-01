from __future__ import annotations

import unittest

from backend.comfy_state import comfyui_runtime_snapshot


class _Queue:
    def get_current_queue_volatile(self):
        return ([{"prompt_id": "running"}], [{"prompt_id": "pending"}, {"prompt_id": "pending-2"}])


class ComfyStateTests(unittest.TestCase):
    def test_snapshot_reports_queue_and_loaded_model_counts(self):
        snapshot = comfyui_runtime_snapshot(_Queue(), loaded_models_fn=lambda: [object(), object(), object()])

        self.assertEqual(snapshot, {
            "available": True,
            "queue_running": 1,
            "queue_pending": 2,
            "loaded_models": 3,
        })

    def test_snapshot_is_unavailable_outside_comfyui(self):
        self.assertEqual(comfyui_runtime_snapshot(None), {
            "available": False,
            "queue_running": None,
            "queue_pending": None,
            "loaded_models": None,
        })


if __name__ == "__main__":
    unittest.main()
