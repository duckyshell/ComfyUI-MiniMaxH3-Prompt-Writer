from __future__ import annotations

from typing import Any


def estimated_free_vram_mb(model_info: dict[str, Any], runtime_plan: dict[str, Any]) -> int | None:
    estimates = model_info.get("estimated_free_vram_mb")
    if not isinstance(estimates, dict):
        return None
    profile = runtime_plan.get("context_profile")
    estimate = estimates.get(profile)
    if not isinstance(estimate, (int, float)):
        return None
    required = float(estimate)
    if runtime_plan.get("kv_cache") == "f16":
        extra_at_16k = model_info.get("f16_kv_extra_mb_16k", 0)
        context_tokens = runtime_plan.get("context_tokens", 16384)
        if isinstance(extra_at_16k, (int, float)) and isinstance(context_tokens, (int, float)):
            required += float(extra_at_16k) * float(context_tokens) / 16384
    return round(required)


def assess_free_vram(
    model_info: dict[str, Any],
    runtime_plan: dict[str, Any],
    gpu_memory: dict[str, Any] | None,
    *,
    already_loaded: bool = False,
) -> dict[str, Any] | None:
    if already_loaded or not gpu_memory:
        return None
    free_mb = gpu_memory.get("free_mb")
    required_mb = estimated_free_vram_mb(model_info, runtime_plan)
    if not isinstance(free_mb, (int, float)) or required_mb is None or free_mb >= required_mb:
        return None
    return {
        "free_mb": round(free_mb),
        "required_free_mb": required_mb,
        "shortfall_mb": max(0, required_mb - round(free_mb)),
        "model_name": model_info.get("name"),
        "context_profile": runtime_plan.get("context_profile"),
        "context_tokens": runtime_plan.get("context_tokens"),
        "kv_cache": runtime_plan.get("kv_cache"),
    }
