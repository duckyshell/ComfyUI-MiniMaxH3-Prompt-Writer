from __future__ import annotations

import re
from typing import Any


REFERENCE_SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)


TIMESTAMP_CANDIDATE = re.compile(r"(?<!\d)\d{2}:\d{2,3}(?:\.\d{1,3})?(?!\d)")
VALID_TIMESTAMP = re.compile(r"^(\d{2}):(\d{2})\.(\d{3})$")
CAMERA_DIRECTION = re.compile(
    r"(?i)\b(?:cut(?:s)?\s+to|zoom(?:s|ed|ing)?(?:-in|-out|\s+in|\s+out)?|"
    r"pan(?:s|ned|ning)?(?:\s+(?:up|down|left|right|across))?|doll(?:y|ies|ied|ying)|"
    r"tracking shot|camera\s+(?:moves?|pulls?|pushes?|pans?|zooms?|tracks?|dollies?))\b"
)
INTERNAL_VIDEO_REPRESENTATION = re.compile(
    r"(?i)\b(?:contact sheet|sheet cell(?:s)?|sampled frame(?:s)?|sample frame(?:s)?|"
    r"\d+(?:\.\d+)?s\s+mark)\b"
)


def invalid_timestamps(prompt: str, duration_seconds: float | None = None) -> list[str]:
    invalid: list[str] = []
    for value in TIMESTAMP_CANDIDATE.findall(prompt):
        match = VALID_TIMESTAMP.fullmatch(value)
        if not match:
            invalid.append(value)
            continue
        minutes, seconds, milliseconds = (int(part) for part in match.groups())
        total = minutes * 60 + seconds + milliseconds / 1000
        if seconds >= 60 or (duration_seconds is not None and total > duration_seconds + 0.001):
            invalid.append(value)
    return list(dict.fromkeys(invalid))


def camera_structure_requested(intent_text: str) -> bool:
    return bool(re.search(
        r"(?i)\b(?:camera|framing|shot|cut|zoom|pan|dolly|tracking|handheld|pov|"
        r"temporal structure|whole video|entire video)\b",
        intent_text,
    ))


def unsupported_camera_directions(prompt: str, allowed: bool) -> list[str]:
    if allowed:
        return []
    return list(dict.fromkeys(match.group(0) for match in CAMERA_DIRECTION.finditer(prompt)))


def internal_video_representation_terms(prompt: str) -> list[str]:
    return list(dict.fromkeys(match.group(0) for match in INTERNAL_VIDEO_REPRESENTATION.finditer(prompt)))


def audit_prompt(
    prompt: str,
    mode: str = "Reference",
    duration_seconds: float | None = None,
    camera_structure_allowed: bool = True,
) -> dict[str, Any]:
    if mode != "Reference":
        return {
            "mode": mode,
            "official_format_pass": None,
            "reference_understanding": "not_applicable",
        }
    positions: dict[str, re.Match[str]] = {}
    for section in REFERENCE_SECTIONS:
        match = re.search(rf"(?im)^\s*{re.escape(section)}\s*:\s*", prompt)
        if match:
            positions[section] = match

    missing = [section for section in REFERENCE_SECTIONS if section not in positions]
    ordered = sorted(positions.items(), key=lambda item: item[1].start())
    section_order = [name for name, _ in ordered]
    order_valid = section_order == [section for section in REFERENCE_SECTIONS if section in positions]

    detailed = ""
    detailed_match = positions.get("detailed_description")
    if detailed_match:
        following = [match.start() for _, match in ordered if match.start() > detailed_match.start()]
        end = min(following) if following else len(prompt)
        detailed = prompt[detailed_match.end():end]
    detailed_for_count = re.sub(r"\[Shot\s+\d+\]", "", detailed, flags=re.IGNORECASE)
    detailed_words = len(re.findall(r"[A-Za-z]+(?:[-'][A-Za-z]+)*", detailed_for_count))
    has_shot_marker = bool(re.search(r"(?im)^\s*\[Shot\s+1\]", detailed))

    summary_match = positions.get("summary")
    task_label = None
    if summary_match:
        label_match = re.match(r"\s*\[([^\]]+)\]", prompt[summary_match.end():], re.IGNORECASE)
        if label_match:
            task_label = label_match.group(1).strip()
    missing_task_label = summary_match is not None and task_label is None
    missing_shot_marker = detailed_match is not None and not has_shot_marker
    generation_word_target = bool(task_label and "generation" in task_label.lower())
    word_target_met = 350 <= detailed_words <= 500 if generation_word_target else None
    if not generation_word_target:
        length_status = "not_applicable"
    elif detailed_words < 250:
        length_status = "severely_short_internal_warning"
    elif detailed_words < 300:
        length_status = "short_internal_warning"
    elif detailed_words < 350:
        length_status = "acceptable_below_target"
    elif detailed_words <= 500:
        length_status = "official_target"
    else:
        length_status = "above_target"
    structure_pass = not missing and order_valid
    invalid_timestamp_values = invalid_timestamps(prompt, duration_seconds)
    unsupported_camera_values = unsupported_camera_directions(prompt, camera_structure_allowed)
    internal_video_terms = internal_video_representation_terms(prompt)
    has_dialogue = bool(re.search(r"(?is)<d>.*?</d>", prompt))
    dialogue_source_valid = bool(
        re.search(r"\(S\d+(?:\s*,\s*S\d+)*\)", prompt)
        or re.search(r"<Audio\s+\d+>", prompt, re.IGNORECASE)
    )
    missing_dialogue_source = has_dialogue and not dialogue_source_valid
    quality_warnings = []
    if length_status == "severely_short_internal_warning":
        quality_warnings.append("severely short detailed_description")
    elif length_status == "short_internal_warning":
        quality_warnings.append("short detailed_description")
    repair_required = (
        not structure_pass
        or bool(invalid_timestamp_values)
        or bool(internal_video_terms)
        or missing_dialogue_source
        or missing_task_label
        or missing_shot_marker
    )

    return {
        "mode": mode,
        "required_sections": list(REFERENCE_SECTIONS),
        "missing_sections": missing,
        "section_order_valid": order_valid,
        "task_label": task_label,
        "missing_task_label": missing_task_label,
        "missing_shot_marker": missing_shot_marker,
        "detailed_description_words": detailed_words,
        "generation_word_target_applies": generation_word_target,
        "generation_word_target_met": word_target_met,
        "detailed_description_length_status": length_status,
        "structure_pass": structure_pass,
        "invalid_timestamps": invalid_timestamp_values,
        "unsupported_camera_directions": unsupported_camera_values,
        "quality_warnings": quality_warnings,
        "internal_video_representation_terms": internal_video_terms,
        "missing_dialogue_source": missing_dialogue_source,
        "repair_required": repair_required,
        "official_format_pass": (
            structure_pass
            and not invalid_timestamp_values
            and not internal_video_terms
            and not missing_dialogue_source
            and not missing_task_label
            and not missing_shot_marker
        ),
        "quality_target_pass": not quality_warnings,
        "reference_understanding": "manual_review_required",
    }
