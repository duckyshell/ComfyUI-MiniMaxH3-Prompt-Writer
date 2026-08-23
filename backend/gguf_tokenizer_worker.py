from __future__ import annotations

import json
import sys
from pathlib import Path

if __package__:
    from .text_normalization import normalize_unicode_text
else:
    # Windows embeddable Python can omit the executed script directory from
    # sys.path. This mutation is confined to this child worker and exposes only
    # the plugin package root; the main ComfyUI process is never modified.
    package_root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(package_root))
    from backend.text_normalization import normalize_unicode_text


def _write(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main() -> int:
    if len(sys.argv) != 2:
        _write({"ready": False, "error": "Expected one GGUF model path."})
        return 2
    model_path = Path(sys.argv[1]).resolve(strict=True)
    from llama_cpp import Llama

    model = Llama(
        model_path=str(model_path),
        vocab_only=True,
        n_gpu_layers=0,
        n_ctx=512,
        verbose=False,
    )
    _write({"ready": True, "vocab_only": True, "n_gpu_layers": 0})
    try:
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                if request.get("operation") == "shutdown":
                    return 0
                if request.get("operation") != "count" or not isinstance(request.get("text"), str):
                    raise ValueError("Invalid tokenizer request.")
                text = normalize_unicode_text(request["text"])
                count = len(model.tokenize(text.encode("utf-8"), add_bos=True))
                _write({"id": request.get("id"), "count": count})
            except Exception as error:
                _write({"id": request.get("id") if isinstance(request, dict) else None, "error": str(error)})
    finally:
        model.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
