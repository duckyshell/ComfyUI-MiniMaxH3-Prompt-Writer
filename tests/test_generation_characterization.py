import threading
import unittest
from unittest.mock import patch

from backend.models.contract import ModelError
from backend.h3_pipeline import _audit
from backend.models.gguf_backend import GGUFBackend, _cancel_to_eos


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


def reference_manifest(*references: str) -> dict:
    return {
        "assets": [
            {
                "id": f"asset-{index}",
                "type": "audio" if reference.startswith("<Audio ") else "video" if reference.startswith("<Video ") else "image",
                "reference": reference,
            }
            for index, reference in enumerate(references, 1)
        ]
    }


class _Closer:
    def close(self):
        return None


class _Tokenizer:
    def tokenize(self, _value, add_bos=True):
        return [0] * (12 + int(add_bos))

    def token_eos(self):
        return 1

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

    def load(self, model_info, runtime_plan, *, text_only=False):
        if self.model is None:
            self.model = _Tokenizer()
            self.chat_handler = _ChatHandler(self.responses)
            self.model_id = model_info["id"]
            self.runtime_signature = (
                model_info["id"],
                runtime_plan["context_tokens"],
                runtime_plan["kv_cache"],
                "text" if text_only else "multimodal",
            )

    def unload(self):
        self.unload_count += 1
        super().unload()

    def _logits_processors(self, _stop_if_cancelled):
        return "cancel-sentinel"

    def _console(self, _message):
        return None


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
        "max_output_tokens": 6_144 if thinking else 2_048,
        "thinking_budget_reduced": False,
    }


def model_info():
    return {
        "id": "characterization-model",
        "capabilities": {"images": True, "video_frames": True, "audio": False},
    }


