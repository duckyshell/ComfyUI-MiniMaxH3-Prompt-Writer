from __future__ import annotations

import base64
import gc
import mimetypes
import threading
import time
from pathlib import Path
from typing import Any, Callable

from ..context import (
    CONTEXT_SAFETY_TOKENS,
    STANDARD_OUTPUT_TOKENS,
    ContextPlanError,
    plan_context,
)
from ..media import STORE
from ..prompt_audit import audit_prompt, camera_structure_requested
from ..prompt_repair import (
    audit_failures,
    dialogue_lines,
    explicit_constraint_violations,
    narrow_repair_messages,
    reference_tags,
    unexpected_audio_task,
)
from .contract import ModelError, final_text


def _data_uri(path: str) -> str:
    media_type = mimetypes.guess_type(path)[0] or "image/png"
    encoded = base64.b64encode(Path(path).read_bytes()).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


ESTIMATED_VISUAL_TOKENS = 280
CHAT_TEMPLATE_OVERHEAD_TOKENS = 384


class GGUFBackend:
    def __init__(self) -> None:
        self.model = None
        self.chat_handler = None
        self.model_id: str | None = None
        self.runtime_signature: tuple[str, int, str] | None = None
        self.cancel_event = threading.Event()
        self.force_unload_event = threading.Event()
        self.lock = threading.RLock()

    def status(self) -> dict[str, Any]:
        return {
            "loaded_model_id": self.model_id,
            "loaded": self.model is not None,
            "loaded_context_tokens": self.runtime_signature[1] if self.runtime_signature else None,
            "loaded_kv_cache": self.runtime_signature[2] if self.runtime_signature else None,
        }

    def cancel(self) -> bool:
        self.cancel_event.set()
        return True

    def prepare_request(self) -> None:
        self.cancel_event.clear()

    def request_unload(self) -> bool:
        self.force_unload_event.set()
        self.cancel_event.set()
        return True

    def _logits_processors(self, stop_if_cancelled: Callable[..., Any]) -> Any:
        from llama_cpp import LogitsProcessorList

        return LogitsProcessorList([stop_if_cancelled])

    def preflight(
        self,
        model_info: dict[str, Any],
        assembled: dict[str, Any],
        *,
        context_profile: str | None,
        kv_cache: str | None,
        thinking: bool,
    ) -> dict[str, Any]:
        try:
            return plan_context(
                assembled,
                model_info,
                requested_context=context_profile,
                requested_kv_cache=kv_cache,
                thinking=thinking,
            )
        except ContextPlanError as error:
            raise ModelError(error.code, error.message, error.details) from error

    def load(self, model_info: dict[str, Any], runtime_plan: dict[str, Any]) -> None:
        signature = (model_info["id"], runtime_plan["context_tokens"], runtime_plan["kv_cache"])
        if self.model is not None and self.runtime_signature == signature:
            return
        if not model_info.get("runtime_ready", True):
            raise ModelError(
                "MODEL_DEPENDENCY_MISSING",
                "The selected GGUF model needs its optional runtime or multimodal projector.",
                {"packages": model_info.get("missing_dependencies", [])},
            )
        self.unload()
        try:
            from llama_cpp import GGML_TYPE_F16, GGML_TYPE_Q8_0, Llama
            from llama_cpp.llama_chat_format import Gemma4ChatHandler

            kv_types = {"q8": GGML_TYPE_Q8_0, "f16": GGML_TYPE_F16}
            kv_type = kv_types[runtime_plan["kv_cache"]]

            self.chat_handler = Gemma4ChatHandler(
                clip_model_path=model_info["projector"],
                verbose=False,
                use_gpu=True,
            )
            self.model = Llama(
                model_path=model_info["path"],
                chat_handler=self.chat_handler,
                n_gpu_layers=-1,
                n_ctx=runtime_plan["context_tokens"],
                n_batch=512,
                flash_attn=True,
                type_k=kv_type,
                type_v=kv_type,
                verbose=False,
            )
            self.model_id = model_info["id"]
            self.runtime_signature = signature
        except MemoryError as error:
            self.unload()
            raise ModelError("MODEL_LOAD_OOM", "The GGUF model did not fit in available memory.") from error
        except Exception as error:
            self.unload()
            raise ModelError("MODEL_LOAD_FAILED", "The GGUF model could not be loaded.", str(error)) from error

    def unload(self) -> None:
        if self.model is not None:
            self.model.close()
        if self.chat_handler is not None:
            self.chat_handler._exit_stack.close()
        self.model = None
        self.chat_handler = None
        self.model_id = None
        self.runtime_signature = None
        gc.collect()

    def _messages(
        self,
        assembled: dict[str, Any],
        session_id: str,
        runtime_plan: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        system = "\n\n".join(message["content"] for message in assembled["messages"] if message["role"] == "system")
        user_text = next(message["content"] for message in assembled["messages"] if message["role"] == "user")
        content: list[dict[str, Any]] = []
        debug_user_parts: list[dict[str, str]] = []
        media_inputs = sorted(assembled["media_inputs"], key=lambda item: {"image": 0, "video": 1, "audio": 2}[item["type"]])
        image_count = len([item for item in media_inputs if item["type"] == "image"])
        video_frame_count = 0
        video_sheet_count = 0
        for item in media_inputs:
            asset = STORE.get(session_id, item["asset_id"])
            if item["type"] == "image":
                binding = f"{item['reference']}: image reference."
                content.append({"type": "text", "text": binding})
                content.append({"type": "image_url", "image_url": {"url": _data_uri(asset.get("_prepared_path", asset["_original_path"]))}})
                debug_user_parts.extend([
                    {"type": "text", "text": binding},
                    {"type": "image", "source": item["reference"], "representation": "prepared image"},
                ])
            elif item["type"] == "video":
                frames = asset.get("_frames", [])
                video_frame_count += len(frames)
                sheet_path = asset.get("_contact_sheet_path")
                if not sheet_path or not Path(sheet_path).exists():
                    raise ModelError("MEDIA_PREPARATION_FAILED", f"The internal contact sheet for {item['reference']} is missing.")
                video_sheet_count += 1
                binding = (
                    f"{item['reference']}: one ordered contact sheet sampled from this same video. "
                    "Read frames left-to-right, then top-to-bottom, using the displayed order and the accompanying manifest timestamps to infer motion. "
                    f"This sheet is only the internal visual representation of {item['reference']}; it is not a <Picture N> "
                    "and must never change or renumber the external reference labels."
                )
                content.append({
                    "type": "text",
                    "text": binding,
                })
                content.append({"type": "image_url", "image_url": {"url": _data_uri(sheet_path)}})
                debug_user_parts.extend([
                    {"type": "text", "text": binding},
                    {"type": "image", "source": item["reference"], "representation": "ordered video contact sheet"},
                ])
        content.append({"type": "text", "text": user_text})
        debug_user_parts.append({"type": "text", "text": user_text})
        messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
        visual_input_count = image_count + video_sheet_count
        text_tokens = len(self.model.tokenize((system + "\n\n" + user_text).encode("utf-8"), add_bos=True))
        estimated_input_tokens = (
            text_tokens
            + visual_input_count * ESTIMATED_VISUAL_TOKENS
            + CHAT_TEMPLATE_OVERHEAD_TOKENS
        )
        reserved_output_tokens = runtime_plan["max_output_tokens"] + CONTEXT_SAFETY_TOKENS
        if estimated_input_tokens + reserved_output_tokens > runtime_plan["context_tokens"]:
            raise ModelError(
                "CONTEXT_BUDGET_EXCEEDED",
                "The selected references and guide leave too little context for a complete prompt.",
                {
                    "estimated_input_tokens": estimated_input_tokens,
                    "reserved_output_tokens": reserved_output_tokens,
                    "context_tokens": runtime_plan["context_tokens"],
                    "suggestion": "Choose a larger Context profile or shorten the creative brief.",
                },
            )
        return messages, {
            "visual_input_count": visual_input_count,
            "video_frame_count": video_frame_count,
            "video_sheet_count": video_sheet_count,
            "vision_budget_applied": False,
            "estimated_input_tokens": estimated_input_tokens,
            "reserved_output_tokens": reserved_output_tokens,
            "debug_input_sequence": [
                {"role": "system", "parts": [
                    {
                        "type": "text",
                        "source": message.get("name", "system"),
                        "text": message["content"],
                    }
                    for message in assembled["messages"] if message["role"] == "system"
                ]},
                {"role": "user", "parts": debug_user_parts},
            ],
        }

    def generate(
        self,
        model_info: dict[str, Any],
        assembled: dict[str, Any],
        session_id: str,
        *,
        thinking: bool,
        seed: int | None,
        unload_after: bool,
        context_profile: str | None = None,
        kv_cache: str | None = None,
        runtime_plan: dict[str, Any] | None = None,
        on_phase: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            required = {item["requires_capability"] for item in assembled["media_inputs"]}
            unsupported = sorted(name for name in required if model_info["capabilities"].get(name) is not True)
            if unsupported:
                raise ModelError(
                    "UNSUPPORTED_MEDIA",
                    "The selected GGUF model cannot analyze all enabled media.",
                    {"capabilities": unsupported},
                )
            try:
                runtime_plan = runtime_plan or self.preflight(
                    model_info,
                    assembled,
                    context_profile=context_profile,
                    kv_cache=kv_cache,
                    thinking=thinking,
                )
                signature = (model_info["id"], runtime_plan["context_tokens"], runtime_plan["kv_cache"])
                cold_start = self.model is None or self.runtime_signature != signature
                if on_phase:
                    on_phase("loading_model")
                load_started = time.perf_counter()
                self.load(model_info, runtime_plan)
                load_seconds = time.perf_counter() - load_started
                if self.cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Generation was cancelled after model loading.")
                if on_phase:
                    on_phase("processing_media")
                media_started = time.perf_counter()
                messages, media_metrics = self._messages(assembled, session_id, runtime_plan)
                media_processing_seconds = time.perf_counter() - media_started
                if self.cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Generation was cancelled after media preparation.")

                def stop_if_cancelled(input_ids, scores):
                    if self.cancel_event.is_set():
                        raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.")
                    return scores

                if on_phase:
                    on_phase("generating")
                logits_processors = self._logits_processors(stop_if_cancelled)

                generation_started = time.perf_counter()
                response = self.chat_handler(
                    llama=self.model,
                    messages=messages,
                    temperature=1.0,
                    top_p=0.95,
                    top_k=64,
                    max_tokens=runtime_plan["max_output_tokens"],
                    seed=seed,
                    logits_processor=logits_processors,
                    enable_thinking=thinking,
                )
                message = response["choices"][0]["message"]
                text = message.get("content") or ""
                usage = response.get("usage", {})
                primary_finish_reason = response["choices"][0].get("finish_reason")
                thinking_attempt_tokens = int(usage.get("completion_tokens", 0)) if thinking else 0
                thinking_fallback = thinking and (
                    not text.strip() or response["choices"][0].get("finish_reason") == "length"
                )
                if thinking_fallback:
                    response = self.chat_handler(
                        llama=self.model,
                        messages=messages,
                        temperature=1.0,
                        top_p=0.95,
                        top_k=64,
                        max_tokens=1536,
                        seed=seed,
                        logits_processor=logits_processors,
                        enable_thinking=False,
                    )
                    message = response["choices"][0]["message"]
                    text = message.get("content") or ""
                    fallback_usage = response.get("usage", {})
                    usage = {
                        "prompt_tokens": fallback_usage.get("prompt_tokens", usage.get("prompt_tokens", 0)),
                        "completion_tokens": thinking_attempt_tokens + int(fallback_usage.get("completion_tokens", 0)),
                    }
                if not text.strip():
                    raise ModelError("EMPTY_GENERATION", "The model did not produce a final prompt.")
                prompt = final_text(text)
                duration_seconds = assembled["input"].get("duration_seconds")
                intent_text = assembled["input"].get("creative_brief") or "\n".join(
                    str(assembled["input"].get(key, "")) for key in ("current_prompt", "instruction")
                )
                camera_structure_allowed = camera_structure_requested(intent_text)
                initial_audit = audit_prompt(
                    prompt,
                    assembled["input"]["mode"],
                    duration_seconds,
                    camera_structure_allowed,
                )
                expected_reference_tags = reference_tags(
                    next(message["content"] for message in assembled["messages"] if message["role"] == "user")
                )
                actual_reference_tags = reference_tags(prompt)
                missing_reference_tags = sorted(expected_reference_tags - actual_reference_tags)
                unexpected_reference_tags = sorted(actual_reference_tags - expected_reference_tags)
                has_unexpected_audio_task = unexpected_audio_task(
                    initial_audit.get("task_label"), expected_reference_tags
                )
                constraint_violations = explicit_constraint_violations(intent_text, prompt)
                if assembled["input"]["mode"] == "Reference":
                    initial_audit["missing_reference_tags"] = missing_reference_tags
                    initial_audit["unexpected_reference_tags"] = unexpected_reference_tags
                    initial_audit["unexpected_audio_task"] = has_unexpected_audio_task
                    initial_audit["explicit_constraint_violations"] = constraint_violations
                    initial_audit["repair_required"] = bool(
                        initial_audit.get("repair_required")
                        or missing_reference_tags
                        or unexpected_reference_tags
                        or has_unexpected_audio_task
                        or constraint_violations
                    )
                format_repair_attempted = False
                format_repair_applied = False
                format_repair_tokens = 0
                format_repair_reason = None
                format_repair_failure = None
                format_repair_method = None
                if assembled["input"]["mode"] == "Reference" and initial_audit.get("repair_required") is True:
                    format_repair_attempted = True
                    failed_checks = audit_failures(initial_audit)
                    format_repair_reason = ", ".join(failed_checks) or "official format audit"
                    format_repair_method = "narrow text correction"
                    repair_messages = narrow_repair_messages(
                        assembled,
                        prompt,
                        failed_checks,
                        expected_reference_tags,
                        duration_seconds,
                    )
                    repair_response = self.chat_handler(
                            llama=self.model,
                            messages=repair_messages,
                            temperature=0.3,
                            top_p=0.9,
                            top_k=40,
                            max_tokens=STANDARD_OUTPUT_TOKENS,
                            seed=seed,
                            logits_processor=logits_processors,
                            enable_thinking=False,
                    )
                    repair_usage = repair_response.get("usage", {})
                    format_repair_tokens = int(repair_usage.get("completion_tokens", 0))
                    repaired = final_text(repair_response["choices"][0]["message"].get("content") or "")
                    repaired_audit = audit_prompt(
                        repaired,
                        assembled["input"]["mode"],
                        duration_seconds,
                        camera_structure_allowed,
                    )
                    repaired_tags = reference_tags(repaired)
                    repaired_audit["missing_reference_tags"] = sorted(expected_reference_tags - repaired_tags)
                    repaired_audit["unexpected_reference_tags"] = sorted(repaired_tags - expected_reference_tags)
                    repaired_audit["unexpected_audio_task"] = unexpected_audio_task(
                        repaired_audit.get("task_label"), expected_reference_tags
                    )
                    repaired_audit["explicit_constraint_violations"] = explicit_constraint_violations(
                        intent_text, repaired
                    )
                    repaired_audit["repair_required"] = bool(
                        repaired_audit.get("repair_required")
                        or repaired_audit["missing_reference_tags"]
                        or repaired_audit["unexpected_reference_tags"]
                        or repaired_audit["unexpected_audio_task"]
                        or repaired_audit["explicit_constraint_violations"]
                    )
                    repair_tags_match = repaired_tags == expected_reference_tags
                    dialogue_preserved = dialogue_lines(repaired) == dialogue_lines(prompt)
                    if (
                        repaired
                        and repaired_audit.get("repair_required") is False
                        and repair_tags_match
                        and dialogue_preserved
                    ):
                        prompt = repaired
                        format_repair_applied = True
                        initial_audit = repaired_audit
                    elif not repaired:
                        format_repair_failure = "empty repair"
                    elif repaired_audit.get("repair_required") is True:
                        remaining = audit_failures(repaired_audit)
                        format_repair_failure = "repaired draft still failed: " + ", ".join(remaining)
                    else:
                        format_repair_failure = "correction changed the reference inventory or user dialogue"
                    usage["completion_tokens"] = int(usage.get("completion_tokens", 0)) + format_repair_tokens
                generation_seconds = time.perf_counter() - generation_started
                output_tokens = int(usage.get("completion_tokens", 0))
                return {
                    "prompt": prompt,
                    "prompt_audit": initial_audit,
                    "input_tokens": int(usage.get("prompt_tokens", 0)),
                    "output_tokens": output_tokens,
                    "generation_seconds": round(generation_seconds, 3),
                    "media_processing_seconds": round(media_processing_seconds, 3),
                    **media_metrics,
                    "thinking_fallback": thinking_fallback,
                    "thinking_attempt_tokens": thinking_attempt_tokens,
                    "primary_finish_reason": primary_finish_reason,
                    "format_repair_attempted": format_repair_attempted,
                    "format_repair_applied": format_repair_applied,
                    "format_repair_reason": format_repair_reason,
                    "format_repair_failure": format_repair_failure,
                    "format_repair_method": format_repair_method,
                    "format_repair_tokens": format_repair_tokens,
                    "seed": seed,
                    "cold_start": cold_start,
                    "model_load_seconds": round(load_seconds, 3),
                    "tokens_per_second": round(output_tokens / generation_seconds, 2) if generation_seconds > 0 else 0,
                    "context_profile": runtime_plan["context_profile"],
                    "context_tokens": runtime_plan["context_tokens"],
                    "kv_cache": runtime_plan["kv_cache"],
                    "max_output_tokens": runtime_plan["max_output_tokens"],
                    "thinking_budget_reduced": runtime_plan["thinking_budget_reduced"],
                }
            except ModelError:
                raise
            except MemoryError as error:
                raise ModelError("GENERATION_OOM", "GGUF generation ran out of memory.") from error
            except Exception as error:
                raise ModelError("GENERATION_FAILED", "The GGUF model could not generate a prompt.", str(error)) from error
            finally:
                force_unload = self.force_unload_event.is_set()
                if unload_after or force_unload:
                    self.unload()
                self.force_unload_event.clear()


BACKEND = GGUFBackend()
