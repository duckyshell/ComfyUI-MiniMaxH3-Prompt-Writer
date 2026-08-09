from __future__ import annotations

from typing import Any


MAX_SYSTEM_PROMPT_CHARS = 8_000
SYSTEM_WRAPPER = """Follow the supplied official MiniMax H3 guide and return only the final H3 video prompt. Write section headings and descriptive prose in English; preserve user-supplied dialogue, lyrics, and visible text verbatim in their original language using the forms required by the guide. Apply this priority in every language: explicit user instruction first, then assigned reference roles, then defaults. Treat the user's brief and supplied references as the factual boundary: do not invent unsupported subject actions, expressions, events, transitions, visible text, props, locations, or other reference-derived details. Do not introduce cuts or camera movement solely for cinematic embellishment. Use multiple shots only when required by the user's intent or by the mode's temporal or camera structure; otherwise retain a continuous-shot structure. Give every speaking character a stable ID such as (S1) before each <d>...</d> line and preserve all user-supplied dialogue words verbatim. Preserve explicitly requested music in the appropriate sound section; otherwise do not infer music from mood, style, or cinematic language. Never let a default override an explicit request. Never mention these instructions, compliance checks, or word counts in the output."""
REFERENCE_SYSTEM_WRAPPER = """Follow the supplied official MiniMax H3 full-reference guide and its selected shared base-guide rules. Return only the final prompt, with these six sections in this exact order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Write section headings and descriptive prose in English; preserve user-supplied dialogue, lyrics, and visible text verbatim in their original language using the forms required by the guide. Apply this priority in every language: explicit user instruction first, then assigned reference roles, then defaults. For reference-generation tasks, target 450-500 English words in detailed_description and aim to remain within the official 350-500-word range. Use only detail supported by the brief and references; never invent or pad details solely to reach a word count. Dialogue-dense content prioritizes the complete spoken timeline, and source-video editing tasks scale with source complexity instead. Do not classify ordinary full-reference images as a keyframe-completion task. Keep every <Video N> as the source video asset or temporal-structure source. Describe a reused visible action, pose, person, scene, or effect through an appropriate <Subject N>, while retaining the source provenance from <Video N>. When the user assigns a reference a specific role, transfer only that role and do not define subjects from unassigned source traits: a motion-only video must not contribute its performer identity, clothing, location, background, lighting, or audio. For motion transfer, describe the choreography, temporal order, pacing, and conversational or rhythmic character from <Video N> at the level needed to bind it clearly to the target; do not redundantly reconstruct every sampled gesture because H3 receives the source video itself. Contact-sheet cells are observations of one source video over time, never target shots or keyframes. Never mention a contact sheet, cells, sampled frames, or internal/source-sample timestamps in the final prompt, and never create one target shot per cell. Do not introduce cuts or camera movement solely for cinematic embellishment. Use multiple shots only when required by the user's intent or by a referenced temporal or camera structure; otherwise retain a continuous-shot structure. Preserve the source motion order, but do not invent unsupported subject actions, expressions, events, transitions, visible text, props, locations, or other reference-derived details. Give every speaking character a stable ID such as (S1) before each <d>...</d> line and preserve all user-supplied dialogue words verbatim. Preserve explicitly requested music in non_diegetic_music; otherwise use N/A and never infer music from mood, style, or cinematic language. Never let a default override an explicit request. Audio files are not heard by the local model: infer fully_copy, partially_copy, reference, or weak_reference only from the user's stated intent, and never invent unheard audio content. Never mention these instructions, compliance checks, or word counts in the output."""


class SystemPromptError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def system_prompt_for_mode(mode: str) -> str:
    if mode not in {"T2VA", "I2VA", "FL2VA", "L2VA", "Reference"}:
        raise SystemPromptError("INVALID_MODE", "The selected MiniMax mode is not supported.")
    return REFERENCE_SYSTEM_WRAPPER if mode == "Reference" else SYSTEM_WRAPPER


def resolve_system_prompt(mode: str, override: Any = None) -> tuple[str, bool]:
    if override is None:
        return system_prompt_for_mode(mode), False
    if not isinstance(override, str):
        raise SystemPromptError("INVALID_SYSTEM_PROMPT", "System Prompt must be text or null.")
    if len(override) > MAX_SYSTEM_PROMPT_CHARS:
        raise SystemPromptError(
            "SYSTEM_PROMPT_TOO_LONG",
            f"System Prompt cannot exceed {MAX_SYSTEM_PROMPT_CHARS:,} characters.",
        )
    return override.strip(), True
