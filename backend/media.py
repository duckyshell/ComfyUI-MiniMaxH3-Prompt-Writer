from __future__ import annotations

import mimetypes
import shutil
import math
import time
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import av
import folder_paths
from PIL import Image, ImageDraw, ImageFont, ImageOps


CACHE_ROOT = Path(folder_paths.get_temp_directory()) / "h3_prompt_studio"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".opus"}
MAX_FILE_BYTES = 1024 * 1024 * 1024
REFERENCE_LIMITS = {"image": 9, "video": 3, "audio": 3, "total": 12}
REFERENCE_DURATION_TOLERANCE_SECONDS = 15.1
CONTACT_SHEET_INDEX_BASE_SIZE = 18
CONTACT_SHEET_INDEX_SCALE = 1.75
MODE_LIMITS = {
    "T2VA": {},
    "I2VA": {"image": 1},
    "FL2VA": {"image": 2},
    "L2VA": {"image": 1},
    "Reference": REFERENCE_LIMITS,
}


def _reset_cache() -> None:
    if CACHE_ROOT.exists():
        shutil.rmtree(CACHE_ROOT)
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)


_reset_cache()


def parse_session_id(value: str | None) -> str:
    if not value:
        return str(uuid4())
    return str(UUID(value))


def media_type(filename: str, content_type: str | None = None) -> str | None:
    extension = Path(filename).suffix.lower()
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension in VIDEO_EXTENSIONS:
        return "video"
    if extension in AUDIO_EXTENSIONS:
        return "audio"
    major = (content_type or "").split("/", 1)[0]
    return major if major in {"image", "video", "audio"} else None


def validate_capacity(mode: str, assets: list[dict[str, Any]], kind: str) -> None:
    limits = MODE_LIMITS.get(mode)
    if limits is None:
        raise MediaError("INVALID_MODE", "The selected MiniMax mode is not supported.")
    if kind not in limits:
        raise MediaError("UNSUPPORTED_MEDIA", f"{mode} does not accept {kind} files.")
    mode_assets = [asset for asset in assets if asset["mode"] == mode]
    if len([asset for asset in mode_assets if asset["type"] == kind]) >= limits[kind]:
        raise MediaError("MEDIA_LIMIT_REACHED", f"{mode} has reached its {kind} limit.")
    if mode == "Reference" and len(mode_assets) >= REFERENCE_LIMITS["total"]:
        raise MediaError("MEDIA_LIMIT_REACHED", "Reference mode accepts at most 12 files in total.")


def validate_reference_durations(_assets: list[dict[str, Any]], incoming: dict[str, Any]) -> None:
    if incoming["mode"] != "Reference" or incoming["type"] not in {"video", "audio"}:
        return
    duration = incoming.get("duration")
    if duration is None or duration < 2 or duration > REFERENCE_DURATION_TOLERANCE_SECONDS:
        raise MediaError("UNSUPPORTED_DURATION", "Reference video and audio clips must be 2–15 seconds long.")


class MediaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class MediaStore:
    def __init__(self) -> None:
        self.sessions: dict[str, list[dict[str, Any]]] = {}
        self.last_accessed: dict[str, float] = {}

    def touch(self, session_id: str, *, now: float | None = None) -> None:
        self.last_accessed[session_id] = time.monotonic() if now is None else now

    def list(self, session_id: str) -> list[dict[str, Any]]:
        if session_id in self.sessions:
            self.touch(session_id)
        return [self.public(asset) for asset in self.sessions.get(session_id, [])]

    def assets(self, session_id: str) -> list[dict[str, Any]]:
        self.touch(session_id)
        return self.sessions.setdefault(session_id, [])

    def _get_asset(self, session_id: str, asset_id: str) -> dict[str, Any]:
        asset = next((item for item in self.sessions.get(session_id, []) if item["id"] == asset_id), None)
        if asset is None:
            raise MediaError("MEDIA_NOT_FOUND", "The media asset was not found in this session.")
        return asset

    def get(self, session_id: str, asset_id: str) -> dict[str, Any]:
        asset = self._get_asset(session_id, asset_id)
        self.touch(session_id)
        return asset

    def read_model_visual(self, session_id: str, asset_id: str, representation: str) -> tuple[str, bytes]:
        asset = self.get(session_id, asset_id)
        if representation == "image" and asset["type"] == "image":
            stored_path = asset.get("_prepared_path") or asset.get("_original_path")
        elif representation == "contact_sheet" and asset["type"] == "video":
            stored_path = asset.get("_contact_sheet_path")
        else:
            raise MediaError("UNSUPPORTED_MEDIA", "The requested model visual does not match this asset.")
        if not stored_path:
            raise MediaError("MEDIA_NOT_FOUND", "The prepared model visual is missing.")

        cache_root = CACHE_ROOT.resolve()
        session_root = (CACHE_ROOT / session_id).resolve()
        asset_root = Path(asset["_original_path"]).resolve().parent
        visual_path = Path(stored_path).resolve()
        try:
            session_root.relative_to(cache_root)
            asset_root.relative_to(session_root)
            visual_path.relative_to(asset_root)
        except ValueError as error:
            raise MediaError("MEDIA_PATH_INVALID", "The prepared model visual is outside this Writer session.") from error
        if not visual_path.is_file():
            raise MediaError("MEDIA_NOT_FOUND", "The prepared model visual is missing.")

        with visual_path.open("rb") as source:
            payload = source.read()
        media_type = mimetypes.guess_type(visual_path.name)[0] or "image/png"
        return media_type, payload

    def public(self, asset: dict[str, Any]) -> dict[str, Any]:
        result = {key: value for key, value in asset.items() if not key.startswith("_")}
        result["content_url"] = f"/h3studio/media/{asset['id']}/content?session_id={asset['session_id']}"
        content_revision = asset.get("content_revision", asset.get("sample_index", 0))
        if asset.get("_preview_path"):
            result["preview_url"] = f"{result['content_url']}&kind=preview&revision={content_revision}"
        if asset.get("_contact_sheet_path"):
            result["contact_sheet_url"] = f"{result['content_url']}&kind=sheet&revision={content_revision}"
        result["frames"] = [
            {
                "timestamp": frame["timestamp"],
                "url": f"{result['content_url']}&kind=frame&index={index}&revision={content_revision}",
            }
            for index, frame in enumerate(asset.get("_frames", []))
        ]
        return result

    def add(self, session_id: str, mode: str, filename: str, content_type: str | None, stored_path: Path) -> dict[str, Any]:
        prepared = self.prepare_add(session_id, mode, filename, content_type, stored_path)
        return self.commit_add(session_id, mode, prepared)

    def prepare_add(
        self,
        session_id: str,
        mode: str,
        filename: str,
        content_type: str | None,
        stored_path: Path,
    ) -> dict[str, Any]:
        kind = media_type(filename, content_type)
        if kind is None:
            raise MediaError("UNSUPPORTED_MEDIA", "This file type is not supported.")
        assets = list(self.sessions.get(session_id, []))
        validate_capacity(mode, assets, kind)
        return self._prepare_asset(session_id, mode, filename, content_type, stored_path, assets)

    def commit_add(self, session_id: str, mode: str, base: dict[str, Any]) -> dict[str, Any]:
        assets = self.assets(session_id)
        validate_capacity(mode, assets, base["type"])
        validate_reference_durations(assets, base)
        assets.append(base)
        self._renumber(assets, mode)
        return self.public(base)

    def _prepare_asset(
        self,
        session_id: str,
        mode: str,
        filename: str,
        content_type: str | None,
        stored_path: Path,
        assets: list[dict[str, Any]],
    ) -> dict[str, Any]:
        kind = media_type(filename, content_type)
        if kind is None:
            raise MediaError("UNSUPPORTED_MEDIA", "This file type is not supported.")
        asset_id = stored_path.parent.name
        base: dict[str, Any] = {
            "id": asset_id,
            "session_id": session_id,
            "mode": mode,
            "type": kind,
            "filename": Path(filename).name,
            "size": stored_path.stat().st_size,
            "mime_type": (
                content_type
                if content_type and content_type != "application/octet-stream"
                else mimetypes.guess_type(filename)[0] or "application/octet-stream"
            ),
            "_original_path": str(stored_path),
        }
        try:
            if kind == "image":
                base.update(process_image(stored_path, stored_path.parent))
            elif kind == "video":
                base.update(process_video(stored_path, stored_path.parent))
            else:
                base.update(process_audio(stored_path))
            validate_reference_durations(assets, base)
        except MediaError:
            raise
        except Exception as exc:
            raise MediaError("MEDIA_DECODE_FAILED", f"Could not decode {kind} file: {exc}") from exc
        return base

    def replace(
        self,
        session_id: str,
        asset_id: str,
        filename: str,
        content_type: str | None,
        stored_path: Path,
    ) -> dict[str, Any]:
        replacement = self.prepare_replace(session_id, asset_id, filename, content_type, stored_path)
        return self.commit_replace(session_id, asset_id, replacement)

    def prepare_replace(
        self,
        session_id: str,
        asset_id: str,
        filename: str,
        content_type: str | None,
        stored_path: Path,
    ) -> dict[str, Any]:
        old_asset = self._get_asset(session_id, asset_id)
        assets = list(self.sessions[session_id])
        kind = media_type(filename, content_type)
        if kind is None:
            raise MediaError("UNSUPPORTED_MEDIA", "This file type is not supported.")
        remaining = [asset for asset in assets if asset is not old_asset]
        validate_capacity(old_asset["mode"], remaining, kind)
        return self._prepare_asset(
            session_id,
            old_asset["mode"],
            filename,
            content_type,
            stored_path,
            remaining,
        )

    def commit_replace(self, session_id: str, asset_id: str, replacement: dict[str, Any]) -> dict[str, Any]:
        old_asset = self.get(session_id, asset_id)
        assets = self.sessions[session_id]
        if replacement["mode"] != old_asset["mode"]:
            raise MediaError("INVALID_REPLACEMENT", "The prepared replacement no longer matches the selected asset.")
        remaining = [asset for asset in assets if asset is not old_asset]
        validate_capacity(old_asset["mode"], remaining, replacement["type"])
        validate_reference_durations(remaining, replacement)
        index = assets.index(old_asset)
        replacement["id"] = old_asset["id"]
        replacement["content_revision"] = int(old_asset.get("content_revision", 0)) + 1
        assets[index] = replacement
        self._renumber(assets, old_asset["mode"])
        shutil.rmtree(Path(old_asset["_original_path"]).parent, ignore_errors=True)
        return self.public(replacement)

    def remove(self, session_id: str, asset_id: str) -> None:
        asset = self.get(session_id, asset_id)
        assets = self.sessions[session_id]
        assets.remove(asset)
        shutil.rmtree(Path(asset["_original_path"]).parent, ignore_errors=True)
        self._renumber(assets, asset["mode"])

    def clear(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)
        self.last_accessed.pop(session_id, None)
        shutil.rmtree(CACHE_ROOT / session_id, ignore_errors=True)

    def expire_sessions(
        self,
        *,
        now: float,
        max_age_seconds: float,
        exclude: set[str] | None = None,
    ) -> list[Path]:
        excluded = exclude or set()
        expired = [
            session_id
            for session_id, accessed_at in self.last_accessed.items()
            if session_id not in excluded and now - accessed_at >= max_age_seconds
        ]
        directories = [CACHE_ROOT / session_id for session_id in expired]
        for session_id in expired:
            self.sessions.pop(session_id, None)
            self.last_accessed.pop(session_id, None)
        return directories

    def clear_mode(self, session_id: str, mode: str) -> list[dict[str, Any]]:
        if mode not in MODE_LIMITS:
            raise MediaError("INVALID_MODE", "The selected MiniMax mode is not supported.")
        assets = self.sessions.get(session_id, [])
        removed = [asset for asset in assets if asset["mode"] == mode]
        remaining = [asset for asset in assets if asset["mode"] != mode]
        if remaining:
            self.sessions[session_id] = remaining
            self.touch(session_id)
        else:
            self.sessions.pop(session_id, None)
            self.last_accessed.pop(session_id, None)
        for asset in removed:
            shutil.rmtree(Path(asset["_original_path"]).parent, ignore_errors=True)
        session_dir = CACHE_ROOT / session_id
        if session_dir.exists() and not any(session_dir.iterdir()):
            session_dir.rmdir()
        return self.list(session_id)

    def resample(
        self,
        session_id: str,
        asset_id: str,
        frame_count_mode: str | None = None,
        include_endpoints: bool | None = None,
    ) -> dict[str, Any]:
        prepared = self.prepare_resample(session_id, asset_id, frame_count_mode, include_endpoints)
        return self.commit_resample(session_id, asset_id, prepared)

    def prepare_resample(
        self,
        session_id: str,
        asset_id: str,
        frame_count_mode: str | None = None,
        include_endpoints: bool | None = None,
    ) -> dict[str, Any]:
        asset = self._get_asset(session_id, asset_id)
        if asset["type"] != "video":
            raise MediaError("UNSUPPORTED_MEDIA", "Only video assets can be resampled.")
        requested_count = asset.get("frame_count_mode", "auto") if frame_count_mode is None else frame_count_mode
        selected_count = _normalize_frame_count_mode(requested_count)
        selected_endpoints = asset.get("include_endpoints", True) if include_endpoints is None else include_endpoints
        if not isinstance(selected_endpoints, bool):
            raise MediaError("INVALID_SAMPLE_ENDPOINTS", "Include first & last frame must be true or false.")
        settings_changed = (
            selected_count != asset.get("frame_count_mode", "auto")
            or selected_endpoints != asset.get("include_endpoints", True)
        )
        sample_index = 0 if settings_changed else int(asset.get("sample_index", 0)) + 1
        content_revision = int(asset.get("content_revision", 0)) + 1
        asset_dir = Path(asset["_original_path"]).parent
        derived_dir = asset_dir / f"derived_{uuid4()}"
        derived_dir.mkdir(parents=False, exist_ok=False)
        try:
            processed = process_video(
                Path(asset["_original_path"]),
                derived_dir,
                frame_count_mode=selected_count,
                include_endpoints=selected_endpoints,
                sample_index=sample_index,
            )
        except MediaError:
            shutil.rmtree(derived_dir, ignore_errors=True)
            raise
        except Exception as exc:
            shutil.rmtree(derived_dir, ignore_errors=True)
            raise MediaError("MEDIA_DECODE_FAILED", f"Could not resample video file: {exc}") from exc
        old_paths = {
            Path(value)
            for value in [asset.get("_preview_path"), asset.get("_contact_sheet_path")]
            if value
        } | {Path(frame["path"]) for frame in asset.get("_frames", [])}
        return {
            "asset_id": asset_id,
            "source_path": asset["_original_path"],
            "source_revision": int(asset.get("content_revision", 0)),
            "processed": processed,
            "content_revision": content_revision,
            "old_paths": old_paths,
            "asset_dir": asset_dir,
            "derived_dir": derived_dir,
        }

    def commit_resample(self, session_id: str, asset_id: str, prepared: dict[str, Any]) -> dict[str, Any]:
        asset = self.get(session_id, asset_id)
        if (
            asset["_original_path"] != prepared["source_path"]
            or int(asset.get("content_revision", 0)) != prepared["source_revision"]
        ):
            shutil.rmtree(prepared["derived_dir"], ignore_errors=True)
            raise MediaError("MEDIA_CHANGED", "The video changed while it was being resampled. Try again.")
        asset.update(prepared["processed"])
        asset["content_revision"] = prepared["content_revision"]
        old_paths = prepared["old_paths"]
        asset_dir = prepared["asset_dir"]
        for path in old_paths:
            if path != Path(asset["_original_path"]):
                path.unlink(missing_ok=True)
        for parent in {path.parent for path in old_paths}:
            if parent != asset_dir and parent.exists():
                shutil.rmtree(parent, ignore_errors=True)
        return self.public(asset)

    def reorder(self, session_id: str, mode: str, ordered_ids: list[str]) -> list[dict[str, Any]]:
        assets = self.assets(session_id)
        mode_assets = [asset for asset in assets if asset["mode"] == mode]
        if len(ordered_ids) != len(mode_assets) or set(ordered_ids) != {asset["id"] for asset in mode_assets}:
            raise MediaError("INVALID_MEDIA_ORDER", "The media order does not match the active mode assets.")
        by_id = {asset["id"]: asset for asset in mode_assets}
        ordered = iter(by_id[asset_id] for asset_id in ordered_ids)
        self.sessions[session_id] = [next(ordered) if asset["mode"] == mode else asset for asset in assets]
        self._renumber(self.sessions[session_id], mode)
        return self.list(session_id)

    def manifest(self, session_id: str, mode: str) -> dict[str, Any]:
        if session_id in self.sessions:
            self.touch(session_id)
        assets = [asset for asset in self.sessions.get(session_id, []) if asset["mode"] == mode]
        violations: list[dict[str, str]] = []
        if mode == "Reference":
            types = {asset["type"] for asset in assets}
            if types == {"audio"}:
                violations.append({
                    "code": "AUDIO_REQUIRES_VISUAL_REFERENCE",
                    "message": "Reference audio must be accompanied by an image or video.",
                })
        return {
            "session_id": session_id,
            "mode": mode,
            "assets": [self.public(asset) for asset in assets],
            "counts": {kind: len([asset for asset in assets if asset["type"] == kind]) for kind in ("image", "video", "audio")},
            "violations": violations,
            "valid": not violations,
        }

    @staticmethod
    def _renumber(assets: list[dict[str, Any]], mode: str) -> None:
        per_type = {"image": 0, "video": 0, "audio": 0}
        for asset in [item for item in assets if item["mode"] == mode]:
            per_type[asset["type"]] += 1
            if mode == "Reference":
                names = {"image": "Picture", "video": "Video", "audio": "Audio"}
                asset["reference"] = f"<{names[asset['type']]} {per_type[asset['type']]}>"
            elif mode == "FL2VA":
                asset["reference"] = "First frame" if per_type["image"] == 1 else "Last frame"
            elif mode == "I2VA":
                asset["reference"] = "Start image"
            elif mode == "L2VA":
                asset["reference"] = "Last frame"


