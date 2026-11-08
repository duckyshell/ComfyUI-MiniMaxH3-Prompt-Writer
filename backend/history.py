"""Persistent prompt history for the H3 video workspace.

Each generated prompt is stored as one folder under the ComfyUI user directory:

    <user>/h3_prompt_writer/history/<entry id>/entry.json
    <user>/h3_prompt_writer/history/<entry id>/thumb_<n>.jpg
    <user>/h3_prompt_writer/history/<entry id>/media_<n>.<ext>   (pictures only)

Writer's session media lives in ComfyUI's temp directory, which is wiped on every
restart, so history keeps its own copies of the pictures and video posters.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import folder_paths
from PIL import Image, ImageOps


VIDEO_MODES = {"T2VA", "I2VA", "FL2VA", "L2VA", "Reference"}
MAX_ENTRIES = 150
MAX_TEXT_CHARS = 40_000
THUMB_SIZE = 320
_LOCK = threading.RLock()


class HistoryError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _default_root() -> Path:
    getter = getattr(folder_paths, "get_user_directory", None)
    base = Path(getter()) if callable(getter) else Path(folder_paths.get_temp_directory())
    return base / "h3_prompt_writer" / "history"


HISTORY_ROOT = _default_root()


def _entry_dir(root: Path, entry_id: str) -> Path:
    try:
        normalized = str(UUID(entry_id))
    except (ValueError, TypeError) as error:
        raise HistoryError("HISTORY_NOT_FOUND", "The history entry was not found.") from error
    return root / normalized


def _text(value: Any) -> str:
    return str(value or "")[:MAX_TEXT_CHARS]


def _save_thumbnail(source: Path, target: Path) -> None:
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((THUMB_SIZE, THUMB_SIZE))
        if image.mode not in {"RGB", "L"}:
            image = image.convert("RGB")
        image.save(target, "JPEG", quality=82, optimize=True)


def _copy_assets(assets: list[dict[str, Any]], target_dir: Path) -> list[dict[str, Any]]:
    saved: list[dict[str, Any]] = []
    for index, asset in enumerate(assets):
        record: dict[str, Any] = {
            "type": asset.get("type"),
            "reference": asset.get("reference"),
            "filename": asset.get("filename"),
            "thumb": None,
            "media": None,
        }
        preview = asset.get("_preview_path") or (asset.get("_original_path") if asset.get("type") == "image" else None)
        if preview and Path(preview).is_file():
            thumb_name = f"thumb_{index}.jpg"
            try:
                _save_thumbnail(Path(preview), target_dir / thumb_name)
                record["thumb"] = thumb_name
            except Exception:
                record["thumb"] = None
        if asset.get("type") == "image":
            source = asset.get("_edited_path") or asset.get("_original_path")
            if source and Path(source).is_file():
                media_name = f"media_{index}{Path(source).suffix.lower() or '.png'}"
                shutil.copyfile(source, target_dir / media_name)
                record["media"] = media_name
        saved.append(record)
    return saved


def public_entry(entry: dict[str, Any], prefix: str) -> dict[str, Any]:
    result = dict(entry)
    result["assets"] = []
    for index, asset in enumerate(entry.get("assets", [])):
        item = {key: asset.get(key) for key in ("type", "reference", "filename")}
        if asset.get("thumb"):
            item["thumb_url"] = f"{prefix}/history/{entry['id']}/file/thumb/{index}"
        if asset.get("media"):
            item["media_url"] = f"{prefix}/history/{entry['id']}/file/media/{index}"
        result["assets"].append(item)
    return result


def add_entry(payload: dict[str, Any], assets: list[dict[str, Any]], *, root: Path | None = None, now: float | None = None) -> dict[str, Any]:
    root = root or HISTORY_ROOT
    mode = payload.get("mode")
    if mode not in VIDEO_MODES:
        raise HistoryError("INVALID_MODE", "History is available for H3 video modes only.")
    prompt = _text(payload.get("prompt")).strip()
    if not prompt:
        raise HistoryError("EMPTY_PROMPT", "There is no prompt to save.")
    entry_id = str(uuid4())
    target_dir = root / entry_id
    with _LOCK:
        target_dir.mkdir(parents=True, exist_ok=True)
        try:
            entry = {
                "id": entry_id,
                "created_at": time.time() if now is None else now,
                "mode": mode,
                "brief": _text(payload.get("brief")),
                "prompt": prompt,
                "duration": payload.get("duration"),
                "aspect_ratio": payload.get("aspect_ratio"),
                "model": _text(payload.get("model"))[:300],
                "assets": _copy_assets(assets, target_dir),
            }
            (target_dir / "entry.json").write_text(json.dumps(entry, ensure_ascii=False, indent=1), encoding="utf-8")
        except Exception:
            shutil.rmtree(target_dir, ignore_errors=True)
            raise
        _prune(root)
    return entry


def list_entries(*, root: Path | None = None) -> list[dict[str, Any]]:
    root = root or HISTORY_ROOT
    entries: list[dict[str, Any]] = []
    if not root.is_dir():
        return entries
    for folder in root.iterdir():
        manifest = folder / "entry.json"
        if not manifest.is_file():
            continue
        try:
            entries.append(json.loads(manifest.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    entries.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    return entries


def delete_entry(entry_id: str, *, root: Path | None = None) -> None:
    root = root or HISTORY_ROOT
    folder = _entry_dir(root, entry_id)
    with _LOCK:
        if not (folder / "entry.json").is_file():
            raise HistoryError("HISTORY_NOT_FOUND", "The history entry was not found.")
        shutil.rmtree(folder)


def clear_entries(*, root: Path | None = None) -> int:
    root = root or HISTORY_ROOT
    removed = 0
    with _LOCK:
        for entry in list_entries(root=root):
            shutil.rmtree(root / entry["id"], ignore_errors=True)
            removed += 1
    return removed


def entry_file(entry_id: str, kind: str, index: int, *, root: Path | None = None) -> Path:
    root = root or HISTORY_ROOT
    folder = _entry_dir(root, entry_id)
    manifest = folder / "entry.json"
    if kind not in {"thumb", "media"} or not manifest.is_file():
        raise HistoryError("HISTORY_NOT_FOUND", "The history file was not found.")
    entry = json.loads(manifest.read_text(encoding="utf-8"))
    assets = entry.get("assets", [])
    if not 0 <= index < len(assets) or not assets[index].get(kind):
        raise HistoryError("HISTORY_NOT_FOUND", "The history file was not found.")
    path = (folder / assets[index][kind]).resolve()
    try:
        path.relative_to(folder.resolve())
    except ValueError as error:
        raise HistoryError("HISTORY_NOT_FOUND", "The history file was not found.") from error
    if not path.is_file():
        raise HistoryError("HISTORY_NOT_FOUND", "The history file was not found.")
    return path


def _prune(root: Path) -> None:
    for entry in list_entries(root=root)[MAX_ENTRIES:]:
        shutil.rmtree(root / entry["id"], ignore_errors=True)
