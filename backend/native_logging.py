from __future__ import annotations

import sys
from contextlib import contextmanager, redirect_stderr
from typing import Any, Iterator


def _known_llama_noise(line: str) -> bool:
    return (
        "find_slot: non-consecutive token position" in line
        or (
            "llama_context: n_ctx_seq (" in line
            and "n_ctx_train (0) -- possible training context overflow" in line
        )
    )


class _FilteredStderr:
    def __init__(self, stream: Any) -> None:
        self.stream = stream

    def write(self, value: str) -> int:
        filtered = "".join(
            line for line in value.splitlines(keepends=True)
            if not _known_llama_noise(line)
        )
        if filtered:
            self.stream.write(filtered)
        return len(value)

    def flush(self) -> None:
        self.stream.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self.stream, name)


@contextmanager
def suppress_known_llama_noise() -> Iterator[None]:
    with redirect_stderr(_FilteredStderr(sys.stderr)):
        yield
