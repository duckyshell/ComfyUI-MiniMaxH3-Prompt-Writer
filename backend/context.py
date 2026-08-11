from __future__ import annotations

import math
from typing import Any


CONTEXT_PROFILES = {
    "low": 8_192,
    "standard": 16_384,
    "extended": 24_576,
}
CONTEXT_PROFILE_ALIASES = {"8k": "low", "16k": "standard", "24k": "extended"}
KV_CACHE_PROFILES = {"auto", "q8", "f16"}
CONTEXT_SAFETY_TOKENS = 512
ESTIMATED_VISUAL_TOKENS = 280
CHAT_TEMPLATE_OVERHEAD_TOKENS = 384
STANDARD_OUTPUT_TOKENS = 1_536
THINKING_OUTPUT_TOKENS = 6_144


class ContextPlanError(ValueError):
    def __init__(self, code: str, message: str, details: dict[str, Any]):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def resolve_context_profile(requested: str | None, model_info: dict[str, Any]) -> str:
    value = (requested or "auto").strip().lower()
    value = CONTEXT_PROFILE_ALIASES.get(value, value)
    if value == "auto":
        recommended = str(model_info.get("recommended_context") or "standard").lower()
        return recommended if recommended in CONTEXT_PROFILES else "standard"
    if value not in CONTEXT_PROFILES:
        raise ContextPlanError(
            "INVALID_CONTEXT_PROFILE",
            "Context must be Auto, Low 8K, Standard 16K, or Extended 24K.",
            {"context_profile": requested},
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
    """Conservative Gemma-family estimate that needs no model or GPU allocation."""
    encoded = text.encode("utf-8")
    return math.ceil(max(len(text) / 3.0, len(encoded) / 3.0))


def _assembled_text(assembled: dict[str, Any]) -> str:
    return "\n\n".join(
        str(message.get("content") or "")
        for message in assembled.get("messages", [])
        if isinstance(message.get("content"), str)
    )


def plan_context(
    assembled: dict[str, Any],
    model_info: dict[str, Any],
    *,
    requested_context: str | None,
    requested_kv_cache: str | None,
    thinking: bool,
) -> dict[str, Any]:
    requested_value = (requested_context or "auto").strip().lower()
    requested_value = CONTEXT_PROFILE_ALIASES.get(requested_value, requested_value)
    automatic = requested_value == "auto"
    profile = resolve_context_profile(requested_context, model_info)
    kv_cache = resolve_kv_cache(requested_kv_cache)
    visual_input_count = sum(
        1 for item in assembled.get("media_inputs", [])
        if item.get("type") in {"image", "video"}
    )
    estimated_text_tokens = estimate_text_tokens(_assembled_text(assembled))
    estimated_input_tokens = (
        estimated_text_tokens
        + visual_input_count * ESTIMATED_VISUAL_TOKENS
        + CHAT_TEMPLATE_OVERHEAD_TOKENS
    )
    minimum_required = estimated_input_tokens + STANDARD_OUTPUT_TOKENS + CONTEXT_SAFETY_TOKENS
    automatic_ladder = automatic and model_info.get("auto_context_ladder") is True
    if automatic_ladder:
        minimum_tier_tokens = max(
            CONTEXT_PROFILES[profile],
            CONTEXT_PROFILES["standard"] if thinking else 0,
            minimum_required,
        )
        profile = next(
            (name for name, tokens in CONTEXT_PROFILES.items() if tokens >= minimum_tier_tokens),
            "extended",
        )
    elif automatic and profile == "low" and (
        thinking or minimum_required > CONTEXT_PROFILES["low"]
    ):
        profile = "standard"
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
                name for name, tokens in CONTEXT_PROFILES.items()
                if tokens >= minimum_required and tokens > context_tokens
            ),
            None,
        )
        raise ContextPlanError(
            "CONTEXT_BUDGET_EXCEEDED",
            "This request does not leave enough context for a complete MiniMax prompt.",
            {
                "estimated_input_tokens": estimated_input_tokens,
                "minimum_output_tokens": STANDARD_OUTPUT_TOKENS,
                "safety_tokens": CONTEXT_SAFETY_TOKENS,
                "context_profile": profile,
                "context_tokens": context_tokens,
                "suggested_context_profile": suggested,
                "suggestion": (
                    f"Switch to {suggested.title()} context or remove references."
                    if suggested else "Remove references or shorten the creative brief."
                ),
            },
        )

    available_output_tokens = context_tokens - estimated_input_tokens - CONTEXT_SAFETY_TOKENS
    max_output_tokens = (
        min(THINKING_OUTPUT_TOKENS, available_output_tokens)
        if thinking else STANDARD_OUTPUT_TOKENS
    )
    return {
        "requested_context_profile": requested_context or "auto",
        "context_profile": profile,
        "context_tokens": context_tokens,
        "requested_kv_cache": requested_kv_cache or "auto",
        "kv_cache": kv_cache,
        "thinking": thinking,
        "estimated_text_tokens": estimated_text_tokens,
        "estimated_input_tokens": estimated_input_tokens,
        "visual_input_count": visual_input_count,
        "max_output_tokens": max_output_tokens,
        "reserved_output_tokens": max_output_tokens + CONTEXT_SAFETY_TOKENS,
        "thinking_budget_reduced": thinking and max_output_tokens < THINKING_OUTPUT_TOKENS,
    }
