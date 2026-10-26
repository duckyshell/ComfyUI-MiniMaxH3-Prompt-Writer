"""Optional API sampling controls; omitted fields remain provider-managed."""
from __future__ import annotations

import math
from typing import Any

from .contract import ModelError


SAMPLING_LIMITS = {
    "temperature": (0, 2),
    "top_p": (0, 1),
    "top_k": (0, None),
    "frequency_penalty": (-2, 2),
    "presence_penalty": (-2, 2),
}


def sampling_parameters(preset: str, declared: Any, *, anthropic: bool = False) -> list[str]:
    # Anthropic's compatible endpoint varies by model generation and offers no
    # portable sampling contract. Keep its existing provider-managed behavior.
    if anthropic:
        return []
    if isinstance(declared, list):
        return [name for name in SAMPLING_LIMITS if name in declared]
    # Generic compatible servers have no standard capability discovery. Overrides
    # are explicitly opt-in; their documentation remains authoritative.
    return list(SAMPLING_LIMITS) if preset == "custom" else []


def validate_sampling(value: Any, allowed: list[str]) -> dict[str, float | int]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ModelError("API_SAMPLING_INVALID", "API sampling settings must be an object.")
    result = {}
    for name, number in value.items():
        if name not in SAMPLING_LIMITS or name not in allowed:
            raise ModelError("API_SAMPLING_UNSUPPORTED", f"The selected API model does not support the {name} override.")
        low, high = SAMPLING_LIMITS[name]
        if (
            isinstance(number, bool) or not isinstance(number, (int, float))
            or not math.isfinite(number) or number < low
            or (high is not None and number > high)
            or (name == "top_k" and not isinstance(number, int))
        ):
            raise ModelError("API_SAMPLING_INVALID", f"Invalid {name} sampling value.")
        result[name] = number
    return result
