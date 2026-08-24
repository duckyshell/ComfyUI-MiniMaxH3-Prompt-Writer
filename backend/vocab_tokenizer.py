from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable

from .native_logging import suppress_known_llama_noise
from .text_normalization import normalize_unicode_text


class TokenizerPreflightError(RuntimeError):
    pass


def model_identity(model_path: str | Path) -> tuple[str, int, int]:
    resolved = Path(model_path).resolve(strict=True)
    stat = resolved.stat()
    return str(resolved), stat.st_size, stat.st_mtime_ns


class VocabOnlyTokenizerClient:
    def __init__(
        self,
        model_path: str | Path,
        *,
        model_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.identity = model_identity(model_path)
        self._lock = threading.Lock()
        self.model = None
        try:
            if model_factory is None:
                from llama_cpp import Llama

                model_factory = Llama
            with suppress_known_llama_noise():
                self.model = model_factory(
                    model_path=self.identity[0],
                    vocab_only=True,
                    n_gpu_layers=0,
                    n_ctx=512,
                    verbose=False,
                )
        except Exception as error:
            self.close()
            raise TokenizerPreflightError(f"The vocab-only tokenizer did not start: {error}") from error
        self.startup = {"ready": True, "vocab_only": True, "n_gpu_layers": 0}

    def count(self, text: str) -> int:
        text = normalize_unicode_text(text)
        with self._lock:
            if self.model is None:
                raise TokenizerPreflightError("The vocab-only tokenizer is closed.")
            try:
                return len(self.model.tokenize(text.encode("utf-8"), add_bos=True))
            except Exception as error:
                raise TokenizerPreflightError(f"The vocab-only tokenizer could not count the request: {error}") from error

    def close(self) -> None:
        model = getattr(self, "model", None)
        if model is None:
            return
        self.model = None
        model.close()
