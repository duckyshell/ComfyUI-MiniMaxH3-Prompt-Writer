import unittest
from unittest.mock import patch

from backend.models.contract import ModelError
from backend.models.gguf_backend import GGUFBackend


def reference_prompt(word_count: int, *, include_soundscape: bool = True) -> str:
    detailed = " ".join(["visible"] * word_count)
    soundscape = "overall_soundscape:\nN/A\n\n" if include_soundscape else ""
    return (
        "subject_definitions:\n<Subject 1> comes from <Picture 1>.\n\n"
        "summary:\n[reference generation] A restrained shot.\n\n"
        "retention_analysis:\n<Subject 1>: fully_preserved.\n\n"
        f"detailed_description:\n[Shot 1] {detailed}\n\n"
        f"{soundscape}"
        "non_diegetic_music:\nN/A"
    )


class _Closer:
    def close(self):
        return None


class _Tokenizer:
    def tokenize(self, _value, add_bos=True):
        return [0] * (12 + int(add_bos))

    def close(self):
        return None


class _ChatHandler:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self._exit_stack = _Closer()

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return self.responses.pop(0)


class _CancelAfterFirstHandler(_ChatHandler):
    def __init__(self, responses, backend):
        super().__init__(responses)
        self.backend = backend

    def __call__(self, **kwargs):
        response_value = super().__call__(**kwargs)
        if len(self.calls) == 1:
            self.backend.cancel_event.set()
        return response_value


class _CharacterizedBackend(GGUFBackend):
    def __init__(self, responses):
        super().__init__()
        self.responses = responses
        self.unload_count = 0

    def load(self, model_info, runtime_plan):
        if self.model is None:
            self.model = _Tokenizer()
            self.chat_handler = _ChatHandler(self.responses)
            self.model_id = model_info["id"]
            self.runtime_signature = (
                model_info["id"],
                runtime_plan["context_tokens"],
                runtime_plan["kv_cache"],
            )

    def unload(self):
        self.unload_count += 1
        super().unload()

    def _logits_processors(self, _stop_if_cancelled):
        return "cancel-sentinel"


def response(text, *, prompt_tokens, completion_tokens, finish_reason="stop"):
    return {
        "choices": [{"message": {"content": text}, "finish_reason": finish_reason}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
        },
    }


def runtime_plan(*, thinking=False):
    return {
        "context_profile": "standard",
        "context_tokens": 16_384,
        "kv_cache": "q8",
        "max_output_tokens": 6_144 if thinking else 1_536,
        "thinking_budget_reduced": False,
    }


def model_info():
    return {
        "id": "characterization-model",
        "capabilities": {"images": True, "video_frames": True, "audio": False},
    }


