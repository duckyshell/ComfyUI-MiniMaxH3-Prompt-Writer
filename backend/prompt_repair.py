from __future__ import annotations

import re
from typing import Any

from .references import reference_tags


def dialogue_lines(text: str) -> list[str]:
    return [value.strip() for value in re.findall(r"(?is)<d>.*?</d>", text)]


def unexpected_audio_task(task_label: str | None, expected_tags: set[str]) -> bool:
    if any(tag.startswith("<Audio ") for tag in expected_tags):
        return False
    return bool(task_label and re.search(r"\baudio\s+(?:reuse|reference)\b", task_label, re.IGNORECASE))


def explicit_constraint_violations(creative_brief: str, prompt: str) -> list[str]:
    violations: list[str] = []
    if re.search(r"(?i)\b(?:no cuts?|without cuts?|single continuous shot|one continuous shot)\b", creative_brief):
        if re.search(r"(?i)\[Shot\s+[2-9]\d*\]|\bcut(?:s)?\s+to\b", prompt):
            violations.append("the user explicitly requested one continuous shot without cuts")
    if re.search(r"(?i)\b(?:static|locked(?:-off)?|fixed)\s+camera\b|\bno camera movement\b", creative_brief):
        if CAMERA_MOVEMENT.search(prompt):
            violations.append("the user explicitly requested a static camera")

    motion_only_videos: set[str] = set()
    for clause in re.split(r"[.\n;]+", creative_brief):
        if re.search(r"(?i)\b(?:only|solely)\b", clause) and re.search(
            r"(?i)\b(?:motion|movement|dance|choreograph\w*)\b", clause
        ):
            motion_only_videos.update(re.findall(r"(?i)\bVideo\s+([1-3])\b", clause))
    excluded_trait = (
        r"(?:environment|background|setting|location|lighting|performer|identity|clothing|wardrobe|"
        r"outfit|audio|soundtrack)"
    )
    for number in sorted(motion_only_videos, key=int):
        tag = rf"<\s*Video\s+{re.escape(number)}\s*>"
        provenance = re.compile(
            rf"(?i)\b{excluded_trait}\b[^.\n]{{0,90}}\b(?:from|of|in)\s*{tag}|"
            rf"{tag}[^.\n]{{0,90}}\b(?:provides?|defines?|supplies?|is used for)\s+(?:the\s+)?{excluded_trait}\b"
        )
        if provenance.search(prompt):
            violations.append(f"<Video {number}> is assigned only to motion but supplies an excluded source trait")
    return violations


CAMERA_MOVEMENT = re.compile(
    r"(?i)\b(?:zoom(?:s|ed|ing)?|pan(?:s|ned|ning)?|doll(?:y|ies|ied|ying)|tracking shot|"
    r"camera\s+(?:moves?|pulls?|pushes?|pans?|zooms?|tracks?|dollies?))\b"
)


