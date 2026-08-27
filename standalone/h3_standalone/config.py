from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PATH = PACKAGE_ROOT / "data" / "settings.json"
DEFAULT_PORT = 8765


@dataclass(frozen=True)
class Settings:
    upstream_repo: Path
    model_roots: tuple[Path, ...]
    port: int = DEFAULT_PORT
    open_browser: bool = True


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _resolve_path(value: str | os.PathLike[str], *, base: Path = PACKAGE_ROOT) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _default_upstream() -> Path:
    vendored = PACKAGE_ROOT / "upstream"
    if (vendored / "backend" / "routes.py").is_file():
        return vendored.resolve()
    repository = PACKAGE_ROOT.parent
    if (repository / "backend" / "routes.py").is_file() and (repository / "web" / "main.js").is_file():
        return repository.resolve()
    return (PACKAGE_ROOT.parent.parent / "prompt-writer" / "repo").resolve()


def _normalize_roots(values: Iterable[str | os.PathLike[str]]) -> tuple[Path, ...]:
    roots: list[Path] = []
    seen: set[str] = set()
    for value in values:
        if not str(value).strip():
            continue
        root = _resolve_path(value)
        key = os.path.normcase(str(root))
        if key in seen:
            continue
        seen.add(key)
        roots.append(root)
    return tuple(roots)


def load_settings(
    *,
    upstream_override: str | None = None,
    model_root_overrides: Iterable[str] = (),
    port_override: int | None = None,
    no_browser: bool = False,
) -> Settings:
    raw = _read_json(SETTINGS_PATH)
    upstream_value = (
        upstream_override
        or os.environ.get("H3_WRITER_UPSTREAM")
        or str(raw.get("upstream_repo") or "").strip()
    )
    upstream = _resolve_path(upstream_value) if upstream_value else _default_upstream()

    configured_roots = raw.get("model_roots")
    if not isinstance(configured_roots, list):
        configured_roots = []
    env_roots = [item for item in os.environ.get("H3_WRITER_MODEL_ROOTS", "").split(os.pathsep) if item]
    roots = _normalize_roots([*configured_roots, *env_roots, *model_root_overrides])

    raw_port = port_override if port_override is not None else raw.get("port", DEFAULT_PORT)
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    if not 0 <= port <= 65535:
        port = DEFAULT_PORT

    return Settings(
        upstream_repo=upstream,
        model_roots=roots,
        port=port,
        open_browser=bool(raw.get("open_browser", True)) and not no_browser,
    )


def validate_upstream(path: Path) -> None:
    required = (path / "backend" / "routes.py", path / "web" / "main.js")
    missing = [str(item) for item in required if not item.is_file()]
    if missing:
        raise FileNotFoundError(
            "Prompt Writer upstream repo was not found. Expected: " + ", ".join(missing)
        )
