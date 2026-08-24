from enum import IntEnum
from contextlib import redirect_stderr
from io import StringIO
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.models import gguf_backend
from backend.native_logging import suppress_known_llama_noise
from backend.models.contract import ModelError
from backend.models.gguf_backend import GGUFBackend


def runtime_plan():
    return {
        "context_profile": "standard",
        "context_tokens": 16_384,
        "kv_cache": "q8",
        "max_output_tokens": 1_536,
        "thinking_budget_reduced": False,
    }


def model_info(*, ready=True, projector="mmproj.gguf"):
    return {
        "id": "verified-gemma4",
        "family": "gguf",
        "path": "model.gguf",
        "projector": projector,
        "architecture_adapter": "gemma",
        "template_controls": {"enable_thinking": True, "reasoning_effort": False},
        "thinking": True,
        "runtime_ready": ready,
        "missing_dependencies": [],
        "capabilities": {
            "images": projector is not None,
            "video_frames": projector is not None,
            "audio": False,
        },
    }


class _FakeModel:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False
        self.__class__.instances.append(self)

    def close(self):
        self.closed = True

    def token_eos(self):
        return 1


class _Closer:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class _FakeVisionHandler:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self._exit_stack = _Closer()
        self._mtmd_cpp = _FakeMTMD
        self.__class__.instances.append(self)


class _FakeMTMD:
    callbacks = {}

    @classmethod
    def mtmd_log_set(cls, callback, _user_data):
        cls.callbacks["mtmd"] = callback

    @classmethod
    def mtmd_helper_log_set(cls, callback, _user_data):
        cls.callbacks["helper"] = callback


class _FakeGGMLType(IntEnum):
    GGML_TYPE_F16 = 1
    GGML_TYPE_Q8_0 = 2


