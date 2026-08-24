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
    lineage_id: str
    thinking: SamplingPolicy
    non_thinking: SamplingPolicy
    reasoning_effort: str | None = None
    verified_filenames: tuple[str, ...] = ()
    verified_projector_filenames: tuple[str, ...] = ()


@dataclass(frozen=True)
class GGUFModelLineage:
    id: str
    architecture: str
    metadata_names: tuple[str, ...]
    provenance_names: tuple[str, ...] = ()
    provenance_repo_urls: tuple[str, ...] = ()
    structural_fingerprint: tuple[tuple[str, int], ...] = ()


@dataclass(frozen=True)
class ModelLineageMatch:
    lineage: GGUFModelLineage
    source: str


@dataclass(frozen=True)
class VerifiedGGUFConfiguration:
    architecture: str
    metadata_names: tuple[str, ...]
    model_filenames: tuple[str, ...]
    projector_filenames: tuple[str, ...]


QWEN38_LINEAGE = GGUFModelLineage(
    id="qwen38-27b",
    architecture="qwen35",
    metadata_names=("Qwen3.8-27B",),
    provenance_names=("Qwen3.8 27B", "Qwen3.8-27B"),
    provenance_repo_urls=("https://huggingface.co/Qwen/Qwen3.8-27B",),
    structural_fingerprint=(
        ("qwen35.block_count", 65),
        ("qwen35.embedding_length", 5_120),
        ("qwen35.feed_forward_length", 17_408),
        ("qwen35.attention.head_count", 24),
        ("qwen35.attention.head_count_kv", 4),
        ("qwen35.attention.key_length", 256),
        ("qwen35.attention.value_length", 256),
        ("qwen35.ssm.conv_kernel", 4),
        ("qwen35.ssm.state_size", 128),
        ("qwen35.ssm.group_count", 16),
        ("qwen35.ssm.time_step_rank", 48),
        ("qwen35.ssm.inner_size", 6_144),
        ("qwen35.full_attention_interval", 4),
        ("qwen35.rope.dimension_count", 64),
    ),
)
QWEN36_LINEAGE = GGUFModelLineage(
    id="qwen36-35b-a3b",
    architecture="qwen35moe",
    metadata_names=("Qwen3.6-35B-A3B",),
    provenance_names=("Qwen3.6 35B A3B", "Qwen3.6-35B-A3B"),
    provenance_repo_urls=("https://huggingface.co/Qwen/Qwen3.6-35B-A3B",),
)
_LINEAGES = (QWEN38_LINEAGE, QWEN36_LINEAGE)

QWEN38_POLICY = GGUFModelPolicy(
    id="qwen38-27b",
    lineage_id=QWEN38_LINEAGE.id,
    thinking=SamplingPolicy(1.0, 0.95, 20, 0.0, 0.0, 1.0),
    non_thinking=SamplingPolicy(0.7, 0.8, 20, 0.0, 1.5, 1.0),
    reasoning_effort="low",
    verified_filenames=("Qwen3.8-27B-UD-Q4_K_XL.gguf",),
    verified_projector_filenames=("mmproj-BF16.gguf",),
)
QWEN36_POLICY = GGUFModelPolicy(
    id="qwen36-35b-a3b",
    lineage_id=QWEN36_LINEAGE.id,
    thinking=SamplingPolicy(1.0, 0.95, 20, 0.0, 1.5, 1.0),
    non_thinking=SamplingPolicy(0.7, 0.8, 20, 0.0, 1.5, 1.0),
)
_POLICIES = (QWEN38_POLICY, QWEN36_POLICY)
QWEN3VL_8B_CONFIGURATION = VerifiedGGUFConfiguration(
    architecture="qwen3vl",
    metadata_names=("Qwen3Vl 8b Instruct",),
    model_filenames=("Qwen3VL-8B-Instruct-Q4_K_M.gguf",),
    projector_filenames=("mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",),
)
_VERIFIED_NON_POLICY_CONFIGURATIONS = (QWEN3VL_8B_CONFIGURATION,)