def process_image(source: Path, target_dir: Path) -> dict[str, Any]:
    preview_path = target_dir / "preview.jpg"
    prepared_path = target_dir / "prepared.jpg"
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        width, height = image.size
        prepared = image.copy()
        prepared.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
        prepared_width, prepared_height = prepared.size
        prepared.save(prepared_path, "JPEG", quality=92, optimize=True)
        preview = image.copy()
        preview.thumbnail((640, 640), Image.Resampling.LANCZOS)
        preview.save(preview_path, "JPEG", quality=84, optimize=True)
    return {
        "width": width,
        "height": height,
        "prepared_width": prepared_width,
        "prepared_height": prepared_height,
        "_prepared_path": str(prepared_path),
        "_preview_path": str(preview_path),
    }


def _av_metadata(source: Path) -> dict[str, Any]:
    with av.open(str(source)) as container:
        video = next(iter(container.streams.video), None)
        audio = next(iter(container.streams.audio), None)
        duration = float(container.duration / av.time_base) if container.duration else None
        if duration is None and video and video.duration is not None and video.time_base is not None:
            duration = float(video.duration * video.time_base)
        return {
            "duration": round(duration, 3) if duration is not None else None,
            "width": video.width if video else None,
            "height": video.height if video else None,
            "has_audio": audio is not None,
            "sample_rate": audio.rate if audio else None,
            "channels": audio.codec_context.channels if audio else None,
        }