class GenerationCharacterizationTests(unittest.TestCase):
    def test_cancel_logits_processor_forces_eos_without_raising_from_native_callback(self):
        cancel_event = threading.Event()

        class _Scores:
            def __init__(self):
                self.assignments = []

            def __setitem__(self, key, value):
                self.assignments.append((key, value))

        scores = _Scores()
        processor = _cancel_to_eos(cancel_event, 7)
        self.assertIs(processor([], scores), scores)
        self.assertEqual(scores.assignments, [])

        cancel_event.set()
        self.assertIs(processor([], scores), scores)
        self.assertEqual(scores.assignments[0], (slice(None), float("-inf")))
        self.assertEqual(scores.assignments[1], (7, 0.0))

    def test_unmentioned_uploaded_audio_is_allowed_but_not_required_by_audit(self):
        assembled = {
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "Use Picture 1 for the character. The uploaded audio needs no role.",
                "media_manifest": reference_manifest("<Picture 1>", "<Audio 1>", "<Audio 2>"),
            },
        }
        without_audio, policy, *_ = _audit(reference_prompt(340), assembled)
        with_optional_audio, *_ = _audit(reference_prompt(340).replace(
            "<Subject 1> comes from <Picture 1>.",
            "<Subject 1> comes from <Picture 1>. <Audio 1> is available.",
        ), assembled)

        self.assertEqual(policy.required, {"<Picture 1>"})
        self.assertEqual(policy.mutable, set())
        self.assertEqual(policy.allowed, {"<Picture 1>", "<Audio 1>", "<Audio 2>"})
        self.assertEqual(without_audio["missing_reference_tags"], [])
        self.assertFalse(without_audio["repair_required"])
        self.assertEqual(with_optional_audio["unexpected_reference_tags"], [])

    def test_exact_canonical_audio_tag_in_brief_is_required_independent_of_surrounding_text(self):
        base_input = {
            "mode": "Reference",
            "duration_seconds": 10,
            "media_manifest": reference_manifest("<Picture 1>", "<Video 1>", "<Audio 1>"),
        }
        untagged, untagged_policy, *_ = _audit(reference_prompt(340), {
            "input": {**base_input, "creative_brief": "zibble frobnitz audio-one quux"},
        })
        canonical, canonical_policy, *_ = _audit(reference_prompt(340), {
            "input": {**base_input, "creative_brief": "zibble <Audio 1> frobnitz quux"},
        })

        self.assertEqual(untagged_policy.required, {"<Picture 1>", "<Video 1>"})
        self.assertEqual(untagged["missing_reference_tags"], ["<Video 1>"])
        self.assertEqual(canonical_policy.required, {"<Picture 1>", "<Video 1>", "<Audio 1>"})
        self.assertEqual(canonical["missing_reference_tags"], ["<Audio 1>", "<Video 1>"])

    def test_refine_preserves_existing_audio_not_named_by_instruction(self):
        current_prompt = reference_prompt(340).replace(
            "<Subject 1> comes from <Picture 1>.",
            "<Subject 1> comes from <Picture 1>. <Audio 1> is its voice reference.",
        )
        assembled = {
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "Use Picture 1 for the character.",
                "current_prompt": current_prompt,
                "instruction": "zibble frobnitz quux",
                "media_manifest": reference_manifest("<Picture 1>", "<Audio 1>"),
            },
        }

        audit, policy, *_ = _audit(reference_prompt(340), assembled)

        self.assertEqual(policy.required, {"<Picture 1>", "<Audio 1>"})
        self.assertEqual(policy.mutable, set())
        self.assertEqual(audit["missing_reference_tags"], ["<Audio 1>"])

    def test_refine_audio_named_by_instruction_is_mutable_regardless_of_surrounding_text(self):
        current_prompt = reference_prompt(340).replace(
            "<Subject 1> comes from <Picture 1>.",
            "<Subject 1> comes from <Picture 1>. <Audio 1> is its voice reference.",
        )
        assembled = {
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "Use Picture 1 for the character.",
                "current_prompt": current_prompt,
                "instruction": "zibble <Audio 1> frobnitz quux",
                "media_manifest": reference_manifest("<Picture 1>", "<Audio 1>"),
            },
        }

        without_audio, policy, *_ = _audit(reference_prompt(340), assembled)
        with_audio, *_ = _audit(current_prompt, assembled)

        self.assertEqual(policy.required, {"<Picture 1>"})
        self.assertEqual(policy.mutable, {"<Audio 1>"})
        self.assertEqual(policy.allowed, {"<Picture 1>", "<Audio 1>"})
        self.assertEqual(without_audio["missing_reference_tags"], [])
        self.assertEqual(with_audio["missing_reference_tags"], [])
        self.assertFalse(without_audio["repair_required"])
        self.assertFalse(with_audio["repair_required"])

    def test_refine_mutable_audio_present_with_audio_task_passes_audit(self):
        candidate = reference_prompt(340).replace(
            "<Subject 1> comes from <Picture 1>.",
            "<Subject 1> comes from <Picture 1>. <Audio 1> is its voice reference.",
        ).replace(
            "[reference generation]",
            "[reference generation + audio reference]",
        )
        assembled = {
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "zibble frobnitz quux",
                "current_prompt": reference_prompt(340),
                "instruction": "zibble <Audio 1> frobnitz quux",
                "media_manifest": reference_manifest("<Picture 1>", "<Audio 1>"),
            },
        }

        audit, policy, *_ = _audit(candidate, assembled)

        self.assertEqual(policy.required, {"<Picture 1>"})
        self.assertEqual(policy.mutable, {"<Audio 1>"})
        self.assertFalse(audit["unexpected_audio_task"])
        self.assertFalse(audit["repair_required"])

    def test_two_sequential_refines_do_not_restore_audio_from_original_brief(self):
        prompt_with_audio = reference_prompt(340).replace(
            "<Subject 1> comes from <Picture 1>.",
            "<Subject 1> comes from <Picture 1>. <Audio 1> is its voice reference.",
        )
        prompt_without_audio = reference_prompt(340)
        shared_input = {
            "mode": "Reference",
            "duration_seconds": 10,
            "creative_brief": "zibble <Audio 1> frobnitz quux",
            "media_manifest": reference_manifest("<Picture 1>", "<Audio 1>"),
        }

        first_audit, first_policy, *_ = _audit(prompt_without_audio, {
            "input": {
                **shared_input,
                "current_prompt": prompt_with_audio,
                "instruction": "zibble <Audio 1> frobnitz quux",
            },
        })
        second_audit, second_policy, *_ = _audit(prompt_without_audio, {
            "input": {
                **shared_input,
                "current_prompt": prompt_without_audio,
                "instruction": "zibble frobnitz quux",
            },
        })

        self.assertEqual(first_policy.required, {"<Picture 1>"})
        self.assertEqual(first_policy.mutable, {"<Audio 1>"})
        self.assertEqual(first_audit["missing_reference_tags"], [])
        self.assertEqual(second_policy.required, {"<Picture 1>"})
        self.assertEqual(second_policy.mutable, set())
        self.assertEqual(second_audit["missing_reference_tags"], [])
        self.assertFalse(second_audit["repair_required"])

    def test_refine_audio_named_only_by_instruction_can_be_added_or_omitted(self):
        assembled = {
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "Use Picture 1 for the character.",
                "current_prompt": reference_prompt(340),
                "instruction": "zibble <Audio 1> frobnitz quux",
                "media_manifest": reference_manifest("<Picture 1>", "<Audio 1>"),
            },
        }

        without_audio, policy, *_ = _audit(reference_prompt(340), assembled)
        with_audio, *_ = _audit(reference_prompt(340).replace(
            "<Subject 1> comes from <Picture 1>.",
            "<Subject 1> comes from <Picture 1>. <Audio 1> is present.",
        ), assembled)

        self.assertEqual(policy.required, {"<Picture 1>"})
        self.assertEqual(policy.mutable, {"<Audio 1>"})
        self.assertEqual(without_audio["missing_reference_tags"], [])
        self.assertEqual(with_audio["unexpected_reference_tags"], [])

    def test_refine_repair_does_not_restore_audio_made_mutable_by_instruction(self):
        first_draft = reference_prompt(340, include_soundscape=False)
        repaired = first_draft.replace(
            "<Subject 1> comes from <Picture 1>.",
            "<Subject 1> comes from <Picture 1>. <Audio 1> is its voice reference.",
        ).replace("\n\nnon_diegetic_music:", "\n\noverall_soundscape:\nQuiet room tone.\n\nnon_diegetic_music:")
        backend = _CharacterizedBackend([
            response(first_draft, prompt_tokens=100, completion_tokens=80),
            response(repaired, prompt_tokens=120, completion_tokens=90),
        ])
        assembled = {
            "messages": [{"role": "user", "content": "Rewrite the prompt."}],
            "media_inputs": [],
            "input": {
                "mode": "Reference",
                "duration_seconds": 10,
                "creative_brief": "Use Picture 1 for the character.",
                "current_prompt": first_draft.replace(
                    "<Subject 1> comes from <Picture 1>.",
                    "<Subject 1> comes from <Picture 1>. <Audio 1> is its voice reference.",
                ),
                "instruction": "zibble <Audio 1> frobnitz quux",
                "media_manifest": reference_manifest("<Picture 1>", "<Audio 1>"),
            },
        }

        result = backend.generate(
            model_info(),
            assembled,
            "characterization-session",
            thinking=False,
            seed=None,
            unload_after=False,
            runtime_plan=runtime_plan(),
        )

        self.assertTrue(result["format_repair_attempted"])
        self.assertFalse(result["format_repair_applied"])
        self.assertNotIn("<Audio 1>", result["prompt"])
        self.assertEqual(
            result["format_repair_failure"],
            "correction changed the reference inventory or user dialogue",
        )

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
        self.assertEqual(fallback["max_tokens"], 2_048)
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
                "media_manifest": reference_manifest("<Picture 1>"),
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
        self.assertEqual(repair_call["max_tokens"], 2_048)
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
                "media_manifest": reference_manifest("<Picture 1>"),
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
                "media_manifest": reference_manifest("<Picture 1>", "<Picture 2>"),
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
        self.assertIn("generated draft is missing required reference tags: <Picture 2>", repair_messages[3]["content"])
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
            "input": {"mode": "Reference", "duration_seconds": 10, "creative_brief": "Use both.", "media_manifest": reference_manifest("<Picture 1>", "<Picture 2>")},
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
            "input": {"mode": "Reference", "duration_seconds": 10, "creative_brief": "Use Picture 1.", "media_manifest": reference_manifest("<Picture 1>")},
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
            "input": {"mode": "Reference", "duration_seconds": 10, "creative_brief": "Use both.", "media_manifest": reference_manifest("<Picture 1>", "<Picture 2>")},
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

    def test_unload_ignores_a_vision_exit_stack_already_closed_by_model(self):
        backend = GGUFBackend()
        handler = _ChatHandler([])

        class _ModelThatClosesHandler:
            def close(self):
                handler._exit_stack = None

        backend.model = _ModelThatClosesHandler()
        backend.chat_handler = handler
        backend.model_id = "loaded-model"

        backend.unload()

        self.assertIsNone(backend.model)
        self.assertIsNone(backend.chat_handler)
        self.assertIsNone(backend.model_id)

    def test_unload_cleans_remaining_resources_and_state_after_close_errors(self):
        messages = []
        vision_closed = []

        class _FailingModel:
            def close(self):
                raise RuntimeError("model close failed")

        class _FailingStack:
            def close(self):
                vision_closed.append(True)
                raise RuntimeError("vision close failed")

        backend = GGUFBackend()
        backend._console = messages.append
        backend.model = _FailingModel()
        backend.chat_handler = type("Handler", (), {"_exit_stack": _FailingStack()})()
        backend.model_id = "loaded-model"
        backend.runtime_signature = ("loaded-model", 16_384, "q8", "multimodal")

        backend.unload()

        self.assertEqual(vision_closed, [True])
        self.assertIsNone(backend.model)
        self.assertIsNone(backend.chat_handler)
        self.assertIsNone(backend.model_id)
        self.assertIsNone(backend.runtime_signature)
        self.assertEqual(messages, [
            "Warning: model cleanup did not complete",
            "Warning: vision handler cleanup did not complete",
        ])


if __name__ == "__main__":
    unittest.main()
