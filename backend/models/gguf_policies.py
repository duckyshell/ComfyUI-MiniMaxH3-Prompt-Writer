from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SamplingPolicy:
    temperature: float
    top_p: float
    top_k: int
    min_p: float
    presence_penalty: float
    repeat_penalty: float


@dataclass(frozen=True)
class GGUFModelPolicy:
    id: str
    architecture: str
    metadata_names: tuple[str, ...]
    thinking: SamplingPolicy
    non_thinking: SamplingPolicy
    reasoning_effort: str | None = None
    verified_filenames: tuple[str, ...] = ()


QWEN38_POLICY = GGUFModelPolicy(
    id="qwen38-27b",
    architecture="qwen35",
    metadata_names=("Qwen3.8-27B",),
    thinking=SamplingPolicy(1.0, 0.95, 20, 0.0, 0.0, 1.0),
    non_thinking=SamplingPolicy(0.7, 0.8, 20, 0.0, 1.5, 1.0),
    reasoning_effort="low",
    verified_filenames=("Qwen3.8-27B-UD-Q4_K_XL.gguf",),
)
QWEN36_POLICY = GGUFModelPolicy(
    id="qwen36-35b-a3b",
    architecture="qwen35moe",
    metadata_names=("Qwen3.6-35B-A3B",),
    thinking=SamplingPolicy(1.0, 0.95, 20, 0.0, 1.5, 1.0),
    non_thinking=SamplingPolicy(0.7, 0.8, 20, 0.0, 1.5, 1.0),
)
_POLICIES = (QWEN38_POLICY, QWEN36_POLICY)


def identify_model_policy(architecture: str | None, metadata_name: str | None) -> GGUFModelPolicy | None:
    normalized_architecture = str(architecture or "").strip().lower()
    normalized_name = str(metadata_name or "").strip().casefold()
    return next(
        (
            policy
            for policy in _POLICIES
            if policy.architecture == normalized_architecture
            and normalized_name in {name.casefold() for name in policy.metadata_names}
        ),
        None,
    )


def policy_is_verified_configuration(policy: GGUFModelPolicy | None, model_path: str | Path) -> bool:
    return bool(policy and Path(model_path).name.casefold() in {name.casefold() for name in policy.verified_filenames})


def sampling_options(
    model_info: dict[str, Any],
    *,
    thinking: bool,
    fallback: dict[str, Any],
) -> dict[str, Any]:
    policy = next((item for item in _POLICIES if item.id == model_info.get("model_policy")), None)
    if policy is None:
        return fallback.copy()
    sampling = policy.thinking if thinking else policy.non_thinking
    return {
        **fallback,
        "temperature": sampling.temperature,
        "top_p": sampling.top_p,
        "top_k": sampling.top_k,
        "min_p": sampling.min_p,
        "presence_penalty": sampling.presence_penalty,
        "repeat_penalty": sampling.repeat_penalty,
    }


def template_kwargs(model_info: dict[str, Any], *, thinking: bool) -> dict[str, Any]:
    controls = model_info.get("template_controls") or {}
    if controls.get("enable_thinking") is not True:
        return {}
    result: dict[str, Any] = {"enable_thinking": thinking}
    policy = next((item for item in _POLICIES if item.id == model_info.get("model_policy")), None)
    if (
        thinking
        and policy is not None
        and policy.reasoning_effort
        and controls.get("reasoning_effort") is True
    ):
        result["reasoning_effort"] = policy.reasoning_effort
    return result
