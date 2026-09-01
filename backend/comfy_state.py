from __future__ import annotations

from typing import Any, Callable


def comfyui_runtime_snapshot(
    prompt_queue: Any | None,
    *,
    loaded_models_fn: Callable[[], list[Any]] | None = None,
) -> dict[str, Any]:
    """Return the small, read-only ComfyUI state needed by Auto VRAM."""
    if prompt_queue is None:
        return {
            "available": False,
            "queue_running": None,
            "queue_pending": None,
            "loaded_models": None,
        }

    try:
        if loaded_models_fn is None:
            from comfy.model_management import loaded_models

            loaded_models_fn = loaded_models
        running, pending = prompt_queue.get_current_queue_volatile()
        return {
            "available": True,
            "queue_running": len(running),
            "queue_pending": len(pending),
            "loaded_models": len(loaded_models_fn()),
        }
    except Exception:  # ComfyUI state is diagnostic; status must remain available.
        return {
            "available": False,
            "queue_running": None,
            "queue_pending": None,
            "loaded_models": None,
        }
