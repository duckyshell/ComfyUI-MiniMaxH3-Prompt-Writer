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


def final_message_text(
    message: dict[str, Any],
    *,
    thinking: bool,
    qwen_reasoning_contract: bool,
) -> tuple[str, str | None]:
    response = str(message.get("content") or "")
    separate_reasoning = message.get("reasoning_content")
    if isinstance(separate_reasoning, str):
        return final_text(response), separate_reasoning.strip()
    if thinking and qwen_reasoning_contract:
        closing_tag = "</think>"
        if closing_tag not in response:
            raise ModelError(
                "THINKING_TRUNCATED",
                "Thinking ended without a final Qwen prompt. Try again, choose more Context, or turn Thinking off.",
            )
        reasoning, response = response.split(closing_tag, 1)
        reasoning = reasoning.removeprefix("<think>").strip()
        return final_text(response), reasoning
    return final_text(response), None