def _normalize_frame_count_mode(value: Any) -> str:
    if value == "auto":
        return "auto"
    if isinstance(value, bool):
        raise MediaError("INVALID_SAMPLE_COUNT", "Frame count must be Auto or a whole number from 2 to 16.")
    if isinstance(value, int):
        count = value
    elif isinstance(value, str) and value.strip().isdigit():
        count = int(value.strip())
    else:
        raise MediaError("INVALID_SAMPLE_COUNT", "Frame count must be Auto or a whole number from 2 to 16.")
    if count < 2 or count > 16:
        raise MediaError("INVALID_SAMPLE_COUNT", "Frame count must be Auto or a whole number from 2 to 16.")
    return str(count)


def _selected_frame_count(frame_count_mode: str) -> int:
    normalized = _normalize_frame_count_mode(frame_count_mode)
    return 6 if normalized == "auto" else int(normalized)


def process_video(
    source: Path,
    target_dir: Path,
    *,
    frame_count_mode: str = "auto",
    include_endpoints: bool = True,
    sample_index: int = 0,
) -> dict[str, Any]:
    frame_count_mode = _normalize_frame_count_mode(frame_count_mode)
    metadata = _av_metadata(source)
    duration = metadata["duration"]
    if not duration or duration <= 0:
        raise MediaError("MEDIA_DECODE_FAILED", "Video duration could not be determined.")
    count = _selected_frame_count(frame_count_mode)
    margin = min(0.25, duration * 0.03)
    span = duration - 2 * margin
    offsets = (0.0, -0.22, 0.22, -0.11, 0.11)
    offset = offsets[sample_index % len(offsets)]
    if include_endpoints:
        positions = [0.0, *[
            min(0.999, max(0.001, index / (count - 1) + offset / (count - 1)))
            for index in range(1, count - 1)
        ], 1.0]
    else:
        positions = [min(0.999, max(0.001, (index + 0.5 + offset) / count)) for index in range(count)]
    times = [margin + span * position for position in positions]

    frames: list[dict[str, Any]] = []
    with av.open(str(source)) as container:
        video = next(iter(container.streams.video), None)
        if video is None or video.time_base is None:
            raise MediaError("MEDIA_DECODE_FAILED", "Video stream metadata could not be determined.")
        for index, timestamp in enumerate(times):
            target_pts = max(0, int(timestamp / float(video.time_base)))
            container.seek(target_pts, stream=video, backward=True, any_frame=False)
            selected = None
            for decoded in container.decode(video):
                selected = decoded
                frame_time = decoded.time
                if frame_time is None and decoded.pts is not None:
                    frame_time = float(decoded.pts * video.time_base)
                if frame_time is not None and frame_time >= timestamp:
                    break
            if selected is None:
                continue
            image = selected.to_image().convert("RGB")
            image.thumbnail((768, 768), Image.Resampling.LANCZOS)
            frame_path = target_dir / f"frame_{index:02d}.jpg"
            image.save(frame_path, "JPEG", quality=88, optimize=True)
            frames.append({"timestamp": round(timestamp, 3), "path": str(frame_path)})
    if not frames:
        raise MediaError("MEDIA_DECODE_FAILED", "No video frames could be sampled.")
    contact_sheet_path = target_dir / "motion_contact_sheet.jpg"
    contact_sheet_width, contact_sheet_height = _build_contact_sheet(frames, contact_sheet_path)
    metadata["_frames"] = frames
    metadata["_contact_sheet_path"] = str(contact_sheet_path)
    metadata["contact_sheet_width"] = contact_sheet_width
    metadata["contact_sheet_height"] = contact_sheet_height
    metadata["_preview_path"] = frames[0]["path"]
    metadata["sampling"] = "uniform"
    metadata["frame_count_mode"] = frame_count_mode
    metadata["frame_count"] = count
    metadata["include_endpoints"] = include_endpoints
    metadata["sample_index"] = sample_index
    return metadata


