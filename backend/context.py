from __future__ import annotations

import math
from typing import Any, Callable


CONTEXT_PROFILES = {
    "low": 8_192,
    "standard": 16_384,
    "extended": 24_576,
    "large": 32_768,
    "maximum": 49_152,
}
CONTEXT_PROFILE_ALIASES = {
    "8k": "low",
    "16k": "standard",
    "24k": "extended",
    "32k": "large",
    "48k": "maximum",
}
LEGACY_CONTEXT_PROFILES = ("low", "standard", "extended")
QWEN_CONTEXT_PROFILES = ("standard", "extended", "large", "maximum")
KV_CACHE_PROFILES = {"auto", "q8", "f16"}
CONTEXT_SAFETY_TOKENS = 512
ESTIMATED_VISUAL_TOKENS = 280
CHAT_TEMPLATE_OVERHEAD_TOKENS = 384
MINIMUM_OUTPUT_TOKENS = 1_536
MUSIC_OUTPUT_TOKENS = 1_536
STANDARD_OUTPUT_TOKENS = 2_048
THINKING_OUTPUT_TOKENS = 6_144
LOCAL_THINKING_OUTPUT_TOKENS = 8_192


class ContextPlanError(ValueError):
    def __init__(self, code: str, message: str, details: dict[str, Any]):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def resolve_context_profile(requested: str | None, model_info: dict[str, Any]) -> str:
    available = context_profiles_for(model_info)
    value = (requested or "auto").strip().lower()
    value = CONTEXT_PROFILE_ALIASES.get(value, value)
    if value == "auto":
        recommended = str(model_info.get("recommended_context") or "standard").lower()
        return recommended if recommended in available else available[0]
    if value not in CONTEXT_PROFILES or value not in available:
        raise ContextPlanError(
            "INVALID_CONTEXT_PROFILE",
            "The selected Context profile is not available for this model.",
            {"context_profile": requested, "available_context_profiles": list(available)},
        )
    return value


def resolve_kv_cache(requested: str | None) -> str:
    value = (requested or "auto").strip().lower()
    if value not in KV_CACHE_PROFILES:
        raise ContextPlanError(
            "INVALID_KV_CACHE",
            "KV cache must be Auto, Q8, or F16.",
            {"kv_cache": requested},
        )
    return "q8" if value == "auto" else value


def estimate_text_tokens(text: str) -> int:
    """Conservative fallback used when an exact lightweight tokenizer is unavailable."""
    encoded = text.encode("utf-8")
    return math.ceil(max(len(text) / 3.0, len(encoded) / 3.0))


def _assembled_text(assembled: dict[str, Any]) -> str:
    return "\n\n".join(
        str(message.get("content") or "")
        for message in assembled.get("messages", [])
        if isinstance(message.get("content"), str)
    )


def context_profiles_for(model_info: dict[str, Any]) -> tuple[str, ...]:
    configured = model_info.get("context_profiles")
    if isinstance(configured, (list, tuple)):
        profiles = tuple(name for name in configured if name in CONTEXT_PROFILES)
    elif model_info.get("architecture_adapter") in {"qwen35", "qwen35moe"}:
        profiles = QWEN_CONTEXT_PROFILES
    else:
        profiles = LEGACY_CONTEXT_PROFILES
    native_context = model_info.get("native_context_tokens")
    if isinstance(native_context, int) and native_context > 0:
        profiles = tuple(name for name in profiles if CONTEXT_PROFILES[name] <= native_context)
    return profiles or ("standard",)


def estimate_visual_tokens(
    assembled: dict[str, Any],
    model_info: dict[str, Any],
) -> tuple[int, list[dict[str, Any]], bool]:
    visual_inputs = [
        item for item in assembled.get("media_inputs", [])
        if item.get("type") in {"image", "video"}
    ]
    if model_info.get("architecture_adapter") not in {"qwen35", "qwen35moe"}:
        return len(visual_inputs) * ESTIMATED_VISUAL_TOKENS, [], False

    projector = model_info.get("projector_metadata") or {}
    patch_size = projector.get("vision_patch_size")
    spatial_merge = projector.get("vision_spatial_merge_size")
    patch_size = patch_size if isinstance(patch_size, int) and patch_size > 0 else 16
    spatial_merge = spatial_merge if isinstance(spatial_merge, int) and spatial_merge > 0 else 2
    effective_patch = patch_size * spatial_merge
    details = []
    total = 0
    for item in visual_inputs:
        width = item.get("visual_width")
        height = item.get("visual_height")
        if not isinstance(width, int) or width <= 0 or not isinstance(height, int) or height <= 0:
            width, height = ((1536, 1536) if item.get("type") == "image" else (1152, 1080))
        tokens = math.ceil(width / effective_patch) * math.ceil(height / effective_patch)
        total += tokens
        details.append({
            "asset_id": item.get("asset_id"),
            "type": item.get("type"),
            "width": width,
            "height": height,
            "tokens": tokens,
        })
    return total, details, bool(visual_inputs)


