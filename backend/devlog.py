from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEVELOPER_MODE = os.getenv("H3PROMPTWRITER_DEV_MODE", os.getenv("H3STUDIO_DEV_MODE", "0")).strip().lower() not in {"0", "false", "off", "no"}


def _default_log_path() -> Path:
    override = os.getenv("H3PROMPTWRITER_DEV_LOG_PATH") or os.getenv("H3STUDIO_DEV_LOG_PATH")
    if override:
        return Path(override).expanduser()
    state_root = os.getenv("LOCALAPPDATA") or os.getenv("XDG_STATE_HOME")
    if state_root:
        return Path(state_root) / "H3PromptWriter" / "logs" / "generations.jsonl"
    return Path.home() / ".local" / "state" / "H3PromptWriter" / "logs" / "generations.jsonl"


LOG_PATH = _default_log_path()
_LOCK = threading.Lock()


def gpu_memory_snapshot() -> dict[str, int] | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        divisor = 1024 * 1024
        return {
            "used_mb": round((total_bytes - free_bytes) / divisor),
            "free_mb": round(free_bytes / divisor),
            "total_mb": round(total_bytes / divisor),
            "torch_allocated_mb": round(torch.cuda.memory_allocated() / divisor),
            "torch_reserved_mb": round(torch.cuda.memory_reserved() / divisor),
        }
    except Exception:
        return None


class PeakVRAMMonitor:
    def __init__(self) -> None:
        self.peak_used_mb = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _sample(self) -> None:
        snapshot = gpu_memory_snapshot()
        if snapshot:
            self.peak_used_mb = max(self.peak_used_mb, snapshot["used_mb"])

    def start(self) -> None:
        self._sample()

        def monitor() -> None:
            while not self._stop.wait(0.5):
                self._sample()

        self._thread = threading.Thread(target=monitor, name="h3promptwriter-vram", daemon=True)
        self._thread.start()

    def stop(self) -> int:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
            self._thread = None
        self._sample()
        return self.peak_used_mb


def write_event(event: str, **fields: Any) -> None:
    if not DEVELOPER_MODE:
        return
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "event": event,
        "gpu_memory": gpu_memory_snapshot(),
        **fields,
    }
    try:
        with _LOCK:
            LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with LOG_PATH.open("a", encoding="utf-8") as output:
                output.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except OSError:
        # Developer logging must never break a generation request.
        pass