def _contact_sheet_columns(frame_count: int) -> int:
    if frame_count <= 4:
        return 2
    return 3 if frame_count <= 6 else 4


def _build_contact_sheet(frames: list[dict[str, Any]], target: Path) -> tuple[int, int]:
    columns = _contact_sheet_columns(len(frames))
    rows = math.ceil(len(frames) / columns)
    cell_width = 384
    with Image.open(frames[0]["path"]) as first:
        source_width, source_height = first.size
    cell_height = max(216, min(512, round(cell_width * source_height / max(source_width, 1))))
    gutter_height = 40
    cell_total_height = cell_height + gutter_height
    sheet = Image.new("RGB", (columns * cell_width, rows * cell_total_height), "#101216")
    draw = ImageDraw.Draw(sheet)
    index_font = ImageFont.load_default(size=CONTACT_SHEET_INDEX_BASE_SIZE * CONTACT_SHEET_INDEX_SCALE)
    for index, frame in enumerate(frames):
        with Image.open(frame["path"]) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
            fitted = ImageOps.contain(image, (cell_width, cell_height), Image.Resampling.LANCZOS)
        column = index % columns
        row = index // columns
        left = column * cell_width + (cell_width - fitted.width) // 2
        cell_top = row * cell_total_height
        top = cell_top + gutter_height + (cell_height - fitted.height) // 2
        sheet.paste(fitted, (left, top))
        draw.text((column * cell_width + 10, cell_top + 4), str(index + 1), font=index_font, fill=(183, 188, 198))
    sheet.save(target, "JPEG", quality=90, optimize=True)
    return sheet.size


def process_audio(source: Path) -> dict[str, Any]:
    metadata = _av_metadata(source)
    if metadata["duration"] is None:
        raise MediaError("MEDIA_DECODE_FAILED", "Audio duration could not be determined.")
    metadata.pop("width", None)
    metadata.pop("height", None)
    metadata.pop("has_audio", None)
    return metadata


STORE = MediaStore()
