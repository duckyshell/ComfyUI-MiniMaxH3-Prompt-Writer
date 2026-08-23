from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class GGUFArchitectureAdapter:
    id: str
    label: str
    architectures: tuple[str, ...]
    minimum_runtime: tuple[int, int, int]
    projector_types: tuple[str, ...]


GEMMA_ADAPTER = GGUFArchitectureAdapter(
    id="gemma",
    label="Gemma",
    architectures=("gemma4",),
    minimum_runtime=(0, 3, 34),
    projector_types=("gemma4uv",),
)
QWEN35_ADAPTER = GGUFArchitectureAdapter(
    id="qwen35",
    label="Qwen qwen35",
    architectures=("qwen35",),
    minimum_runtime=(0, 3, 35),
    projector_types=("qwen3vl_merger",),
)
QWEN35_MOE_ADAPTER = GGUFArchitectureAdapter(
    id="qwen35moe",
    label="Qwen qwen35moe",
    architectures=("qwen35moe",),
    minimum_runtime=(0, 3, 35),
    projector_types=("qwen3vl_merger",),
)
QWEN3VL_ADAPTER = GGUFArchitectureAdapter(
    id="qwen3vl",
    label="Qwen3-VL",
    architectures=("qwen3vl",),
    minimum_runtime=(0, 3, 35),
    projector_types=("qwen3vl_merger",),
)
QWEN3VL_MOE_ADAPTER = GGUFArchitectureAdapter(
    id="qwen3vlmoe",
    label="Qwen3-VL MoE",
    architectures=("qwen3vlmoe",),
    minimum_runtime=(0, 3, 35),
    projector_types=("qwen3vl_merger",),
)
QWEN_VISION_ADAPTER_IDS = frozenset({"qwen35", "qwen35moe", "qwen3vl", "qwen3vlmoe"})
_ADAPTERS = (
    GEMMA_ADAPTER,
    QWEN35_ADAPTER,
    QWEN35_MOE_ADAPTER,
    QWEN3VL_ADAPTER,
    QWEN3VL_MOE_ADAPTER,
)


def architecture_adapter(architecture: str | None) -> GGUFArchitectureAdapter | None:
    normalized = str(architecture or "").strip().lower()
    return next((adapter for adapter in _ADAPTERS if normalized in adapter.architectures), None)


def version_tuple(value: str | None) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", str(value or ""))[:3])


def runtime_supports(adapter: GGUFArchitectureAdapter | None, version: str | None, *, module_available: bool) -> bool:
    if adapter is None or not module_available:
        return False
    parsed = version_tuple(version)
    if not parsed:
        return adapter is GEMMA_ADAPTER
    return parsed >= adapter.minimum_runtime and parsed < (0, 4, 0)


def projector_is_compatible(
    adapter: GGUFArchitectureAdapter | None,
    model_metadata: dict[str, Any],
    projector_metadata: dict[str, Any],
) -> bool:
    if adapter is None:
        return False
    if projector_metadata.get("architecture") != "clip" or projector_metadata.get("has_vision_encoder") is not True:
        return False
    projector_type = str(projector_metadata.get("projector_type") or "").lower()
    if projector_type not in adapter.projector_types:
        return False
    model_dim = model_metadata.get("embedding_length")
    projector_dim = projector_metadata.get("projector_projection_dim")
    return isinstance(model_dim, int) and model_dim > 0 and model_dim == projector_dim
