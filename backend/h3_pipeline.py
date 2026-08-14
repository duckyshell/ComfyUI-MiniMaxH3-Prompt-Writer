from __future__ import annotations

import base64
import mimetypes
import time
from pathlib import Path
from typing import Any, Callable

from .context import (
    CHAT_TEMPLATE_OVERHEAD_TOKENS,
    CONTEXT_SAFETY_TOKENS,
    ESTIMATED_VISUAL_TOKENS,
    STANDARD_OUTPUT_TOKENS,
)
from .media import STORE
from .models.contract import ModelError, final_text
from .prompt_audit import audit_prompt, camera_structure_requested
from .prompt_repair import (
    audit_failures,
    dialogue_lines,
    explicit_constraint_violations,
    multimodal_repair_messages,
    narrow_repair_messages,
    unexpected_audio_task,
)
from .references import ReferencePolicy, reference_policy, reference_tags

def _data_uri(path: str) -> str:
    media_type = mimetypes.guess_type(path)[0] or "image/png"
    encoded = base64.b64encode(Path(path).read_bytes()).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def _messages(
    assembled: dict[str, Any],
    session_id: str,
    runtime_plan: dict[str, Any],
    count_text_tokens: Callable[[str], int],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    system = "\n\n".join(
        message["content"] for message in assembled["messages"] if message["role"] == "system"
    )
    user_text = next(message["content"] for message in assembled["messages"] if message["role"] == "user")
    content: list[dict[str, Any]] = []
    debug_user_parts: list[dict[str, str]] = []
    media_inputs = sorted(
        assembled["media_inputs"],
        key=lambda item: {"image": 0, "video": 1, "audio": 2}[item["type"]],
    )
    image_count = len([item for item in media_inputs if item["type"] == "image"])
    video_frame_count = 0
    video_sheet_count = 0
    for item in media_inputs:
        asset = STORE.get(session_id, item["asset_id"])
        if item["type"] == "image":
            binding = f"{item['reference']}: image reference."
            content.append({"type": "text", "text": binding})
            content.append({
                "type": "image_url",
                "image_url": {"url": _data_uri(asset.get("_prepared_path", asset["_original_path"]))},
            })
            debug_user_parts.extend([
                {"type": "text", "text": binding},
                {"type": "image", "source": item["reference"], "representation": "prepared image"},
            ])
        elif item["type"] == "video":
            frames = asset.get("_frames", [])
            video_frame_count += len(frames)
            sheet_path = asset.get("_contact_sheet_path")
            if not sheet_path or not Path(sheet_path).exists():
                raise ModelError(
                    "MEDIA_PREPARATION_FAILED",
                    f"The internal contact sheet for {item['reference']} is missing.",
                )
            video_sheet_count += 1
            binding = (
                f"{item['reference']}: one ordered contact sheet sampled from this same video. "
                "Read frames left-to-right, then top-to-bottom, using the displayed order and the accompanying manifest timestamps to infer motion. "
                f"This sheet is only the internal visual representation of {item['reference']}; it is not a <Picture N> "
                "and must never change or renumber the external reference labels."
            )
            content.append({"type": "text", "text": binding})
            content.append({"type": "image_url", "image_url": {"url": _data_uri(sheet_path)}})
            debug_user_parts.extend([
                {"type": "text", "text": binding},
                {"type": "image", "source": item["reference"], "representation": "ordered video contact sheet"},
            ])
    content.append({"type": "text", "text": user_text})
    debug_user_parts.append({"type": "text", "text": user_text})
    messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
    visual_input_count = image_count + video_sheet_count
    text_tokens = count_text_tokens(system + "\n\n" + user_text)
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


def _audit(
    prompt: str,
    assembled: dict[str, Any],
) -> tuple[dict[str, Any], ReferencePolicy, str, float | None, bool]:
    duration_seconds = assembled["input"].get("duration_seconds")
    intent_text = "\n".join(
        str(assembled["input"].get(key, ""))
        for key in ("creative_brief", "current_prompt", "instruction")
        if assembled["input"].get(key)
    )
    camera_structure_allowed = camera_structure_requested(intent_text)
    result = audit_prompt(
        prompt,
        assembled["input"]["mode"],
        duration_seconds,
        camera_structure_allowed,
    )
    policy = reference_policy(assembled["input"])
    actual_reference_tags = reference_tags(prompt)
    missing_reference_tags = sorted(policy.required - actual_reference_tags)
    unexpected_reference_tags = sorted(actual_reference_tags - policy.allowed)
    has_unexpected_audio_task = unexpected_audio_task(result.get("task_label"), actual_reference_tags)
    constraint_violations = explicit_constraint_violations(intent_text, prompt)
    if assembled["input"]["mode"] == "Reference":
        result["missing_reference_tags"] = missing_reference_tags
        result["unexpected_reference_tags"] = unexpected_reference_tags
        result["required_reference_tags"] = sorted(policy.required)
        result["mutable_reference_tags"] = sorted(policy.mutable)
        result["allowed_reference_tags"] = sorted(policy.allowed)
        result["unexpected_audio_task"] = has_unexpected_audio_task
        result["explicit_constraint_violations"] = constraint_violations
        result["repair_required"] = bool(
            result.get("repair_required")
            or missing_reference_tags
            or unexpected_reference_tags
            or has_unexpected_audio_task
            or constraint_violations
        )
    return result, policy, intent_text, duration_seconds, camera_structure_allowed


def validate_media_capabilities(model_info: dict[str, Any], assembled: dict[str, Any]) -> None:
    required = {item["requires_capability"] for item in assembled["media_inputs"]}
    unsupported = sorted(name for name in required if model_info["capabilities"].get(name) is not True)
    if unsupported:
        if model_info.get("family") == "external" and {"images", "video_frames"}.intersection(unsupported):
            raise ModelError(
                "EXTERNAL_VISION_REQUIRED",
                "The External llama.cpp model is running in text-only mode and cannot analyze the attached images or video.",
                {
                    "capabilities": unsupported,
                    "suggestion": "Restart llama-server with the matching mmproj, remove visual references, or select a vision-capable prompt model.",
                },
            )
        raise ModelError(
            "UNSUPPORTED_MEDIA",
            "The selected prompt model cannot analyze all media in the current manifest.",
            {"capabilities": unsupported},
        )


def run_h3_pipeline(
    model_info: dict[str, Any],
    assembled: dict[str, Any],
    session_id: str,
    runtime_plan: dict[str, Any],
    *,
    complete: Callable[..., dict[str, Any]],
    count_text_tokens: Callable[[str], int],
    is_cancelled: Callable[[], bool],
    thinking: bool,
    seed: int | None,
    on_phase: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    validate_media_capabilities(model_info, assembled)

    if on_phase:
        on_phase("processing_media")
    media_started = time.perf_counter()
    messages, media_metrics = _messages(assembled, session_id, runtime_plan, count_text_tokens)
    media_processing_seconds = time.perf_counter() - media_started
    if is_cancelled():
        raise ModelError("GENERATION_CANCELLED", "Generation was cancelled after media preparation.")

    if on_phase:
        on_phase("generating")
    generation_started = time.perf_counter()
    response = complete(
        messages=messages,
        temperature=1.0,
        top_p=0.95,
        top_k=64,
        max_tokens=runtime_plan["max_output_tokens"],
        seed=seed,
        thinking=thinking,
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
        response = complete(
            messages=messages,
            temperature=1.0,
            top_p=0.95,
            top_k=64,
            max_tokens=1_536,
            seed=seed,
            thinking=False,
        )
        message = response["choices"][0]["message"]
        text = message.get("content") or ""
        fallback_usage = response.get("usage", {})
        usage = {
            "prompt_tokens": fallback_usage.get("prompt_tokens", usage.get("prompt_tokens", 0)),
            "completion_tokens": thinking_attempt_tokens + int(fallback_usage.get("completion_tokens", 0)),
        }
    final_finish_reason = response["choices"][0].get("finish_reason")
    if final_finish_reason == "length":
        raise ModelError(
            "GENERATION_TRUNCATED",
            "The model reached its output limit before completing the prompt. Try again or choose a model with a larger output budget.",
            {"max_output_tokens": runtime_plan["max_output_tokens"]},
        )
    if not text.strip():
        raise ModelError("EMPTY_GENERATION", "The model did not produce a final prompt.")

    prompt = final_text(text)
    initial_audit, reference_policy_value, intent_text, duration_seconds, camera_structure_allowed = _audit(
        prompt,
        assembled,
    )
    expected_reference_tags = reference_policy_value.required
    allowed_reference_tags = reference_policy_value.allowed
    initial_reference_tags = reference_tags(prompt)
    repair_reference_tags = (initial_reference_tags & allowed_reference_tags) | expected_reference_tags
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
        missing_active_references = bool(initial_audit.get("missing_reference_tags"))
        has_prepared_visual_media = any(
            item.get("type") in {"image", "video"} for item in assembled.get("media_inputs", [])
        )
        if missing_active_references and has_prepared_visual_media:
            format_repair_method = "multimodal reference correction"
            repair_messages = multimodal_repair_messages(
                messages,
                prompt,
                failed_checks,
                repair_reference_tags,
                duration_seconds,
                allowed_reference_tags,
            )
        else:
            format_repair_method = "narrow text correction"
            repair_messages = narrow_repair_messages(
                assembled,
                prompt,
                failed_checks,
                repair_reference_tags,
                duration_seconds,
                allowed_reference_tags,
            )
        if is_cancelled():
            raise ModelError("GENERATION_CANCELLED", "Generation was cancelled before prompt correction.")
        repair_response = complete(
            messages=repair_messages,
            temperature=0.3,
            top_p=0.9,
            top_k=40,
            max_tokens=STANDARD_OUTPUT_TOKENS,
            seed=seed,
            thinking=False,
        )
        repair_usage = repair_response.get("usage", {})
        format_repair_tokens = int(repair_usage.get("completion_tokens", 0))
        repair_finish_reason = repair_response["choices"][0].get("finish_reason")
        repaired = final_text(repair_response["choices"][0]["message"].get("content") or "")
        repaired_audit = audit_prompt(
            repaired,
            assembled["input"]["mode"],
            duration_seconds,
            camera_structure_allowed,
        )
        repaired_tags = reference_tags(repaired)
        repaired_audit["missing_reference_tags"] = sorted(expected_reference_tags - repaired_tags)
        repaired_audit["unexpected_reference_tags"] = sorted(repaired_tags - allowed_reference_tags)
        repaired_audit["required_reference_tags"] = sorted(reference_policy_value.required)
        repaired_audit["mutable_reference_tags"] = sorted(reference_policy_value.mutable)
        repaired_audit["allowed_reference_tags"] = sorted(reference_policy_value.allowed)
        repaired_audit["unexpected_audio_task"] = unexpected_audio_task(
            repaired_audit.get("task_label"), repaired_tags
        )
        repaired_audit["explicit_constraint_violations"] = explicit_constraint_violations(intent_text, repaired)
        repaired_audit["repair_required"] = bool(
            repaired_audit.get("repair_required")
            or repaired_audit["missing_reference_tags"]
            or repaired_audit["unexpected_reference_tags"]
            or repaired_audit["unexpected_audio_task"]
            or repaired_audit["explicit_constraint_violations"]
        )
        repair_tags_match = repaired_tags == repair_reference_tags
        dialogue_preserved = dialogue_lines(repaired) == dialogue_lines(prompt)
        if (
            repaired
            and repair_finish_reason != "length"
            and repaired_audit.get("repair_required") is False
            and repair_tags_match
            and dialogue_preserved
        ):
            prompt = repaired
            format_repair_applied = True
            initial_audit = repaired_audit
        elif not repaired:
            format_repair_failure = "empty repair"
        elif repair_finish_reason == "length":
            format_repair_failure = "repair reached its output limit"
        elif repaired_audit.get("repair_required") is True:
            remaining = audit_failures(repaired_audit)
            format_repair_failure = "repaired draft still failed: " + ", ".join(remaining)
        else:
            format_repair_failure = "correction changed the reference inventory or user dialogue"
        usage["prompt_tokens"] = int(usage.get("prompt_tokens", 0)) + int(repair_usage.get("prompt_tokens", 0))
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
        "format_repair_multimodal": format_repair_method == "multimodal reference correction",
        "format_repair_tokens": format_repair_tokens,
        "seed": seed,
        "tokens_per_second": round(output_tokens / generation_seconds, 2) if generation_seconds > 0 else 0,
    }
