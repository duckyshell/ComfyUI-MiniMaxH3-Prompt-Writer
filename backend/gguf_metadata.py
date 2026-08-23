from __future__ import annotations

import struct
from functools import lru_cache
from pathlib import Path
from typing import Any, BinaryIO


_GGUF_MAGIC = b"GGUF"
_SUPPORTED_VERSIONS = {2, 3}
_TYPE_FORMATS = {
    0: "<B",   # uint8
    1: "<b",   # int8
    2: "<H",   # uint16
    3: "<h",   # int16
    4: "<I",   # uint32
    5: "<i",   # int32
    6: "<f",   # float32
    7: "<?",   # bool
    10: "<Q",  # uint64
    11: "<q",  # int64
    12: "<d",  # float64
}
_STRING_TYPE = 8
_ARRAY_TYPE = 9
_MAX_METADATA_COUNT = 1_000_000
_MAX_TENSOR_COUNT = 10_000_000
_MAX_STRING_BYTES = 32 * 1024 * 1024
_MAX_ARRAY_LENGTH = 100_000_000


class GGUFMetadataError(ValueError):
    pass


def _read_exact(handle: BinaryIO, size: int) -> bytes:
    value = handle.read(size)
    if len(value) != size:
        raise GGUFMetadataError("Unexpected end of GGUF metadata.")
    return value


def _read_struct(handle: BinaryIO, fmt: str) -> Any:
    return struct.unpack(fmt, _read_exact(handle, struct.calcsize(fmt)))[0]


def _read_string(handle: BinaryIO) -> str:
    length = _read_struct(handle, "<Q")
    if length > _MAX_STRING_BYTES:
        raise GGUFMetadataError(f"GGUF metadata string is too large: {length} bytes.")
    try:
        return _read_exact(handle, length).decode("utf-8")
    except UnicodeDecodeError as error:
        raise GGUFMetadataError("GGUF metadata contains invalid UTF-8.") from error


def _skip_string(handle: BinaryIO) -> None:
    length = _read_struct(handle, "<Q")
    if length > _MAX_STRING_BYTES:
        raise GGUFMetadataError(f"GGUF metadata string is too large: {length} bytes.")
    handle.seek(length, 1)


def _read_scalar(handle: BinaryIO, value_type: int) -> Any:
    if value_type == _STRING_TYPE:
        return _read_string(handle)
    fmt = _TYPE_FORMATS.get(value_type)
    if fmt is None:
        raise GGUFMetadataError(f"Unsupported GGUF metadata value type: {value_type}.")
    return _read_struct(handle, fmt)


def _skip_array(handle: BinaryIO) -> None:
    element_type = _read_struct(handle, "<I")
    length = _read_struct(handle, "<Q")
    if length > _MAX_ARRAY_LENGTH:
        raise GGUFMetadataError(f"GGUF metadata array is too large: {length} values.")
    if element_type == _STRING_TYPE:
        for _ in range(length):
            _skip_string(handle)
        return
    fmt = _TYPE_FORMATS.get(element_type)
    if fmt is None:
        raise GGUFMetadataError(f"Unsupported GGUF metadata array type: {element_type}.")
    handle.seek(struct.calcsize(fmt) * length, 1)


def _read_metadata(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        if _read_exact(handle, 4) != _GGUF_MAGIC:
            raise GGUFMetadataError("File does not have a GGUF header.")
        version = _read_struct(handle, "<I")
        if version not in _SUPPORTED_VERSIONS:
            raise GGUFMetadataError(f"Unsupported GGUF version: {version}.")
        tensor_count = _read_struct(handle, "<Q")
        metadata_count = _read_struct(handle, "<Q")
        if tensor_count > _MAX_TENSOR_COUNT:
            raise GGUFMetadataError(f"GGUF tensor count is too large: {tensor_count}.")
        if metadata_count > _MAX_METADATA_COUNT:
            raise GGUFMetadataError(f"GGUF metadata entry count is too large: {metadata_count}.")

        values: dict[str, Any] = {}
        for _ in range(metadata_count):
            key = _read_string(handle)
            value_type = _read_struct(handle, "<I")
            if value_type == _ARRAY_TYPE:
                _skip_array(handle)
            else:
                values[key] = _read_scalar(handle, value_type)

        mtp_detected = False
        for _ in range(tensor_count):
            tensor_name = _read_string(handle)
            dimension_count = _read_struct(handle, "<I")
            if dimension_count > 8:
                raise GGUFMetadataError(f"GGUF tensor has too many dimensions: {dimension_count}.")
            handle.seek(8 * dimension_count, 1)
            _read_struct(handle, "<I")  # tensor type
            _read_struct(handle, "<Q")  # tensor data offset
            normalized_tensor_name = tensor_name.lower()
            mtp_detected = mtp_detected or "mtp" in normalized_tensor_name or ".nextn." in normalized_tensor_name

    architecture = str(values.get("general.architecture") or "").strip().lower() or None
    chat_template = values.get("tokenizer.chat_template")
    if not isinstance(chat_template, str):
        chat_template = None
    arch_prefix = f"{architecture}." if architecture else ""
    return {
        "version": version,
        "tensor_count": tensor_count,
        "architecture": architecture,
        "name": values.get("general.name"),
        "context_length": values.get(f"{arch_prefix}context_length") if arch_prefix else None,
        "embedding_length": values.get(f"{arch_prefix}embedding_length") if arch_prefix else None,
        "block_count": values.get(f"{arch_prefix}block_count") if arch_prefix else None,
        "chat_template": chat_template,
        "template_controls": {
            "enable_thinking": bool(chat_template and "enable_thinking" in chat_template),
            "reasoning_effort": bool(chat_template and "reasoning_effort" in chat_template),
        },
        "projector_type": values.get("clip.projector_type") or values.get("clip.vision.projector_type"),
        "projector_projection_dim": values.get("clip.vision.projection_dim"),
        "vision_embedding_length": values.get("clip.vision.embedding_length"),
        "vision_patch_size": values.get("clip.vision.patch_size"),
        "vision_spatial_merge_size": values.get("clip.vision.spatial_merge_size"),
        "has_vision_encoder": values.get("clip.has_vision_encoder"),
        "has_audio_encoder": values.get("clip.has_audio_encoder"),
        "mtp_detected": mtp_detected or any("mtp" in key.lower() for key in values),
        "values": values,
    }


@lru_cache(maxsize=64)
def _read_gguf_metadata_cached(path_value: str, size: int, mtime_ns: int) -> dict[str, Any]:
    del size, mtime_ns
    return _read_metadata(Path(path_value))


def read_gguf_metadata(path: str | Path) -> dict[str, Any]:
    resolved = Path(path).resolve(strict=True)
    stat = resolved.stat()
    return _read_gguf_metadata_cached(str(resolved), stat.st_size, stat.st_mtime_ns).copy()
