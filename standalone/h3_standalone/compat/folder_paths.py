"""Filesystem boundary expected by the upstream Prompt Writer backend."""

from __future__ import annotations

import os
from pathlib import Path


def _paths_from_env(name: str) -> list[str]:
    return [item for item in os.environ.get(name, "").split(os.pathsep) if item]


def get_folder_paths(name: str) -> list[str]:
    if name != "LLM":
        return []
    return _paths_from_env("H3_STANDALONE_MODEL_ROOTS")


def get_temp_directory() -> str:
    value = os.environ.get("H3_STANDALONE_TEMP")
    path = Path(value) if value else Path.cwd() / "data" / "tmp"
    path.mkdir(parents=True, exist_ok=True)
    return str(path.resolve())
