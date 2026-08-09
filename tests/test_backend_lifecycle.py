import unittest

from backend.models.gguf_backend import GGUFBackend


class BackendLifecycleTests(unittest.TestCase):
    def test_cancel_is_retained_before_model_exists(self):
        backend = GGUFBackend()
        self.assertTrue(backend.cancel())
        self.assertTrue(backend.cancel_event.is_set())

    def test_prepare_request_clears_previous_cancel(self):
        backend = GGUFBackend()
        backend.cancel()
        backend.prepare_request()
        self.assertFalse(backend.cancel_event.is_set())

    def test_unload_request_sets_cancel_and_force_flags(self):
        backend = GGUFBackend()
        self.assertTrue(backend.request_unload())
        self.assertTrue(backend.cancel_event.is_set())
        self.assertTrue(backend.force_unload_event.is_set())


if __name__ == "__main__":
    unittest.main()