class GenerationCharacterizationTests(unittest.TestCase):
    def test_non_thinking_length_response_is_rejected_instead_of_returned_truncated(self):
        backend = _CharacterizedBackend([
            response("subject_definitions:\n<Subject 1> is", prompt_tokens=10, completion_tokens=1, finish_reason="length"),
        ])
        assembled = {
            "messages": [{"role": "user", "content": "Create a static scene."}],
            "media_inputs": [],
            "input": {
                "mode": "T2VA",
                "duration_seconds": 5,
                "creative_brief": "Create a static scene.",
            },
        }

        with self.assertRaises(ModelError) as raised:
            backend.generate(
                model_info(),
                assembled,
                "characterization-session",
                thinking=False,
                seed=None,
                unload_after=False,
                runtime_plan=runtime_plan(),
            )

        self.assertEqual(raised.exception.code, "GENERATION_TRUNCATED")

    def test_thinking_fallback_preserves_calls_metrics_and_result_schema(self):
        backend = _CharacterizedBackend([
            response("", prompt_tokens=10, completion_tokens=5, finish_reason="length"),
            response("FINAL PROMPT", prompt_tokens=11, completion_tokens=3),
        ])
        assembled = {
            "messages": [
                {"role": "system", "content": "system guide"},
                {"role": "user", "content": "Create a static scene."},
            ],
            "media_inputs": [],
            "input": {
                "mode": "T2VA",
                "duration_seconds": 5,
                "creative_brief": "Create a static scene.",
            },
        }

        result = backend.generate(
            model_info(),
            assembled,
            "characterization-session",
            thinking=True,
            seed=42,
            unload_after=False,
            runtime_plan=runtime_plan(thinking=True),
        )

        self.assertEqual(result["prompt"], "FINAL PROMPT")
        self.assertTrue(result["thinking_fallback"])
        self.assertEqual(result["thinking_attempt_tokens"], 5)
        self.assertEqual(result["primary_finish_reason"], "length")
        self.assertEqual(result["input_tokens"], 11)
        self.assertEqual(result["output_tokens"], 8)
        self.assertEqual(result["prompt_audit"]["mode"], "T2VA")
        self.assertEqual(result["format_repair_attempted"], False)
        self.assertEqual(result["cold_start"], True)
        self.assertEqual(result["context_profile"], "standard")
        self.assertEqual(result["kv_cache"], "q8")
        self.assertEqual(result["max_output_tokens"], 6_144)
        self.assertEqual(backend.unload_count, 0)

        first, fallback = backend.chat_handler.calls
        self.assertTrue(first["enable_thinking"])
        self.assertEqual(first["max_tokens"], 6_144)
        self.assertEqual(first["temperature"], 1.0)
        self.assertEqual(first["top_p"], 0.95)
        self.assertEqual(first["top_k"], 64)
        self.assertEqual(first["seed"], 42)
        self.assertEqual(first["logits_processor"], "cancel-sentinel")
        self.assertFalse(fallback["enable_thinking"])
        self.assertEqual(fallback["max_tokens"], 1_536)
        self.assertEqual(
            set(result),
            {
                "prompt", "prompt_audit", "input_tokens", "output_tokens",
                "generation_seconds", "media_processing_seconds",
                "visual_input_count", "video_frame_count", "video_sheet_count",
                "vision_budget_applied", "estimated_input_tokens",
                "reserved_output_tokens", "debug_input_sequence",
                "thinking_fallback", "thinking_attempt_tokens",
                "primary_finish_reason", "format_repair_attempted",
                "format_repair_applied", "format_repair_reason",
                "format_repair_failure", "format_repair_method",
                "format_repair_multimodal", "format_repair_tokens", "seed", "cold_start",
                "model_load_seconds", "tokens_per_second", "context_profile",
                "context_tokens", "kv_cache", "max_output_tokens",
                "thinking_budget_reduced",
            },
        )

    def test_reference_repair_is_one_text_only_completion_and_preserves_metrics(self):
        initial = reference_prompt(340, include_soundscape=False)
        repaired = reference_prompt(340)
        backend = _CharacterizedBackend([
            response(initial, prompt_tokens=20, completion_tokens=30),
            response(repaired, prompt_tokens=21, completion_tokens=7),
        ])
        assembled = {
            "messages": [
                {"role": "system", "content": "reference guide"},
                {"role": "user", "content": "Use <Picture 1> as <Subject 1>."},
            ],
            "media_inputs": [],
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "Use Picture 1 as Subject 1.",
            },
        }

        result = backend.generate(
            model_info(),
            assembled,
            "characterization-session",
            thinking=False,
            seed=7,
            unload_after=False,
            runtime_plan=runtime_plan(),
        )

        self.assertEqual(result["prompt"], repaired)
        self.assertTrue(result["format_repair_attempted"])
        self.assertTrue(result["format_repair_applied"])
        self.assertEqual(result["format_repair_method"], "narrow text correction")
        self.assertEqual(result["format_repair_tokens"], 7)
        self.assertEqual(result["input_tokens"], 41)
        self.assertEqual(result["output_tokens"], 37)
        self.assertFalse(result["prompt_audit"]["repair_required"])
        self.assertEqual(len(backend.chat_handler.calls), 2)

        repair_call = backend.chat_handler.calls[1]
        self.assertEqual(repair_call["temperature"], 0.3)
        self.assertEqual(repair_call["top_p"], 0.9)
        self.assertEqual(repair_call["top_k"], 40)
        self.assertEqual(repair_call["max_tokens"], 1_536)
        self.assertFalse(repair_call["enable_thinking"])
        self.assertTrue(all(isinstance(message["content"], str) for message in repair_call["messages"]))

    def test_valid_reference_prompt_is_returned_unchanged_without_repair(self):
        original = reference_prompt(340)
        backend = _CharacterizedBackend([
            response(original, prompt_tokens=20, completion_tokens=30),
        ])
        assembled = {
            "messages": [
                {"role": "system", "content": "reference guide"},
                {"role": "user", "content": "Use <Picture 1> as <Subject 1>."},
            ],
            "media_inputs": [],
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "Use Picture 1 as Subject 1.",
            },
        }

        result = backend.generate(
            model_info(), assembled, "characterization-session",
            thinking=False, seed=7, unload_after=False, runtime_plan=runtime_plan(),
        )

        self.assertEqual(result["prompt"], original)
        self.assertFalse(result["format_repair_attempted"])
        self.assertFalse(result["format_repair_multimodal"])
        self.assertEqual(len(backend.chat_handler.calls), 1)

    def test_missing_active_reference_uses_one_multimodal_continuation_repair(self):
        initial = reference_prompt(340)
        repaired = initial.replace(
            "<Subject 1> comes from <Picture 1>.",
            "<Subject 1> comes from <Picture 1>, with background detail from <Picture 2>.",
        )
        backend = _CharacterizedBackend([
            response(initial, prompt_tokens=20, completion_tokens=30),
            response(repaired, prompt_tokens=35, completion_tokens=9),
        ])
        assembled = {
            "messages": [
                {"role": "system", "content": "reference guide"},
                {"role": "user", "content": "Use active <Picture 1> and <Picture 2>."},
            ],
            "media_inputs": [
                {"type": "image", "asset_id": "one", "reference": "<Picture 1>", "requires_capability": "images"},
                {"type": "image", "asset_id": "two", "reference": "<Picture 2>", "requires_capability": "images"},
            ],
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "Create a story from all active references.",
            },
        }
        original_multimodal_messages = [
            {"role": "system", "content": "reference guide"},
            {"role": "user", "content": [
                {"type": "text", "text": "<Picture 1>: image reference."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,one"}},
                {"type": "text", "text": "<Picture 2>: image reference."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,two"}},
                {"type": "text", "text": "Use active <Picture 1> and <Picture 2>."},
            ]},
        ]
        media_metrics = {
            "visual_input_count": 2, "video_frame_count": 0, "video_sheet_count": 0,
            "vision_budget_applied": False, "estimated_input_tokens": 700,
            "reserved_output_tokens": 2048, "debug_input_sequence": [],
        }

        with patch("backend.h3_pipeline._messages", return_value=(original_multimodal_messages, media_metrics)):
            result = backend.generate(
                model_info(), assembled, "characterization-session",
                thinking=False, seed=8, unload_after=False, runtime_plan=runtime_plan(),
            )

        self.assertEqual(result["prompt"], repaired)
        self.assertTrue(result["format_repair_applied"])
        self.assertTrue(result["format_repair_multimodal"])
        self.assertEqual(result["format_repair_method"], "multimodal reference correction")
        self.assertEqual(result["input_tokens"], 55)
        self.assertEqual(result["output_tokens"], 39)
        self.assertEqual(len(backend.chat_handler.calls), 2)
        repair_messages = backend.chat_handler.calls[1]["messages"]
        self.assertEqual(repair_messages[:2], original_multimodal_messages)
        self.assertEqual(repair_messages[2], {"role": "assistant", "content": initial})
        self.assertIn("missing reference tags: <Picture 2>", repair_messages[3]["content"])
        self.assertEqual(
            sum(part.get("type") == "image_url" for part in repair_messages[1]["content"]),
            2,
        )

    def test_failed_multimodal_repair_keeps_original_prompt(self):
        initial = reference_prompt(340)
        backend = _CharacterizedBackend([
            response(initial, prompt_tokens=20, completion_tokens=30),
            response(initial, prompt_tokens=35, completion_tokens=9),
        ])
        assembled = {
            "messages": [
                {"role": "system", "content": "reference guide"},
                {"role": "user", "content": "Use <Picture 1> and <Picture 2>."},
            ],
            "media_inputs": [
                {"type": "image", "asset_id": "one", "reference": "<Picture 1>", "requires_capability": "images"},
            ],
            "input": {"mode": "Reference", "duration_seconds": 10, "creative_brief": "Use both."},
        }
        fake_messages = [
            {"role": "system", "content": "reference guide"},
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,one"}}]},
        ]
        metrics = {
            "visual_input_count": 1, "video_frame_count": 0, "video_sheet_count": 0,
            "vision_budget_applied": False, "estimated_input_tokens": 400,
            "reserved_output_tokens": 2048, "debug_input_sequence": [],
        }

        with patch("backend.h3_pipeline._messages", return_value=(fake_messages, metrics)):
            result = backend.generate(
                model_info(), assembled, "characterization-session",
                thinking=False, seed=9, unload_after=False, runtime_plan=runtime_plan(),
            )

        self.assertEqual(result["prompt"], initial)
        self.assertFalse(result["format_repair_applied"])
        self.assertTrue(result["format_repair_multimodal"])
        self.assertIn("still failed", result["format_repair_failure"])

    def test_truncated_repair_is_rejected_even_if_partial_text_passes_audit(self):
        initial = reference_prompt(340, include_soundscape=False)
        seemingly_valid = reference_prompt(340)
        backend = _CharacterizedBackend([
            response(initial, prompt_tokens=20, completion_tokens=30),
            response(seemingly_valid, prompt_tokens=25, completion_tokens=1536, finish_reason="length"),
        ])
        assembled = {
            "messages": [
                {"role": "system", "content": "reference guide"},
                {"role": "user", "content": "Use <Picture 1> as <Subject 1>."},
            ],
            "media_inputs": [],
            "input": {"mode": "Reference", "duration_seconds": 10, "creative_brief": "Use Picture 1."},
        }

        result = backend.generate(
            model_info(), assembled, "characterization-session",
            thinking=False, seed=11, unload_after=False, runtime_plan=runtime_plan(),
        )

        self.assertEqual(result["prompt"], initial)
        self.assertFalse(result["format_repair_applied"])
        self.assertEqual(result["format_repair_failure"], "repair reached its output limit")

    def test_cancel_between_draft_and_repair_prevents_second_completion(self):
        initial = reference_prompt(340)
        backend = _CharacterizedBackend([])
        backend.load(model_info(), runtime_plan())
        backend.chat_handler = _CancelAfterFirstHandler(
            [response(initial, prompt_tokens=20, completion_tokens=30)],
            backend,
        )
        assembled = {
            "messages": [
                {"role": "system", "content": "reference guide"},
                {"role": "user", "content": "Use <Picture 1> and <Picture 2>."},
            ],
            "media_inputs": [
                {"type": "image", "asset_id": "one", "reference": "<Picture 1>", "requires_capability": "images"},
            ],
            "input": {"mode": "Reference", "duration_seconds": 10, "creative_brief": "Use both."},
        }
        fake_messages = [
            {"role": "system", "content": "reference guide"},
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,one"}}]},
        ]
        metrics = {
            "visual_input_count": 1, "video_frame_count": 0, "video_sheet_count": 0,
            "vision_budget_applied": False, "estimated_input_tokens": 400,
            "reserved_output_tokens": 2048, "debug_input_sequence": [],
        }

        with patch("backend.h3_pipeline._messages", return_value=(fake_messages, metrics)):
            with self.assertRaises(ModelError) as raised:
                backend.generate(
                    model_info(), assembled, "characterization-session",
                    thinking=False, seed=10, unload_after=False, runtime_plan=runtime_plan(),
                )

        self.assertEqual(raised.exception.code, "GENERATION_CANCELLED")
        self.assertEqual(len(backend.chat_handler.calls), 1)

    def test_media_capability_rejection_happens_before_model_load(self):
        backend = _CharacterizedBackend([])
        model = model_info()
        model["capabilities"]["images"] = False
        assembled = {
            "messages": [{"role": "user", "content": "brief"}],
            "media_inputs": [{"type": "image", "requires_capability": "images"}],
            "input": {"mode": "I2VA", "duration_seconds": 5, "creative_brief": "brief"},
        }

        with self.assertRaises(ModelError) as raised:
            backend.generate(
                model,
                assembled,
                "characterization-session",
                thinking=False,
                seed=None,
                unload_after=False,
                runtime_plan=runtime_plan(),
            )

        self.assertEqual(raised.exception.code, "UNSUPPORTED_MEDIA")
        self.assertIsNone(backend.model)


if __name__ == "__main__":
    unittest.main()