def _normalized(value: Any) -> str:
    return str(value or "").strip().casefold()


def _normalized_repo_url(value: Any) -> str:
    return _normalized(value).rstrip("/")


def _base_model_provenance(metadata_values: dict[str, Any]) -> tuple[bool, set[str], set[str]]:
    prefix = "general.base_model."
    entries_present = any(key.startswith(prefix) and key != "general.base_model.count" for key in metadata_values)
    count = metadata_values.get("general.base_model.count")
    provenance_present = entries_present or isinstance(count, int) and count > 0
    names = {
        _normalized(value)
        for key, value in metadata_values.items()
        if key.startswith(prefix) and key.endswith(".name") and _normalized(value)
    }
    repo_urls = {
        _normalized_repo_url(value)
        for key, value in metadata_values.items()
        if key.startswith(prefix) and key.endswith(".repo_url") and _normalized_repo_url(value)
    }
    return provenance_present, names, repo_urls


def resolve_model_lineage(
    architecture: str | None,
    metadata_name: str | None,
    metadata_values: dict[str, Any] | None = None,
) -> ModelLineageMatch | None:
    normalized_architecture = str(architecture or "").strip().lower()
    candidates = tuple(lineage for lineage in _LINEAGES if lineage.architecture == normalized_architecture)
    if not candidates:
        return None

    values = metadata_values or {}
    provenance_present, provenance_names, provenance_repo_urls = _base_model_provenance(values)
    if provenance_present:
        for lineage in candidates:
            known_names = {_normalized(value) for value in lineage.provenance_names}
            known_repo_urls = {_normalized_repo_url(value) for value in lineage.provenance_repo_urls}
            if provenance_names & known_names or provenance_repo_urls & known_repo_urls:
                return ModelLineageMatch(lineage, "provenance")
        return None

    normalized_name = _normalized(metadata_name)
    for lineage in candidates:
        if normalized_name in {_normalized(name) for name in lineage.metadata_names}:
            return ModelLineageMatch(lineage, "metadata_name")

    for lineage in candidates:
        if lineage.structural_fingerprint and all(values.get(key) == expected for key, expected in lineage.structural_fingerprint):
            return ModelLineageMatch(lineage, "structural_fingerprint")
    return None


def policy_for_lineage(lineage_id: str | None) -> GGUFModelPolicy | None:
    return next((policy for policy in _POLICIES if policy.lineage_id == lineage_id), None)


def identify_model_policy(
    architecture: str | None,
    metadata_name: str | None,
    metadata_values: dict[str, Any] | None = None,
) -> GGUFModelPolicy | None:
    match = resolve_model_lineage(architecture, metadata_name, metadata_values)
    return policy_for_lineage(match.lineage.id if match else None)


def policy_is_verified_configuration(
    policy: GGUFModelPolicy | None,
    model_path: str | Path,
    projector_path: str | Path | None,
) -> bool:
    return bool(
        policy
        and projector_path
        and Path(model_path).name.casefold() in {name.casefold() for name in policy.verified_filenames}
        and Path(projector_path).name.casefold() in {name.casefold() for name in policy.verified_projector_filenames}
    )


def non_policy_configuration_is_verified(
    architecture: str | None,
    metadata_name: str | None,
    model_path: str | Path,
    projector_path: str | Path | None,
) -> bool:
    normalized_architecture = str(architecture or "").strip().lower()
    normalized_name = str(metadata_name or "").strip().casefold()
    model_filename = Path(model_path).name.casefold()
    projector_filename = Path(projector_path).name.casefold() if projector_path else None
    return any(
        item.architecture == normalized_architecture
        and normalized_name in {name.casefold() for name in item.metadata_names}
        and model_filename in {name.casefold() for name in item.model_filenames}
        and projector_filename in {name.casefold() for name in item.projector_filenames}
        for item in _VERIFIED_NON_POLICY_CONFIGURATIONS
    )


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
