from __future__ import annotations

from typing import Any


class ModelError(Exception):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def final_text(response: str) -> str:
    marker = "<channel|>"
    if "<|channel>thought" in response and marker not in response:
        raise ModelError(
            "THINKING_TRUNCATED",
            "Thinking reached its token limit before producing the final prompt. Try again or turn Thinking off.",
        )
    if marker in response:
        response = response.rsplit(marker, 1)[-1]
    return response.replace("<|end_of_turn|>", "").replace("<eos>", "").strip()