class DirectMusicRuntimeTests(unittest.TestCase):
    def setUp(self):
        _FakeModel.instances = []
        _FakeVisionHandler.instances = []
        _FakeMTMD.callbacks = {}

    def fake_modules(self, *, top_level_ggml_types=True):
        llama_cpp = types.ModuleType("llama_cpp")
        llama_cpp.Llama = _FakeModel
        llama_cpp.llama_log_callback = lambda callback: callback
        chat_format = types.ModuleType("llama_cpp.llama_chat_format")
        chat_format.MTMDChatHandler = _FakeVisionHandler
        modules = {"llama_cpp": llama_cpp, "llama_cpp.llama_chat_format": chat_format}
        if top_level_ggml_types:
            llama_cpp.GGML_TYPE_F16 = _FakeGGMLType.GGML_TYPE_F16.value
            llama_cpp.GGML_TYPE_Q8_0 = _FakeGGMLType.GGML_TYPE_Q8_0.value
        else:
            llama_cpp.__path__ = []
            ggml = types.ModuleType("llama_cpp._ggml")
            ggml.GGMLType = _FakeGGMLType
            modules["llama_cpp._ggml"] = ggml
        return modules

    def test_text_only_load_skips_projector_but_h3_load_keeps_it(self):
        backend = GGUFBackend()
        with patch.dict(sys.modules, self.fake_modules()):
            backend.load(model_info(), runtime_plan(), text_only=True)
            text_model = _FakeModel.instances[-1]
            self.assertNotIn("chat_handler", text_model.kwargs)
            self.assertIsNone(backend.chat_handler)
            self.assertEqual(_FakeVisionHandler.instances, [])
            self.assertEqual(backend.runtime_signature[-1], "text")

            backend.load(model_info(), runtime_plan(), text_only=False)
            multimodal_model = _FakeModel.instances[-1]
            self.assertTrue(text_model.closed)
            self.assertIs(multimodal_model.kwargs["chat_handler"], backend.chat_handler)
            self.assertEqual(len(_FakeVisionHandler.instances), 1)
            self.assertEqual(backend.chat_handler.kwargs["clip_model_path"], "mmproj.gguf")
            self.assertEqual(backend.runtime_signature[-1], "multimodal")
            self.assertEqual(set(_FakeMTMD.callbacks), {"mtmd", "helper"})

    def test_qwen_preflight_reuses_cpu_vocab_only_tokenizer(self):
        instances = []

        class FakeTokenizerClient:
            def __init__(self, path):
                resolved = Path(path).resolve()
                stat = resolved.stat()
                self.identity = (str(resolved), stat.st_size, stat.st_mtime_ns)
                self.counts = []
                self.closed = False
                instances.append(self)

            def count(self, text):
                self.counts.append(text)
                return 400

            def close(self):
                self.closed = True

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "qwen.gguf"
            path.write_bytes(b"fixture")
            info = {
                **model_info(projector=None),
                "path": str(path),
                "architecture_adapter": "qwen35",
                "runtime_ready": True,
                "context_profiles": ["standard", "extended", "large", "maximum"],
                "auto_context_ladder": True,
                "native_context_tokens": 262_144,
            }
            assembled = {
                "messages": [{"role": "user", "content": "brief"}],
                "media_inputs": [],
                "input": {"mode": "T2VA", "creative_brief": "brief"},
            }
            backend = GGUFBackend()

            with patch.object(gguf_backend, "VocabOnlyTokenizerClient", FakeTokenizerClient):
                first = backend.preflight(
                    info, assembled, context_profile="auto", kv_cache="auto", thinking=False,
                )
                second = backend.preflight(
                    info, assembled, context_profile="auto", kv_cache="auto", thinking=False,
                )

        self.assertEqual(len(instances), 1)
        self.assertEqual(len(instances[0].counts), 2)
        self.assertEqual(first["text_token_source"], "vocab_only")
        self.assertEqual(second["estimated_text_tokens"], 400)

    def test_qwen3vl_preflight_uses_exact_vocab_only_counting(self):
        info = {
            **model_info(projector=None),
            "architecture_adapter": "qwen3vl",
            "context_profiles": ["standard", "extended", "large", "maximum"],
            "auto_context_ladder": True,
            "native_context_tokens": 262_144,
        }
        assembled = {
            "messages": [{"role": "user", "content": "brief"}],
            "media_inputs": [],
            "input": {"mode": "T2VA", "creative_brief": "brief"},
        }
        backend = GGUFBackend()

        with patch.object(backend, "_count_preflight_text_tokens", return_value=321) as count:
            result = backend.preflight(
                info, assembled, context_profile="auto", kv_cache="auto", thinking=False,
            )

        count.assert_called_once()
        self.assertEqual(result["text_token_source"], "vocab_only")
        self.assertEqual(result["estimated_text_tokens"], 321)

    def test_mtmd_logging_suppresses_info_and_keeps_warnings_and_errors(self):
        with (
            patch.dict(sys.modules, self.fake_modules()),
            patch.object(gguf_backend, "_MTMD_LOG_CALLBACK", None),
            patch.object(gguf_backend, "_MTMD_LAST_LOG_LEVEL", 0),
        ):
            gguf_backend._configure_mtmd_logging(_FakeMTMD)
            callback = _FakeMTMD.callbacks["mtmd"]
            output = StringIO()
            with redirect_stderr(output), gguf_backend._quiet_mtmd_info():
                callback(2, b"PRIVATE_PROMPT_CONTENT\n", None)
                callback(2, b"encoding image slice...\n", None)
                callback(3, b"vision memory is low\n", None)
                callback(4, b"vision evaluation failed\n", None)
            with redirect_stderr(output):
                callback(1, b"OTHER_NODE_INFO\n", None)

        console = output.getvalue()
        self.assertNotIn("PRIVATE_PROMPT_CONTENT", console)
        self.assertNotIn("encoding image slice", console)
        self.assertIn("[H3 Prompt Writer] MTMD warning: vision memory is low", console)
        self.assertIn("[H3 Prompt Writer] MTMD error: vision evaluation failed", console)
        self.assertIn("OTHER_NODE_INFO", console)

    def test_native_log_filter_removes_only_known_llama_noise(self):
        output = StringIO()
        with redirect_stderr(output), suppress_known_llama_noise():
            print("find_slot: non-consecutive token position 7298 after 6751", file=sys.stderr)
            print("llama_context: n_ctx_seq (512) > n_ctx_train (0) -- possible training context overflow", file=sys.stderr)
            print("real llama warning", file=sys.stderr)

        console = output.getvalue()
        self.assertNotIn("find_slot", console)
        self.assertNotIn("n_ctx_train (0)", console)
        self.assertIn("real llama warning", console)

    def test_text_only_load_keeps_verified_runtime_validation(self):
        backend = GGUFBackend()
        with self.assertRaises(ModelError) as raised:
            backend.load(model_info(ready=False), runtime_plan(), text_only=True)
        self.assertEqual(raised.exception.code, "MODEL_DEPENDENCY_MISSING")
        self.assertIsNone(backend.model)

    def test_load_accepts_ggml_types_from_newer_private_namespace(self):
        backend = GGUFBackend()
        with patch.dict(sys.modules, self.fake_modules(top_level_ggml_types=False)):
            backend.load(model_info(), runtime_plan(), text_only=True)
        model = _FakeModel.instances[-1]
        self.assertEqual(model.kwargs["type_k"], _FakeGGMLType.GGML_TYPE_Q8_0.value)
        self.assertEqual(model.kwargs["type_v"], _FakeGGMLType.GGML_TYPE_Q8_0.value)

    def test_generate_selects_text_only_for_music_or_missing_projector(self):
        selections = []

        def exercise(mode, info):
            backend = GGUFBackend()

            def fake_load(info, plan, *, text_only=False):
                selections.append((mode, text_only))
                backend.model = _FakeModel()
                backend.model_id = info["id"]
                backend.runtime_signature = (
                    info["id"], plan["context_tokens"], plan["kv_cache"],
                    "text" if text_only else "multimodal",
                )

            assembled = {
                "messages": [{"role": "user", "content": "brief"}],
                "media_inputs": [],
                "input": {"mode": mode, "duration_seconds": None, "creative_brief": "brief"},
            }
            with (
                patch.object(backend, "load", side_effect=fake_load),
                patch.object(backend, "_logits_processors", return_value=[]),
                patch.object(backend, "_console"),
                patch("backend.models.gguf_backend.run_h3_pipeline", return_value={"prompt": "result"}),
            ):
                backend.generate(
                    info, assembled, "session",
                    thinking=False, seed=1, unload_after=False, runtime_plan=runtime_plan(),
                )

        exercise("Music3", model_info())
        exercise("T2VA", model_info())
        exercise("T2VA", model_info(projector=None))
        self.assertEqual(selections, [("Music3", True), ("T2VA", False), ("T2VA", True)])

    def test_text_only_direct_model_rejects_non_t2va_mode_before_load(self):
        backend = GGUFBackend()
        assembled = {
            "messages": [{"role": "user", "content": "brief"}],
            "media_inputs": [],
            "input": {"mode": "Music3", "creative_brief": "brief"},
        }

        with self.assertRaises(ModelError) as raised:
            backend.generate(
                model_info(projector=None), assembled, "session",
                thinking=False, seed=1, unload_after=False, runtime_plan=runtime_plan(),
            )

        self.assertEqual(raised.exception.code, "DIRECT_VISION_REQUIRED")
        self.assertEqual(raised.exception.details["supported_modes"], ["T2VA"])
        self.assertIsNone(backend.model)

    def test_direct_model_without_template_control_rejects_thinking_before_load(self):
        backend = GGUFBackend()
        info = model_info(projector=None)
        info["thinking"] = False
        info["template_controls"] = {"enable_thinking": False, "reasoning_effort": False}
        assembled = {
            "messages": [{"role": "user", "content": "brief"}],
            "media_inputs": [],
            "input": {"mode": "T2VA", "creative_brief": "brief"},
        }

        with self.assertRaises(ModelError) as raised:
            backend.generate(
                info, assembled, "session",
                thinking=True, seed=1, unload_after=False, runtime_plan=runtime_plan(),
            )

        self.assertEqual(raised.exception.code, "DIRECT_THINKING_UNAVAILABLE")
        self.assertIsNone(backend.model)

    def test_direct_console_reports_lifecycle_without_prompt_content(self):
        backend = GGUFBackend()
        assembled = {
            "messages": [{"role": "user", "content": "PRIVATE_PROMPT_CONTENT"}],
            "media_inputs": [
                {"type": "image", "asset_id": "one", "requires_capability": "images"},
                {"type": "video", "asset_id": "two", "requires_capability": "video_frames"},
            ],
            "input": {"mode": "Reference", "creative_brief": "PRIVATE_PROMPT_CONTENT"},
        }
        plan = {**runtime_plan(), "context_tokens": 24_576, "max_output_tokens": 2_048}

        def fake_load(info, active_plan, *, text_only=False):
            backend.model = _FakeModel()
            backend.model_id = info["id"]
            backend.runtime_signature = (
                info["id"], active_plan["context_tokens"], active_plan["kv_cache"],
                "text" if text_only else "multimodal",
            )

        def fake_pipeline(*_args, on_phase, **_kwargs):
            on_phase("processing_media")
            on_phase("generating")
            return {
                "prompt": "PRIVATE_GENERATED_PROMPT",
                "output_tokens": 781,
                "tokens_per_second": 42.6,
                "generation_seconds": 18.3,
                "format_repair_attempted": True,
                "format_repair_applied": True,
                "format_repair_tokens": 412,
            }

        output = StringIO()
        with (
            patch.object(backend, "load", side_effect=fake_load),
            patch.object(backend, "_logits_processors", return_value=[]),
            patch("backend.models.gguf_backend.run_h3_pipeline", side_effect=fake_pipeline),
            redirect_stderr(output),
        ):
            backend.generate(
                {**model_info(), "name": "Gemma 4 26B Q4_K_M"},
                assembled,
                "session",
                thinking=False,
                seed=1,
                unload_after=False,
                runtime_plan=plan,
            )

        console = output.getvalue()
        self.assertIn("Direct GGUF · Gemma 4 26B Q4_K_M", console)
        self.assertIn("Loaded in", console)
        self.assertIn("context 24K · KV Q8", console)
        self.assertIn("Prepared 2 visual references", console)
        self.assertIn("Generating · Thinking off · max output 2048", console)
        self.assertIn("Reference correction applied · 412 tokens", console)
        self.assertIn("Done · 781 tokens · 42.6 tok/s · 18.3s", console)
        self.assertNotIn("PRIVATE_PROMPT_CONTENT", console)
        self.assertNotIn("PRIVATE_GENERATED_PROMPT", console)

    def test_direct_console_reports_output_limit_without_prompt_content(self):
        backend = GGUFBackend()
        assembled = {
            "messages": [{"role": "user", "content": "PRIVATE_PROMPT_CONTENT"}],
            "media_inputs": [],
            "input": {"mode": "T2VA", "creative_brief": "PRIVATE_PROMPT_CONTENT"},
        }

        def fake_load(info, active_plan, *, text_only=False):
            backend.model = _FakeModel()
            backend.model_id = info["id"]
            backend.runtime_signature = (
                info["id"], active_plan["context_tokens"], active_plan["kv_cache"], "multimodal",
            )

        output = StringIO()
        with (
            patch.object(backend, "load", side_effect=fake_load),
            patch.object(backend, "_logits_processors", return_value=[]),
            patch(
                "backend.models.gguf_backend.run_h3_pipeline",
                side_effect=ModelError(
                    "GENERATION_TRUNCATED",
                    "PRIVATE_PROMPT_CONTENT",
                    {"max_output_tokens": 2_048},
                ),
            ),
            redirect_stderr(output),
            self.assertRaises(ModelError),
        ):
            backend.generate(
                model_info(), assembled, "session", thinking=False, seed=1,
                unload_after=False, runtime_plan={**runtime_plan(), "max_output_tokens": 2_048},
            )

        console = output.getvalue()
        self.assertIn("Error: output limit reached · 2048 tokens", console)
        self.assertNotIn("PRIVATE_PROMPT_CONTENT", console)

    def test_direct_console_does_not_print_arbitrary_error_details(self):
        backend = GGUFBackend()
        output = StringIO()

        with redirect_stderr(output):
            backend._console_error(
                ModelError("GENERATION_FAILED", "PRIVATE_PROMPT_CONTENT", "PRIVATE_EXCEPTION_DETAIL"),
                runtime_plan(),
            )

        console = output.getvalue()
        self.assertIn("Error: generation failed", console)
        self.assertNotIn("PRIVATE_PROMPT_CONTENT", console)
        self.assertNotIn("PRIVATE_EXCEPTION_DETAIL", console)


if __name__ == "__main__":
    unittest.main()
