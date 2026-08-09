from __future__ import annotations

import re
from typing import Any


def reference_tags(text: str) -> set[str]:
    return {
        f"<{kind.title()} {number}>"
        for kind, number in re.findall(r"<\s*(Picture|Video|Audio)\s+(\d+)\s*>", text, re.IGNORECASE)
    }


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
        failures.append("missing reference tags: " + ", ".join(audit["missing_reference_tags"]))
    if audit.get("unexpected_reference_tags"):
        failures.append("unexpected reference tags: " + ", ".join(audit["unexpected_reference_tags"]))
    if audit.get("unexpected_audio_task"):
        failures.append("audio reference/reuse declared without an uploaded audio asset")
    failures.extend(audit.get("explicit_constraint_violations") or [])
    return failures


def narrow_repair_messages(
    assembled: dict[str, Any],
    draft: str,
    violations: list[str],
    expected_tags: set[str],
    duration_seconds: float | int | None,
) -> list[dict[str, str]]:
    original_request = next(message["content"] for message in assembled["messages"] if message["role"] == "user")
    allowed_tags = ", ".join(sorted(expected_tags)) or "none"
    return [
        {
            "role": "system",
            "content": (
                "This is a narrow correction pass, not a new prompt-generation pass. Correct only the exact violations "
                "listed below and preserve every other supported fact, reference role, action, dialogue line, shot, and "
                "creative choice unchanged. Return the complete corrected prompt with no commentary. The exact allowed "
                f"numbered media tags are: {allowed_tags}. Do not add any other media tag. Requested music without an "
                "uploaded audio asset belongs only in non_diegetic_music and is not audio reference or reuse. Target "
                f"timestamps must use MM:SS.mmm and remain within {duration_seconds} seconds. Violations: "
                + "; ".join(violations)
            ),
        },
        {
            "role": "user",
            "content": f"ORIGINAL REQUEST:\n{original_request}\n\nDRAFT TO CORRECT:\n{draft}",
        },
    ]