def non_thinking_output_tokens(assembled: dict[str, Any]) -> int:
    mode = assembled.get("input", {}).get("mode")
    return MUSIC_OUTPUT_TOKENS if mode == "Music3" else STANDARD_OUTPUT_TOKENS


def plan_context(
    assembled: dict[str, Any],
    model_info: dict[str, Any],
    *,
    requested_context: str | None,
    requested_kv_cache: str | None,
    thinking: bool,
    count_text_tokens: Callable[[str], int] | None = None,
) -> dict[str, Any]:
    requested_value = (requested_context or "auto").strip().lower()
    requested_value = CONTEXT_PROFILE_ALIASES.get(requested_value, requested_value)
    automatic = requested_value == "auto"
    available_profiles = context_profiles_for(model_info)
    profile = resolve_context_profile(requested_context, model_info)
    kv_cache = resolve_kv_cache(requested_kv_cache)
    visual_input_count = sum(
        1 for item in assembled.get("media_inputs", [])
        if item.get("type") in {"image", "video"}
    )
    text_counter = count_text_tokens or estimate_text_tokens
    estimated_text_tokens = text_counter(_assembled_text(assembled))
    estimated_visual_tokens, visual_token_details, vision_budget_applied = estimate_visual_tokens(
        assembled,
        model_info,
    )
    estimated_input_tokens = (
        estimated_text_tokens
        + estimated_visual_tokens
        + CHAT_TEMPLATE_OVERHEAD_TOKENS
    )
    desired_output_tokens = (
        LOCAL_THINKING_OUTPUT_TOKENS
        if thinking
        else non_thinking_output_tokens(assembled)
    )
    minimum_required = estimated_input_tokens + desired_output_tokens + CONTEXT_SAFETY_TOKENS
    automatic_ladder = automatic and model_info.get("auto_context_ladder") is True
    if automatic and thinking:
        minimum_tier_tokens = max(
            CONTEXT_PROFILES[profile],
            CONTEXT_PROFILES["standard"],
            minimum_required,
        )
        profile = next(
            (name for name in available_profiles if CONTEXT_PROFILES[name] >= minimum_tier_tokens),
            available_profiles[-1],
        )
    elif automatic_ladder:
        minimum_tier_tokens = max(
            CONTEXT_PROFILES[profile],
            minimum_required,
        )
        profile = next(
            (name for name in available_profiles if CONTEXT_PROFILES[name] >= minimum_tier_tokens),
            available_profiles[-1],
        )
    elif automatic and profile == "low" and minimum_required > CONTEXT_PROFILES["low"]:
        profile = "standard" if "standard" in available_profiles else available_profiles[-1]
    context_tokens = CONTEXT_PROFILES[profile]
    if profile == "low" and thinking:
        raise ContextPlanError(
            "THINKING_DISABLED_LOW_CONTEXT",
            "Thinking is unavailable in Low 8K context. Switch to Standard 16K or turn Thinking off.",
            {"context_profile": profile, "context_tokens": context_tokens, "suggested_context_profile": "standard"},
        )
    if minimum_required > context_tokens:
        suggested = next(
            (
                name for name in available_profiles
                if CONTEXT_PROFILES[name] >= minimum_required and CONTEXT_PROFILES[name] > context_tokens
            ),
            None,
        )
        code = "THINKING_CONTEXT_INSUFFICIENT" if thinking else "CONTEXT_BUDGET_EXCEEDED"
        message = (
            "The selected Context cannot fit the complete Thinking request."
            if thinking
            else "This request does not leave enough context for a complete MiniMax prompt."
        )
        raise ContextPlanError(
            code,
            message,
            {
                "estimated_input_tokens": estimated_input_tokens,
                "minimum_output_tokens": desired_output_tokens,
                "safety_tokens": CONTEXT_SAFETY_TOKENS,
                "context_profile": profile,
                "context_tokens": context_tokens,
                "suggested_context_profile": suggested,
                "suggestion": (
                    f"Switch to {suggested.title()} context."
                    if suggested and thinking
                    else f"Switch to {suggested.title()} context or remove references."
                    if suggested
                    else "Disable Thinking, remove references, use a smaller model, or shorten the creative brief."
                    if thinking
                    else "Remove references or shorten the creative brief."
                ),
            },
        )

    max_output_tokens = desired_output_tokens
    return {
        "requested_context_profile": requested_context or "auto",
        "context_profile": profile,
        "context_tokens": context_tokens,
        "requested_kv_cache": requested_kv_cache or "auto",
        "kv_cache": kv_cache,
        "thinking": thinking,
        "estimated_text_tokens": estimated_text_tokens,
        "text_token_source": "vocab_only" if count_text_tokens else "estimate",
        "estimated_visual_tokens": estimated_visual_tokens,
        "visual_token_details": visual_token_details,
        "estimated_input_tokens": estimated_input_tokens,
        "visual_input_count": visual_input_count,
        "max_output_tokens": max_output_tokens,
        "reserved_output_tokens": max_output_tokens + CONTEXT_SAFETY_TOKENS,
        "thinking_budget_reduced": False,
        "vision_budget_applied": vision_budget_applied,
        "available_context_profiles": list(available_profiles),
    }