def audit_failures(audit: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if audit.get("missing_sections"):
        failures.append("missing required sections")
    if audit.get("section_order_valid") is False:
        failures.append("incorrect section order")
    if audit.get("missing_task_label"):
        failures.append("missing summary task label")
    if audit.get("missing_shot_marker"):
        failures.append("missing [Shot 1] marker")
    if audit.get("invalid_timestamps"):
        failures.append("invalid target timestamps")
    if audit.get("internal_video_representation_terms"):
        failures.append("internal contact-sheet language")
    if audit.get("missing_dialogue_source"):
        failures.append("dialogue without a stable speaker ID")
    if audit.get("missing_reference_tags"):
        failures.append("generated draft is missing required reference tags: " + ", ".join(audit["missing_reference_tags"]))
    if audit.get("unexpected_reference_tags"):
        failures.append("unexpected reference tags: " + ", ".join(audit["unexpected_reference_tags"]))
    if audit.get("unexpected_audio_task"):
        failures.append("audio reference/reuse declared without a canonically requested uploaded audio reference")
    failures.extend(audit.get("format_violations") or [])
    failures.extend(audit.get("explicit_constraint_violations") or [])
    return failures


def narrow_repair_messages(
    assembled: dict[str, Any],
    draft: str,
    violations: list[str],
    expected_tags: set[str],
    duration_seconds: float | int | None,
    allowed_reference_tags: set[str] | None = None,
) -> list[dict[str, str]]:
    original_request = next(message["content"] for message in assembled["messages"] if message["role"] == "user")
    required_tags = ", ".join(sorted(expected_tags)) or "none"
    allowed_tags = ", ".join(sorted(allowed_reference_tags if allowed_reference_tags is not None else expected_tags)) or "none"
    return [
        {
            "role": "system",
            "content": (
                "This is a narrow correction pass, not a new prompt-generation pass. Correct only the exact violations "
                "listed below and preserve every other supported fact, reference role, action, dialogue line, shot, and "
                "creative choice unchanged. Return the complete corrected prompt with no commentary. The required "
                f"numbered media tags are: {required_tags}. The exact allowed numbered media tags are: {allowed_tags}. "
                "Do not add any other media tag. Requested music without a canonically assigned uploaded audio "
                "reference belongs only in non_diegetic_music and is not audio reference or reuse. Target "
                f"timestamps must use MM:SS.mmm and remain within {duration_seconds} seconds. Violations: "
                + "; ".join(violations)
            ),
        },
        {
            "role": "user",
            "content": f"ORIGINAL REQUEST:\n{original_request}\n\nDRAFT TO CORRECT:\n{draft}",
        },
    ]


def continuum_chunk_repair_messages(
    assembled: dict[str, Any],
    draft: str,
    violations: list[str],
    expected_tags: set[str],
    allowed_tags: set[str],
) -> list[dict[str, str]]:
    original_request = next(
        message["content"]
        for message in assembled["messages"]
        if message["role"] == "user"
    )
    required = ", ".join(sorted(expected_tags)) or "none"
    allowed = ", ".join(sorted(allowed_tags)) or "none"
    return [
        {
            "role": "system",
            "content": (
                "This is a narrow correction of one MiniMax H3 Continuum Timeline chunk body. "
                "Correct only the objective failures listed below and preserve every other supported action, state, "
                "camera choice, dialogue line, sound cue, and creative choice unchanged. Return only the corrected "
                "chunk body. Do not add a shared preamble, Timeline header, standalone I2VA/FL2VA/L2VA alignment line, "
                "Reference-mode section wrapper, JSON, Markdown, or commentary. The exact public reference tags that "
                f"must remain in this chunk body are: {required}. The exact public reference tags permitted in this "
                f"chunk are: {allowed}. Do not add any other numbered media tag. Violations: "
                + "; ".join(violations)
            ),
        },
        {
            "role": "user",
            "content": (
                f"ORIGINAL CONTINUUM CHUNK REQUEST:\n{original_request}\n\n"
                f"DRAFT CHUNK BODY TO CORRECT:\n{draft}"
            ),
        },
    ]


def multimodal_repair_messages(
    original_messages: list[dict[str, Any]],
    draft: str,
    violations: list[str],
    expected_tags: set[str],
    duration_seconds: float | int | None,
    allowed_reference_tags: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Continue the original multimodal conversation for one constrained repair pass."""
    required_tags = ", ".join(sorted(expected_tags)) or "none"
    allowed_tags = ", ".join(sorted(allowed_reference_tags if allowed_reference_tags is not None else expected_tags)) or "none"
    correction = (
        "CORRECTION PASS: The draft above failed only the objective checks listed below. "
        "Re-read the same uploaded reference media and original request, then return the complete corrected prompt "
        "with no commentary. Every required uploaded reference must be accounted for with its exact numbered media "
        "tag, but it does not need to become a primary scene element. Preserve every supported fact, reference role, "
        "action, dialogue line, shot, and creative choice that does not conflict with the listed checks. The exact "
        f"required numbered media tags are: {required_tags}. The exact allowed numbered media tags are: {allowed_tags}. "
        "Do not add any other media tag. Requested music without a canonically assigned uploaded audio reference "
        "belongs only in non_diegetic_music and is not audio reference or reuse. Target "
        f"timestamps must use MM:SS.mmm and remain within {duration_seconds} seconds. Objective failures: "
        + "; ".join(violations)
    )
    return [
        *original_messages,
        {"role": "assistant", "content": draft},
        {"role": "user", "content": correction},
    ]
