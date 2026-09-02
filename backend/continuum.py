from __future__ import annotations

from decimal import Decimal, InvalidOperation
import copy
import hashlib
import json
import re
from typing import Any

from .assembly import assemble_refinement, assemble_request
from .references import (
    effective_reference_tags,
    missing_reference_declarations,
    normalize_downstream_reference_inventory,
    reference_tags,
)


GENERATION_TARGET_SINGLE = "single"
GENERATION_TARGET_CONTINUUM = "continuum"
CONTINUUM_SCHEMA_VERSION = 2
LEGACY_CONTINUUM_SCHEMA_VERSION = 1
MIN_CHUNKS = 1
MAX_CHUNKS = 16
MIN_CHUNK_SECONDS = 4.0
MAX_CHUNK_SECONDS = 30.0

_LEGACY_CHUNK_HEADER = re.compile(r"^\s*\[\s*Chunk\s+(\d+)\s*\]\s*$", re.IGNORECASE)
_TIMELINE_HEADER = re.compile(
    r"^\s*\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*s?\s*\]\s*$",
    re.IGNORECASE,
)
_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.IGNORECASE | re.DOTALL)
_SUBJECT_TAG = re.compile(r"<\s*Subject\s+(\d+)\s*>", re.IGNORECASE)
_SUBJECT_ALPHA_ALIAS_TAG = re.compile(r"<\s*Subject\s+([A-Z])\s*>", re.IGNORECASE)
_CONTINUUM_STANDALONE_FIELD = re.compile(
    r"^\s*(integrated_multimodal_description|subject_definitions|summary|retention_analysis|"
    r"detailed_description|overall_soundscape|non_diegetic_music)\s*:",
    re.IGNORECASE | re.MULTILINE,
)
_CONTINUUM_SHOT_HEADER = re.compile(
    r"(?:^|:\s*)\[\s*Shot\s+\d+\s*\]",
    re.IGNORECASE | re.MULTILINE,
)
_CONTINUUM_ALIGNMENT_BOILERPLATE = re.compile(
    r"^\s*(?:How\s+the\s+reference\s+picture(?:s)?\s+align\s+with\s+the\s+target\s+video\s*:|"
    r"For\s+the\s+target\s+video\s*,\s*at\s+0(?:\.0+)?\s+seconds\b)",
    re.IGNORECASE | re.MULTILINE,
)
_CONTINUUM_MARKDOWN_FENCE = re.compile(r"^\s*\x60\x60\x60", re.MULTILINE)


def subject_tags(text: str) -> set[str]:
    return {
        f"<Subject {int(number)}>"
        for number in _SUBJECT_TAG.findall(str(text))
        if int(number) > 0
    }


def _subject_alpha_alias_number(value: str) -> int:
    return ord(value.upper()) - ord("A") + 1


def _normalize_plan_subject_aliases(value: str) -> str:
    return _SUBJECT_ALPHA_ALIAS_TAG.sub(
        lambda match: f"<Subject {_subject_alpha_alias_number(match.group(1))}>",
        str(value),
    )


def continuum_chunk_format_violations(
    prompt: str,
    *,
    preamble: str = "",
) -> list[str]:
    value = str(prompt or "").strip()
    violations: list[str] = []
    shared = str(preamble or "").strip()
    if shared and (value == shared or value.startswith(shared + "\n") or value.startswith(shared + "\r")):
        violations.append("repeated shared sequence preamble")
    if _contains_reserved_sequence_header(value):
        violations.append("reserved Continuum Timeline or legacy chunk header")
    standalone_fields = sorted({
        match.group(1).lower()
        for match in _CONTINUUM_STANDALONE_FIELD.finditer(value)
    })
    if standalone_fields:
        violations.append(
            "standalone H3 field labels: " + ", ".join(standalone_fields)
        )
    if _CONTINUUM_SHOT_HEADER.search(value):
        violations.append("standalone [Shot N] wrapper")
    if _CONTINUUM_ALIGNMENT_BOILERPLATE.search(value):
        violations.append("standalone keyframe-alignment boilerplate")
    if _CONTINUUM_MARKDOWN_FENCE.search(value):
        violations.append("Markdown code fence")
    return violations


class ContinuumError(ValueError):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def generation_target(body: dict[str, Any]) -> str:
    value = body.get("generation_target", GENERATION_TARGET_SINGLE)
    if value not in {GENERATION_TARGET_SINGLE, GENERATION_TARGET_CONTINUUM}:
        raise ContinuumError(
            "INVALID_GENERATION_TARGET",
            "Generation target must be Single clip or H3 Continuum.",
            {"generation_target": value},
        )
    return value


def validate_continuum_settings(source: dict[str, Any]) -> dict[str, Any]:
    value = source.get("continuum") if "continuum" in source else source
    if not isinstance(value, dict):
        raise ContinuumError("INVALID_CONTINUUM_SETTINGS", "H3 Continuum settings must be a JSON object.")
    schema_version = value.get("schema_version", CONTINUUM_SCHEMA_VERSION)
    if schema_version not in {LEGACY_CONTINUUM_SCHEMA_VERSION, CONTINUUM_SCHEMA_VERSION}:
        raise ContinuumError(
            "UNSUPPORTED_CONTINUUM_SCHEMA",
            f"Unsupported H3 Continuum schema {schema_version}; expected {CONTINUUM_SCHEMA_VERSION}.",
        )
    chunks = value.get("chunks")
    if not isinstance(chunks, int) or isinstance(chunks, bool) or not MIN_CHUNKS <= chunks <= MAX_CHUNKS:
        raise ContinuumError(
            "INVALID_CONTINUUM_CHUNKS",
            f"H3 Continuum chunks must be an integer between {MIN_CHUNKS} and {MAX_CHUNKS}.",
            {"chunks": chunks},
        )
    chunk_seconds = value.get("chunk_seconds")
    if (
        not isinstance(chunk_seconds, (int, float))
        or isinstance(chunk_seconds, bool)
        or not MIN_CHUNK_SECONDS <= float(chunk_seconds) <= MAX_CHUNK_SECONDS
    ):
        raise ContinuumError(
            "INVALID_CONTINUUM_DURATION",
            f"H3 Continuum chunk duration must be between {MIN_CHUNK_SECONDS:g} and {MAX_CHUNK_SECONDS:g} seconds.",
            {"chunk_seconds": chunk_seconds},
        )
    return {
        "schema_version": CONTINUUM_SCHEMA_VERSION,
        "chunks": chunks,
        "chunk_seconds": float(chunk_seconds),
        "total_seconds": float(Decimal(str(chunk_seconds)) * chunks),
    }


def _normalize_inventory_from_input(request_input: dict[str, Any]) -> dict[str, Any] | None:
    if "downstream_reference_inventory" not in request_input:
        return None
    try:
        return normalize_downstream_reference_inventory(request_input.get("downstream_reference_inventory"))
    except ValueError as error:
        raise ContinuumError("INVALID_DOWNSTREAM_REFERENCE_INVENTORY", str(error)) from error


def normalized_downstream_inventory(value: Any) -> dict[str, Any]:
    try:
        return normalize_downstream_reference_inventory(value)
    except ValueError as error:
        raise ContinuumError("INVALID_DOWNSTREAM_REFERENCE_INVENTORY", str(error)) from error


def downstream_inventory_identity(value: Any) -> dict[str, Any]:
    normalized = normalized_downstream_inventory(value)
    fields = (
        "role",
        "kind",
        "source",
        "tag",
        "input_name",
        "source_node_id",
        "source_node_class",
        "source_output_name",
        "source_identity",
        "model_asset_id",
    )
    items = []
    for item in normalized["items"]:
        identity = {
            field: (None if item.get(field) is None else str(item.get(field)))
            for field in fields
        }
        identity["visible_to_model"] = bool(item.get("visible_to_model"))
        identity["source_slot"] = item.get("source_slot")
        items.append(identity)
    return {
        "schema_version": normalized["schema_version"],
        "items": items,
    }


def _saved_downstream_inventory_matches(
    saved_inventory: dict[str, Any],
    active_inventory: dict[str, Any],
) -> bool:
    saved_identity = downstream_inventory_identity(saved_inventory)
    active_identity = downstream_inventory_identity(active_inventory)
    if saved_identity["schema_version"] != active_identity["schema_version"]:
        return False
    if len(saved_identity["items"]) != len(active_identity["items"]):
        return False

    for saved_item, active_item in zip(saved_identity["items"], active_identity["items"]):
        saved_item = dict(saved_item)
        active_item = dict(active_item)
        saved_source_identity = saved_item.pop("source_identity", None)
        active_source_identity = active_item.pop("source_identity", None)
        saved_model_asset_id = saved_item.pop("model_asset_id", None)
        active_model_asset_id = active_item.pop("model_asset_id", None)
        if saved_item != active_item:
            return False
        # Snapshots created before source_identity existed are accepted once as
        # an unknown legacy identity. A saved fingerprint, however, is strict:
        # the active source must expose the same fingerprint.
        if saved_source_identity is not None and saved_source_identity != active_source_identity:
            return False
        # model_asset_id names a temporary Prompt Writer session asset rather
        # than the downstream source. Permit a new ID only when an existing
        # stable source fingerprint proves that both copies came from the same
        # workflow image. Legacy/unfingerprinted visible bindings remain strict.
        if (
            saved_model_asset_id != active_model_asset_id
            and (
                saved_source_identity is None
                or saved_source_identity != active_source_identity
            )
        ):
            return False
    return True


def validate_saved_downstream_inventory(
    saved_inventory: Any,
    active_inventory: Any,
) -> dict[str, Any]:
    active = normalized_downstream_inventory(active_inventory)
    if saved_inventory is None:
        return active
    saved = normalized_downstream_inventory(saved_inventory)
    if not _saved_downstream_inventory_matches(saved, active):
        raise ContinuumError(
            "CONTINUUM_REFERENCE_SOURCE_DRIFT",
            (
                "The selected H3 Continuum sampler conditioning inventory changed since this Continuum sequence was generated. "
                "Regenerate the sequence so its reference and keyframe semantics are planned against the active workflow."
            ),
            {
                "saved_inventory": saved,
                "active_inventory": active,
            },
        )
    # Return the active normalized snapshot so a successful refinement upgrades
    # legacy pre-fingerprint inventories and future shelf replacements become strict.
    return active


def _stable_reference_inventory(request_input: dict[str, Any]) -> list[dict[str, Any]]:
    downstream = _normalize_inventory_from_input(request_input)
    if downstream is not None:
        return [
            {
                **({"tag": str(item["tag"])} if item.get("tag") else {}),
                "kind": str(item["kind"]),
                "source": str(item["source"]),
                "visible_to_model": bool(item["visible_to_model"]),
                "role": str(item["role"]),
                **({"input_name": str(item["input_name"])} if item.get("input_name") else {}),
            }
            for item in downstream["items"]
        ]
    return [
        {
            "tag": str(asset["reference"]),
            "kind": str(asset["type"]),
            "source": "prompt_writer_media",
            "visible_to_model": asset.get("type") != "audio",
            "role": "model_visible_media",
        }
        for asset in request_input.get("media_manifest", {}).get("assets", [])
        if asset.get("reference")
    ]


def continuum_temporal_topology(request_input: dict[str, Any]) -> dict[str, Any]:
    inventory = _normalize_inventory_from_input(request_input)
    items = inventory["items"] if inventory is not None else []
    return {
        "first_frame": any(item["role"] == "first_frame" for item in items),
        "last_frame": any(item["role"] == "last_frame" for item in items),
        "reference_images": sum(1 for item in items if item["role"] == "reference_image"),
    }


def validate_continuum_mode_topology(mode: str, request_input: dict[str, Any]) -> None:
    topology = continuum_temporal_topology(request_input)
    if mode == "Reference":
        return
    expected = {
        "T2VA": (False, False),
        "I2VA": (True, False),
        "FL2VA": (True, True),
        "L2VA": (False, True),
    }
    if mode not in expected:
        raise ContinuumError(
            "INVALID_MODE",
            "The selected MiniMax H3 mode is not supported by H3 Continuum.",
            {"mode": mode},
        )
    actual = (topology["first_frame"], topology["last_frame"])
    required = expected[mode]
    reference_mode_mismatch = mode == "T2VA" and int(topology["reference_images"]) > 0
    if actual != required or reference_mode_mismatch:
        labels = {
            (False, False): "no First/Last keyframes",
            (True, False): "First Frame only",
            (True, True): "First Frame and Last Frame",
            (False, True): "Last Frame only",
        }
        if reference_mode_mismatch:
            message = (
                "T2VA does not match the selected H3 Continuum sampler conditioning. T2VA requires no First/Last "
                f"keyframes and no Reference Images, but the sampler has {int(topology['reference_images'])} active "
                "Reference Image input(s). Use Reference mode, or remove the Reference Images."
            )
        else:
            message = (
                f"{mode} does not match the selected H3 Continuum sampler's temporal keyframe wiring. "
                f"{mode} requires {labels[required]}, but the sampler currently has {labels[actual]}."
            )
        raise ContinuumError(
            "CONTINUUM_MODE_TOPOLOGY_MISMATCH",
            message,
            {
                "mode": mode,
                "required": {
                    "first_frame": required[0],
                    "last_frame": required[1],
                    **({"reference_images": 0} if mode == "T2VA" else {}),
                },
                "actual": topology,
            },
        )


def stable_reference_tags(request_input: dict[str, Any]) -> set[str]:
    return {
        str(item["tag"])
        for item in _stable_reference_inventory(request_input)
        if item.get("tag")
    }


def persistent_reference_tags(request_input: dict[str, Any], *, chunks: int) -> set[str]:
    inventory = _normalize_inventory_from_input(request_input)
    if inventory is None:
        return stable_reference_tags(request_input)
    tagged = [item for item in inventory["items"] if item.get("tag")]
    if int(chunks) == 1:
        return {str(item["tag"]) for item in tagged}
    return {
        str(item["tag"])
        for item in tagged
        if item["role"] in {"reference_image", "video_reference", "reference_audio"}
    }


def chunk_reference_tags(
    request_input: dict[str, Any],
    *,
    chunk_index: int,
    chunks: int,
) -> set[str]:
    if not 1 <= int(chunk_index) <= int(chunks):
        raise ContinuumError(
            "INVALID_CONTINUUM_CHUNK",
            "Chunk reference scope requires a valid one-based chunk index.",
            {"chunk_index": chunk_index, "chunks": chunks},
        )
    inventory = _normalize_inventory_from_input(request_input)
    if inventory is None:
        return stable_reference_tags(request_input)
    allowed: set[str] = set()
    for item in inventory["items"]:
        tag = item.get("tag")
        if not tag:
            continue
        role = item["role"]
        if role in {"reference_image", "video_reference", "reference_audio"}:
            allowed.add(str(tag))
        elif role == "first_frame" and int(chunk_index) == 1:
            allowed.add(str(tag))
        elif role == "last_frame" and int(chunk_index) == int(chunks):
            allowed.add(str(tag))
    return allowed


def sequence_reference_scopes(
    request_input: dict[str, Any],
    *,
    chunks: int,
) -> list[set[str]]:
    return [
        chunk_reference_tags(
            request_input,
            chunk_index=index,
            chunks=chunks,
        )
        for index in range(1, int(chunks) + 1)
    ]


def validate_sequence_reference_scope(
    request_input: dict[str, Any],
    *,
    preamble: str,
    prompts: list[str],
    chunks: int,
) -> None:
    if len(prompts) != int(chunks):
        raise ContinuumError(
            "INVALID_CONTINUUM_SEQUENCE",
            "Continuum reference-scope validation requires exactly one prompt body per configured chunk.",
            {"expected": int(chunks), "actual": len(prompts)},
        )

    expected = stable_reference_tags(request_input)
    persistent = persistent_reference_tags(request_input, chunks=chunks)
    scopes = sequence_reference_scopes(request_input, chunks=chunks)

    preamble_references = reference_tags(str(preamble or ""))
    undeclared_global = preamble_references - expected
    if undeclared_global:
        raise ContinuumError(
            "CONTINUUM_REFERENCE_IDENTITY_DRIFT",
            "The edited Continuum preamble contains public reference labels outside the selected downstream inventory.",
            {
                "scope": "global",
                "unexpected": sorted(undeclared_global),
                "allowed": sorted(expected),
            },
        )
    scoped_global = preamble_references - persistent
    if scoped_global:
        raise ContinuumError(
            "CONTINUUM_REFERENCE_SCOPE_DRIFT",
            "The edited Continuum preamble uses a public reference that is not persistent across every chunk.",
            {
                "scope": "global",
                "unexpected": sorted(scoped_global),
                "persistent": sorted(persistent),
            },
        )

    for index, prompt in enumerate(prompts, start=1):
        prompt_references = reference_tags(str(prompt or ""))
        undeclared = prompt_references - expected
        if undeclared:
            raise ContinuumError(
                "CONTINUUM_REFERENCE_IDENTITY_DRIFT",
                f"Edited Continuum Chunk {index} contains public reference labels outside the selected downstream inventory.",
                {
                    "scope": "chunk",
                    "chunk_index": index,
                    "unexpected": sorted(undeclared),
                    "allowed": sorted(expected),
                },
            )
        allowed = scopes[index - 1]
        scoped = prompt_references - allowed
        if scoped:
            raise ContinuumError(
                "CONTINUUM_REFERENCE_SCOPE_DRIFT",
                f"Edited Continuum Chunk {index} uses a public reference outside that chunk's downstream conditioning scope.",
                {
                    "scope": "chunk",
                    "chunk_index": index,
                    "unexpected": sorted(scoped),
                    "allowed": sorted(allowed),
                },
            )


def _planner_schema(settings: dict[str, Any]) -> str:
    chunk_template = [
        {
            "continuity": "initial" if index == 1 else "continuous",
            "transition": "",
            "start_state": "compact state at the start of this chunk",
            "action": "events that happen during this chunk",
            "end_state": "compact state reached at the end of this chunk",
        }
        for index in range(1, settings["chunks"] + 1)
    ]
    return json.dumps(
        {
            "schema_version": CONTINUUM_SCHEMA_VERSION,
            "global": {
                "sequence_preamble": (
                    "Polished MiniMax H3 prompt prose containing only sequence-wide identity, persistent reference roles, "
                    "wardrobe/prop/environment/style continuity, genuinely global camera/lighting/audio rules, exclusions, "
                    "and other constraints intended to apply to every chunk."
                ),
                "continuity_anchors": "compact internal continuity facts used while planning",
                "persistent_constraints": "compact internal constraints that apply across the sequence",
                "subject_anchors": [
                    {
                        "id": "<Subject 1>",
                        "meaning": "stable identity and role of this subject across chunks",
                    }
                ],
            },
            "chunks": chunk_template,
        },
        ensure_ascii=False,
        indent=2,
    )


CONTINUUM_PLAN_SYSTEM_PROMPT = """Plan one coherent MiniMax H3 Continuum sequence and return one JSON object with no Markdown fence or commentary. The application owns chunk count, time boundaries, public reference numbering, and output serialization; do not reproduce those values as bookkeeping fields. The global.sequence_preamble is the common Continuum prompt text that will be prepended verbatim to every logical chunk. It must contain only facts and instructions that truly persist across every chunk: stable subject identity and appearance, stable speaker/voice identity when vocalization recurs, persistent Reference Image or Video Reference roles, wardrobe/prop/environment/style continuity, genuinely global camera/lighting/audio rules, exclusions, and temporal-continuity constraints. Public Reference Images and <Video 1> are persistent when present. A public First Frame <Picture N> identity is opening-chunk-only in a multi-chunk sequence; a public Last Frame <Picture N> identity is final-chunk-only; neither may appear in the shared preamble unless the sequence has only one chunk. Driving Audio is persistent conditioning and owns no <Audio N> prompt tag. Do not place chunk-local action, dialogue, later-shot changes, or a final-frame target in the shared preamble when they do not apply to every chunk. Internal planning fields continuity_anchors and persistent_constraints are required text fields but may be empty when there is genuinely no additional sequence-wide planning fact or constraint beyond sequence_preamble and the chunk states; otherwise keep them compact and semantic. Each chunk's start/action/end state remains required non-empty semantic text rather than final-prompt meta. Preserve the user's explicit dialogue and lyrics verbatim, visible text verbatim, reference semantics, exclusions, camera rules, sound rules, and intended ending. Treat explicitly assigned reference roles as exclusive: do not transfer unrelated identity, clothing, setting, lighting, camera, motion, or audio traits from a source unless the user asks for them. Do not infer dialogue, lyrics, a transcript, or exact audio content from Driving Audio or any other conditioning that is not visible/audible to the prompt model. A later chunk continues from the previous end_state unless continuity is intentional_break. Use intentional_break only for a requested cut, location/time/wardrobe change, entrance/exit, camera reset, major framing change, or another deliberate discontinuity, and explain it in transition. Do not emit reference_assignments: Prompt Writer injects authoritative downstream H3 public reference identities. subject_anchors must be [] when no stable subject identity is needed; otherwise every entry is exactly {"id":"<Subject N>","meaning":"concise stable identity and role"}. Never emit bare strings in subject_anchors and never reuse one subject id for a different entity. Before returning, silently verify the complete JSON contract: global.sequence_preamble is non-empty polished prompt prose; continuity_anchors and persistent_constraints are text; subject_anchors is [] or uses positive numeric IDs exactly like <Subject 1>, <Subject 2>; the chunk array has the exact requested length; Chunk 1 continuity is initial; later continuity is continuous or intentional_break with a non-empty transition; every start_state/action/end_state is non-empty; and no application-owned index, time, chunk-count, or reference_assignments field is present."""


def _preflight_body_references(base_input: dict[str, Any], texts: list[str]) -> None:
    missing = missing_reference_declarations(base_input, texts, continuum=True)
    if missing:
        tag = missing[0]
        raise ContinuumError(
            "REFERENCE_NOT_DECLARED",
            f"{tag} is used by the Continuum request but is not declared by the selected H3 Continuum sampler inventory.",
            {"reference": tag, "missing": missing},
        )


def assemble_continuum_plan_request(body: dict[str, Any]) -> dict[str, Any]:
    if body.get("mode") == "Music3":
        raise ContinuumError("CONTINUUM_MUSIC_UNSUPPORTED", "H3 Continuum is available only for H3 Video.")
    if not isinstance(body.get("downstream_reference_inventory"), dict):
        raise ContinuumError(
            "INVALID_DOWNSTREAM_REFERENCE_INVENTORY",
            "H3 Continuum requires the authoritative downstream conditioning inventory from the selected H3 Continuum sampler.",
            {
                "field": "downstream_reference_inventory",
                "suggestion": (
                    "Select one supported H3 Continuum sampler and retry. An explicitly empty inventory is valid "
                    "when that sampler has no active reference, keyframe, Video Reference, or Driving Audio inputs."
                ),
            },
        )
    settings = validate_continuum_settings(body)
    single_body = dict(body)
    single_body["duration_seconds"] = settings["chunk_seconds"]
    single_body["generation_target"] = GENERATION_TARGET_CONTINUUM
    base = assemble_request(single_body)
    validate_continuum_mode_topology(str(body.get("mode") or ""), base["input"])
    _preflight_body_references(base["input"], [base["input"]["creative_brief"]])
    references = _stable_reference_inventory(base["input"])
    role_labels = {
        "reference_image": "Reference Image",
        "first_frame": "First Frame keyframe",
        "last_frame": "Last Frame keyframe",
        "video_reference": "Video Reference",
        "reference_audio": "Reference Audio",
        "driving_audio": "Driving Audio",
    }
    reference_lines = "\n".join(
        (
            f"- {item.get('tag') or role_labels.get(item['role'], item['role'])}: "
            f"downstream {item['role']} conditioning"
            + (f" via {item['input_name']}" if item.get("input_name") else "")
            + f" (visible to planner: {'yes' if item['visible_to_model'] else 'no'})"
        )
        for item in references
    ) or "- None"
    user = (
        f"Underlying H3 mode: {body['mode']}\n"
        f"Sequence consists of {settings['chunks']} consecutive chunks, each {settings['chunk_seconds']:g} seconds.\n"
        f"Total sequence duration: {settings['total_seconds']:g} seconds.\n\n"
        f"Authoritative downstream H3 conditioning inventory:\n{reference_lines}\n\n"
        "Every inventory entry with an explicit public tag owns that exact H3 prompt identity. Reference Images, "
        "Video Reference, and Reference Audio are persistent across chunks. Reference Audio owns <Audio 1> when connected. "
        "Without Reference Images, a tagged First Frame is opening-chunk-only and a tagged Last Frame is final-chunk-only; "
        "do not place those scoped keyframe tags in the shared preamble of a multi-chunk sequence. Driving Audio is "
        "persistent conditioning and owns no <Audio N> tag. Any item marked not "
        "visible to the planner exists downstream but its pixels or signal were not supplied here; preserve only roles "
        "stated by the Creative Brief and do not invent unseen content.\n\n"
        f"Creative brief:\n{base['input']['creative_brief']}\n\n"
        "Return exactly the semantic schema below. Do not add chunk index/time fields or reference_assignments; "
        "Prompt Writer owns those deterministic values.\n\n"
        f"Schema:\n{_planner_schema(settings)}"
    )
    return {
        "schema_version": 1,
        "guide": {"id": "h3-continuum-plan-v2", "title": "H3 Continuum sequence plan"},
        "input": {
            **base["input"],
            "mode": "T2VA",
            "underlying_mode": body["mode"],
            "generation_target": GENERATION_TARGET_CONTINUUM,
            "continuum_stage": "plan",
            "continuum": settings,
        },
        "media_inputs": base["media_inputs"],
        "supporting_guides": [],
        "system_prompt": {"custom": False, "content": CONTINUUM_PLAN_SYSTEM_PROMPT},
        "messages": [
            {"role": "system", "name": "h3_continuum_sequence_planner", "content": CONTINUUM_PLAN_SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
    }


def _json_object(text: str) -> dict[str, Any]:
    value = text.strip()
    match = _FENCE.fullmatch(value)
    if match:
        value = match.group(1).strip()
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise ContinuumError(
            "INVALID_CONTINUUM_PLAN",
            "The sequence planner did not return valid JSON.",
            {"line": error.lineno, "column": error.colno, "reason": error.msg},
        ) from error
    if not isinstance(parsed, dict):
        raise ContinuumError("INVALID_CONTINUUM_PLAN", "The sequence plan must be a JSON object.")
    return parsed


def _embedded_plan_json_object(text: str) -> dict[str, Any] | None:
    value = str(text or "").strip()
    if not value:
        return None
    decoder = json.JSONDecoder()
    candidates: list[tuple[int, int, dict[str, Any]]] = []
    for offset, char in enumerate(value):
        if char != "{":
            continue
        try:
            parsed, consumed = decoder.raw_decode(value[offset:])
        except json.JSONDecodeError:
            continue
        if (
            isinstance(parsed, dict)
            and isinstance(parsed.get("global"), dict)
            and isinstance(parsed.get("chunks"), list)
        ):
            candidates.append((offset, offset + consumed, parsed))
    unique_spans = {(start, end) for start, end, _parsed in candidates}
    if len(unique_spans) != 1:
        return None
    return candidates[0][2]


def _punctuated_sentence(value: str) -> str:
    text = " ".join(str(value or "").split()).strip()
    if not text:
        return ""
    return text if text[-1] in ".!?" else text + "."


def _fallback_sequence_preamble(
    global_plan: dict[str, Any],
    *,
    persistent_references: set[str],
) -> str:
    parts: list[str] = []
    subjects = global_plan.get("subject_anchors")
    if isinstance(subjects, list):
        for subject in subjects:
            if not isinstance(subject, dict):
                continue
            meaning = subject.get("meaning")
            if isinstance(meaning, str) and meaning.strip():
                parts.append(meaning.strip())
    for field in ("continuity_anchors", "persistent_constraints"):
        value = global_plan.get(field)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    if persistent_references:
        tags = ", ".join(sorted(persistent_references))
        parts.append(
            f"Persistent reference identities {tags} retain their established roles throughout the sequence"
        )

    rendered: list[str] = []
    seen: set[str] = set()
    for part in parts:
        sentence = _punctuated_sentence(part)
        key = sentence.casefold()
        if sentence and key not in seen:
            rendered.append(sentence)
            seen.add(key)
    if rendered:
        return " ".join(rendered)
    return (
        "Maintain coherent visual and temporal continuity across the sequence while preserving only established "
        "persistent details and honoring any intentional transition."
    )


def recover_sequence_plan_contract(
    text: str,
    settings: dict[str, Any],
    *,
    expected_references: set[str],
    persistent_references: set[str] | None = None,
    chunk_reference_scopes: list[set[str]] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    actions: list[str] = []
    try:
        raw_plan = _json_object(text)
    except ContinuumError as strict_json_error:
        raw_plan = _embedded_plan_json_object(text)
        if raw_plan is None:
            raise strict_json_error
        actions.append("extracted_embedded_json")

    candidate = copy.deepcopy(raw_plan)
    if candidate.get("schema_version") != CONTINUUM_SCHEMA_VERSION:
        return (
            validate_sequence_plan(
                candidate,
                settings,
                expected_references=expected_references,
                persistent_references=persistent_references,
                chunk_reference_scopes=chunk_reference_scopes,
                allow_legacy=False,
            ),
            actions,
        )

    global_plan = candidate.get("global")
    if isinstance(global_plan, dict):
        for field in ("continuity_anchors", "persistent_constraints"):
            if global_plan.get(field) is None:
                global_plan[field] = ""
                actions.append(f"defaulted_{field}")
        if global_plan.get("subject_anchors") is None:
            global_plan["subject_anchors"] = []
            actions.append("defaulted_subject_anchors")
        if "reference_assignments" in global_plan:
            global_plan.pop("reference_assignments", None)
            actions.append("removed_reference_assignments")
        sequence_preamble = global_plan.get("sequence_preamble")
        if not isinstance(sequence_preamble, str) or not sequence_preamble.strip():
            global_plan["sequence_preamble"] = _fallback_sequence_preamble(
                global_plan,
                persistent_references=set(persistent_references or set()),
            )
            actions.append("synthesized_sequence_preamble")

    chunks = candidate.get("chunks")
    if isinstance(chunks, list):
        removed_index = False
        for chunk in chunks:
            if isinstance(chunk, dict) and "index" in chunk:
                chunk.pop("index", None)
                removed_index = True
        if removed_index:
            actions.append("removed_chunk_indexes")

    normalized = validate_sequence_plan(
        candidate,
        settings,
        expected_references=expected_references,
        persistent_references=persistent_references,
        chunk_reference_scopes=chunk_reference_scopes,
        allow_legacy=False,
    )
    return normalized, actions


def _nonempty_string(value: Any, field: str, *, chunk_index: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        details = {"field": field}
        if chunk_index is not None:
            details["chunk_index"] = chunk_index
        raise ContinuumError("INVALID_CONTINUUM_PLAN", f"Sequence-plan {field} must be non-empty text.", details)
    return value.strip()


def _text_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ContinuumError(
            "INVALID_CONTINUUM_PLAN",
            f"Sequence-plan {field} must be text.",
            {"field": field},
        )
    return value.strip()


def _canonical_subject_id(value: Any) -> str:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return f"<Subject {value}>"
    if not isinstance(value, str) or not value.strip():
        raise ContinuumError(
            "INVALID_CONTINUUM_PLAN",
            "Sequence-plan subject_anchors.id must identify a positive subject number.",
            {"field": "subject_anchors.id"},
        )
    raw = value.strip()
    alias_match = _SUBJECT_ALPHA_ALIAS_TAG.fullmatch(raw)
    if alias_match:
        return f"<Subject {_subject_alpha_alias_number(alias_match.group(1))}>"
    patterns = (
        r"<\s*Subject\s+([1-9]\d*)\s*>",
        r"Subject\s+([1-9]\d*)",
        r"S(?:ubject)?[_-]?([1-9]\d*)",
        r"([1-9]\d*)",
    )
    for pattern in patterns:
        match = re.fullmatch(pattern, raw, re.IGNORECASE)
        if match:
            return f"<Subject {int(match.group(1))}>"
    raise ContinuumError(
        "INVALID_CONTINUUM_PLAN",
        f"Invalid stable subject id: {raw}.",
        {
            "field": "subject_anchors.id",
            "expected": "<Subject N> with a positive numeric N",
        },
    )


def validate_sequence_plan(
    plan: dict[str, Any],
    settings: dict[str, Any],
    *,
    expected_references: set[str],
    persistent_references: set[str] | None = None,
    chunk_reference_scopes: list[set[str]] | None = None,
    allow_legacy: bool = False,
    allow_application_owned_fields: bool = False,
) -> dict[str, Any]:
    schema_version = plan.get("schema_version")
    if schema_version != CONTINUUM_SCHEMA_VERSION:
        if not (allow_legacy and schema_version == LEGACY_CONTINUUM_SCHEMA_VERSION):
            raise ContinuumError(
                "INVALID_CONTINUUM_PLAN",
                f"Sequence-plan schema_version must be {CONTINUUM_SCHEMA_VERSION}.",
            )
    global_plan = plan.get("global")
    if not isinstance(global_plan, dict):
        raise ContinuumError("INVALID_CONTINUUM_PLAN", "Sequence-plan global must be an object.")
    continuity_anchors = _normalize_plan_subject_aliases(
        _text_string(global_plan.get("continuity_anchors"), "global.continuity_anchors")
    )
    persistent_constraints = _normalize_plan_subject_aliases(
        _text_string(global_plan.get("persistent_constraints"), "global.persistent_constraints")
    )
    if schema_version == LEGACY_CONTINUUM_SCHEMA_VERSION:
        sequence_preamble = ""
    else:
        sequence_preamble = _normalize_plan_subject_aliases(
            _nonempty_string(global_plan.get("sequence_preamble"), "global.sequence_preamble")
        )
        if _contains_reserved_sequence_header(sequence_preamble):
            raise ContinuumError(
                "INVALID_CONTINUUM_PLAN",
                "The sequence-wide preamble cannot contain Continuum timeline or legacy chunk headers.",
                {"field": "global.sequence_preamble"},
            )
    normalized_assignments = [
        {
            "tag": tag,
            "role": "Preserve this exact downstream H3 public reference identity and its application-owned scope.",
        }
        for tag in sorted(expected_references)
    ]
    subject_anchors = global_plan.get("subject_anchors", [])
    if not isinstance(subject_anchors, list):
        raise ContinuumError("INVALID_CONTINUUM_PLAN", "Sequence-plan subject_anchors must be a list.")
    normalized_subjects = []
    seen_subjects: set[str] = set()
    for subject in subject_anchors:
        if not isinstance(subject, dict):
            raise ContinuumError("INVALID_CONTINUUM_PLAN", "Every subject anchor must be an object.")
        canonical_id = _canonical_subject_id(subject.get("id"))
        meaning = _normalize_plan_subject_aliases(
            _nonempty_string(subject.get("meaning"), "subject_anchors.meaning")
        )
        if canonical_id in seen_subjects:
            raise ContinuumError("INVALID_CONTINUUM_PLAN", f"Sequence plan defines {canonical_id} more than once.")
        seen_subjects.add(canonical_id)
        normalized_subjects.append({"id": canonical_id, "meaning": meaning})

    chunks = plan.get("chunks")
    if not isinstance(chunks, list) or len(chunks) != settings["chunks"]:
        raise ContinuumError(
            "INVALID_CONTINUUM_PLAN_CHUNKS",
            "Sequence-plan chunk count does not match the requested chunk count.",
            {"expected": settings["chunks"], "actual": len(chunks) if isinstance(chunks, list) else None},
        )
    global_reference_texts = [
        sequence_preamble,
        continuity_anchors,
        persistent_constraints,
        *(item["meaning"] for item in normalized_subjects),
    ]
    global_references: set[str] = set()
    global_subjects: set[str] = set()
    for text_value in global_reference_texts:
        global_references.update(reference_tags(text_value))
        global_subjects.update(subject_tags(text_value))

    normalized_chunks = []
    chunk_references: list[set[str]] = []
    chunk_subjects: list[set[str]] = []
    for index, chunk in enumerate(chunks, start=1):
        if not isinstance(chunk, dict):
            raise ContinuumError("INVALID_CONTINUUM_PLAN", f"Sequence-plan Chunk {index} must be an object.")
        if schema_version == LEGACY_CONTINUUM_SCHEMA_VERSION:
            legacy_index = chunk.get("index")
            if legacy_index != index:
                raise ContinuumError(
                    "INVALID_CONTINUUM_PLAN_CHUNKS",
                    "Legacy sequence-plan chunk indexes must be contiguous and one-based.",
                    {"expected": index, "actual": legacy_index},
                )
        elif "index" in chunk:
            if not allow_application_owned_fields:
                raise ContinuumError(
                    "INVALID_CONTINUUM_PLAN",
                    "Sequence planner must not emit application-owned chunk index fields.",
                    {"chunk_index": index, "field": "index"},
                )
            if chunk.get("index") != index:
                raise ContinuumError(
                    "INVALID_CONTINUUM_PLAN_CHUNKS",
                    "Application-normalized sequence-plan chunk indexes must remain contiguous and one-based.",
                    {"expected": index, "actual": chunk.get("index")},
                )
        continuity = chunk.get("continuity")
        allowed = {"initial"} if index == 1 else {"continuous", "intentional_break"}
        if continuity not in allowed:
            raise ContinuumError(
                "INVALID_CONTINUUM_PLAN_CONTINUITY",
                f"Chunk {index} continuity must be one of: {', '.join(sorted(allowed))}.",
            )
        transition = chunk.get("transition", "")
        if not isinstance(transition, str):
            raise ContinuumError("INVALID_CONTINUUM_PLAN", f"Chunk {index} transition must be text.")
        transition = _normalize_plan_subject_aliases(transition.strip())
        if continuity == "intentional_break" and not transition:
            raise ContinuumError(
                "INVALID_CONTINUUM_PLAN_CONTINUITY",
                f"Chunk {index} must explain its intentional continuity break.",
            )
        normalized_chunk = {
            "index": index,
            "continuity": continuity,
            "transition": transition,
            "start_state": _normalize_plan_subject_aliases(
                _nonempty_string(chunk.get("start_state"), "start_state", chunk_index=index)
            ),
            "action": _normalize_plan_subject_aliases(
                _nonempty_string(chunk.get("action"), "action", chunk_index=index)
            ),
            "end_state": _normalize_plan_subject_aliases(
                _nonempty_string(chunk.get("end_state"), "end_state", chunk_index=index)
            ),
        }
        normalized_chunks.append(normalized_chunk)
        references_for_chunk: set[str] = set()
        subjects_for_chunk: set[str] = set()
        for text_value in (
            normalized_chunk["transition"],
            normalized_chunk["start_state"],
            normalized_chunk["action"],
            normalized_chunk["end_state"],
        ):
            references_for_chunk.update(reference_tags(text_value))
            subjects_for_chunk.update(subject_tags(text_value))
        chunk_references.append(references_for_chunk)
        chunk_subjects.append(subjects_for_chunk)

    planned_subject_ids = {item["id"] for item in normalized_subjects}
    used_subject_ids = set(global_subjects)
    for subjects_for_chunk in chunk_subjects:
        used_subject_ids.update(subjects_for_chunk)
    unexpected_subjects = used_subject_ids - planned_subject_ids
    if unexpected_subjects:
        raise ContinuumError(
            "CONTINUUM_SUBJECT_IDENTITY_DRIFT",
            "The sequence plan uses subject labels that are not declared in global.subject_anchors.",
            {
                "unexpected": sorted(unexpected_subjects),
                "planned": sorted(planned_subject_ids),
            },
        )

    plan_references = set(global_references)
    for references_for_chunk in chunk_references:
        plan_references.update(references_for_chunk)
    unexpected_references = plan_references - expected_references
    if unexpected_references:
        raise ContinuumError(
            "CONTINUUM_REFERENCE_IDENTITY_DRIFT",
            "The sequence plan introduced reference labels outside the declared downstream sequence inventory.",
            {
                "unexpected": sorted(unexpected_references),
                "allowed": sorted(expected_references),
            },
        )

    persistent_allowed = (
        set(expected_references)
        if persistent_references is None
        else set(persistent_references)
    )
    scoped_global_references = global_references - persistent_allowed
    if scoped_global_references:
        raise ContinuumError(
            "CONTINUUM_REFERENCE_SCOPE_DRIFT",
            "A sequence-wide planning field uses a public reference that is not persistent across every chunk.",
            {
                "scope": "global",
                "unexpected": sorted(scoped_global_references),
                "persistent": sorted(persistent_allowed),
            },
        )

    if chunk_reference_scopes is not None:
        if len(chunk_reference_scopes) != settings["chunks"]:
            raise ContinuumError(
                "INVALID_CONTINUUM_PLAN",
                "Internal chunk reference scope count does not match the sequence chunk count.",
                {
                    "expected": settings["chunks"],
                    "actual": len(chunk_reference_scopes),
                },
            )
        for index, references_for_chunk in enumerate(chunk_references, start=1):
            allowed_for_chunk = set(chunk_reference_scopes[index - 1])
            scoped_chunk_references = references_for_chunk - allowed_for_chunk
            if scoped_chunk_references:
                raise ContinuumError(
                    "CONTINUUM_REFERENCE_SCOPE_DRIFT",
                    f"Sequence-plan Chunk {index} uses a public reference outside that chunk's downstream conditioning scope.",
                    {
                        "scope": "chunk",
                        "chunk_index": index,
                        "unexpected": sorted(scoped_chunk_references),
                        "allowed": sorted(allowed_for_chunk),
                    },
                )

    return {
        "schema_version": CONTINUUM_SCHEMA_VERSION,
        "global": {
            "sequence_preamble": sequence_preamble,
            "continuity_anchors": continuity_anchors,
            "persistent_constraints": persistent_constraints,
            "reference_assignments": normalized_assignments,
            "subject_anchors": normalized_subjects,
        },
        "chunks": normalized_chunks,
    }


def parse_sequence_plan(
    text: str,
    settings: dict[str, Any],
    *,
    expected_references: set[str],
    persistent_references: set[str] | None = None,
    chunk_reference_scopes: list[set[str]] | None = None,
) -> dict[str, Any]:
    return validate_sequence_plan(
        _json_object(text),
        settings,
        expected_references=expected_references,
        persistent_references=persistent_references,
        chunk_reference_scopes=chunk_reference_scopes,
        allow_legacy=False,
    )


def assemble_continuum_plan_repair_request(
    body: dict[str, Any],
    invalid_text: str,
    error: ContinuumError,
) -> dict[str, Any]:
    assembled = assemble_continuum_plan_request(body)
    assembled["input"]["continuum_stage"] = "plan_repair"
    assembled["messages"] = [
        {
            "role": "system",
            "name": "h3_continuum_sequence_plan_repair",
            "content": (
                CONTINUUM_PLAN_SYSTEM_PROMPT
                + "\n\nREPAIR MODE — COMPLETE CONTRACT AUDIT: The reported contract error is the first validation "
                "failure, not necessarily the only invalid field. Audit the complete sequence plan against the exact "
                "original schema and repair every contract violation required for the whole object to validate in this "
                "one bounded repair pass. Preserve every already-valid creative choice and change only invalid, missing, "
                "or structurally inconsistent contract fields. Re-check all required objects, field types, the required "
                "non-empty global.sequence_preamble, exact chunk count and continuity values, subject anchors, public-"
                "reference identity/scope, and application-owned field exclusions before returning one complete JSON "
                "object with no Markdown fence or commentary. Do not add application-owned chunk indexes, time ranges, "
                "chunk-count fields, or reference_assignments. subject_anchors must be [] or objects with exactly id and "
                "meaning; return canonical positive numeric IDs such as <Subject 1> and <Subject 2>, never alphabetic IDs "
                "such as <Subject A>. Do not preserve malformed contract syntax merely because its creative meaning is "
                "otherwise valid."
            ),
        },
        {
            "role": "user",
            "content": (
                f"First validation error: {error.message}\nDetails: {json.dumps(error.details, ensure_ascii=False)}\n\n"
                "Repair the whole object, not only that field. The returned global.sequence_preamble must be non-empty, "
                "and every stable subject ID must be canonical numeric <Subject N>.\n\n"
                f"Invalid plan:\n{invalid_text}\n\n"
                f"Original planning request:\n{assembled['messages'][-1]['content']}"
            ),
        },
    ]
    return assembled


CONTINUUM_CHUNK_SYSTEM_PROMPT = """Write exactly one chunk-local MiniMax H3 Continuum Timeline prompt body and nothing else. This is a logical span inside a Continuum sequence, not a standalone T2VA/I2VA/FL2VA/L2VA/Reference request. Never emit standalone first/last-frame alignment boilerplate, Reference-mode six-section wrappers, integrated_multimodal_description/overall_soundscape/non_diegetic_music field labels, [Shot N] headings, a Continuum Timeline header, JSON, Markdown fencing, or planning commentary. Continuum itself owns the canonical [start-end] header, prepends the shared sequence preamble, applies continuation state, and applies First Frame, Last Frame, Reference Image, Video Reference, and Driving Audio conditioning according to the downstream workflow. Write polished production prompt prose for only this span. Every detail must be grounded in something visible or audible in the requested result: establish the local starting state only as needed, then describe visible action and state progression, camera development, exact dialogue/visible text when supplied, relevant diegetic sound and requested music behavior, and the terminal state needed for the next span. Prefer one continuous shot unless the user or semantic plan requests a cut; do not invent cuts merely to add variety. Describe camera motion naturally with the motion type and only meaningful speed/amplitude qualifiers. The outer Continuum Timeline owns absolute sequence timing, so do not write absolute sequence timestamps inside a chunk body; express internal progression locally with phrases such as at the beginning, then, midway through the span, or near the end. Speakers who vocalize use stable sequence-wide IDs such as (S1), (S2); reuse the same ID when a speaker returns in later chunks. Put only the exact user-supplied spoken or sung words inside <d>[Language] ...</d>; do not translate, paraphrase, or invent missing words. Preserve visible on-screen text verbatim in English double quotation marks. Do not invent non-diegetic music; describe it only when the user requests it. A continuous chunk must evolve from the previous accepted terminal state rather than resetting to the original opening composition. Treat every explicitly assigned reference role as exclusive: do not copy unrelated identity, clothing, setting, lighting, camera, motion, or audio traits from that source. Treat public reference tags as scoped identities: persistent Reference Images, <Video 1>, and Reference Audio <Audio 1> may recur across chunks; a public First Frame <Picture N> tag may be used only in the opening chunk; a public Last Frame <Picture N> tag may be used only in the final chunk. Driving Audio owns no <Audio N> tag. Use only the public tags explicitly listed as available for this chunk. Never invent unseen reference content, dialogue, lyrics, transcript, or exact sound details from conditioning the prompt model did not receive. Preserve stable <Subject N> meanings from the sequence plan and never create a new subject id unless it is declared there."""


def _reference_scope_lines(
    request_input: dict[str, Any],
    *,
    chunk_index: int,
    chunks: int,
) -> str:
    allowed = chunk_reference_tags(
        request_input,
        chunk_index=chunk_index,
        chunks=chunks,
    )
    lines: list[str] = []
    role_labels = {
        "reference_image": "Reference Image",
        "first_frame": "First Frame",
        "last_frame": "Last Frame",
        "video_reference": "Video Reference",
        "reference_audio": "Reference Audio",
        "driving_audio": "Driving Audio",
        "model_visible_media": "Prompt Writer analysis media",
    }
    for item in _stable_reference_inventory(request_input):
        role = item["role"]
        tag = item.get("tag")
        if role in {"reference_image", "video_reference", "reference_audio"}:
            scope = "persistent across all chunks"
        elif role == "first_frame":
            scope = "opening chunk only"
        elif role == "last_frame":
            scope = "final chunk only"
        elif role == "driving_audio":
            scope = "persistent conditioning; no public prompt tag"
        else:
            scope = "analysis-only identity"
        availability = (
            "available in this chunk"
            if tag and str(tag) in allowed
            else "not a public tag in this chunk"
        )
        visible = "visible to prompt model" if item.get("visible_to_model") else "not visible to prompt model"
        lines.append(
            f"- {tag or role_labels.get(role, role)}: {role}; {scope}; {availability}; {visible}"
        )
    return "\n".join(lines) or "- None"


def _analysis_media_lines(assembled: dict[str, Any]) -> str:
    manifest = {
        str(asset.get("id")): asset
        for asset in assembled.get("input", {}).get("media_manifest", {}).get("assets", [])
        if asset.get("id")
    }
    lines = []
    for item in assembled.get("media_inputs", []):
        asset = manifest.get(str(item.get("asset_id")), {})
        filename = asset.get("filename") or item.get("asset_id") or "media"
        lines.append(f"- {item.get('reference')}: {filename} ({item.get('type')})")
    return "\n".join(lines) or "- None"


def _plan_context(plan: dict[str, Any], index: int, previous_prompt: str | None) -> str:
    chunk = plan["chunks"][index - 1]
    previous = plan["chunks"][index - 2] if index > 1 else None
    following = plan["chunks"][index] if index < len(plan["chunks"]) else None
    subjects = plan["global"].get("subject_anchors", [])
    subject_text = "\n".join(
        f"- {item['id']}: {item['meaning']}" for item in subjects
    ) or "- None"
    parts = [
        "Sequence-wide Continuum preamble that will be prepended automatically:",
        plan["global"]["sequence_preamble"] or "(none)",
        "Internal sequence continuity anchors:",
        plan["global"]["continuity_anchors"],
        "Internal persistent constraints:",
        plan["global"]["persistent_constraints"],
        "Stable subject identities:",
        subject_text,
        "Chunk-local semantic plan:",
        (
            f"Start state: {chunk['start_state']}\n"
            f"Action/progression: {chunk['action']}\n"
            f"End state: {chunk['end_state']}\n"
            f"Continuity: {chunk['continuity']}"
            + (f"\nIntentional transition: {chunk['transition']}" if chunk["transition"] else "")
        ),
    ]
    if previous is not None:
        parts.append(f"Previous planned terminal state: {previous['end_state']}")
    if previous_prompt:
        parts.append(
            "Previous chunk-local Continuum prompt. Carry forward its supported terminal state and stable identities; "
            "do not reset to the sequence opening:\n" + previous_prompt
        )
    if following is not None:
        parts.append(f"Following planned start state: {following['start_state']}")
    return "\n\n".join(parts)


def _configure_continuum_chunk_messages(
    assembled: dict[str, Any],
    body: dict[str, Any],
    plan: dict[str, Any],
    index: int,
    *,
    previous_prompt: str | None,
    current_prompt: str | None = None,
    instruction: str | None = None,
    following_prompt: str | None = None,
) -> dict[str, Any]:
    settings = validate_continuum_settings(body)
    allowed_references = chunk_reference_tags(
        assembled["input"],
        chunk_index=index,
        chunks=settings["chunks"],
    )
    original_system = assembled.get("system_prompt") or {}
    custom_guidance = (
        str(original_system.get("content") or "").strip()
        if original_system.get("custom")
        else ""
    )
    start = (index - 1) * settings["chunk_seconds"]
    end = index * settings["chunk_seconds"]
    user_parts = [
        f"Underlying user-selected H3 task: {body['mode']}",
        (
            f"Logical Continuum span: Chunk {index}/{settings['chunks']}, "
            f"{format_timeline_seconds(start)}-{format_timeline_seconds(end)} seconds. "
            "Do not output this Timeline header."
        ),
        (
            "Authoritative downstream conditioning topology for this span:\n"
            + _reference_scope_lines(
                assembled["input"],
                chunk_index=index,
                chunks=settings["chunks"],
            )
        ),
        (
            "Public reference tags available to this chunk: "
            + (", ".join(sorted(allowed_references)) if allowed_references else "None")
        ),
        "Prompt-model analysis media attached to this request:\n" + _analysis_media_lines(assembled),
        f"Creative brief:\n{assembled['input']['creative_brief']}",
        _plan_context(plan, index, previous_prompt),
    ]
    if current_prompt is not None:
        user_parts.append(f"Current selected chunk body:\n{current_prompt}")
    if instruction is not None:
        user_parts.append(f"Chunk-local refinement instruction:\n{instruction}")
    if following_prompt is not None:
        user_parts.append(
            "Following unchanged chunk-local prompt for boundary compatibility:\n" + following_prompt
        )
    if custom_guidance:
        user_parts.append(
            "User-supplied authoring guidance. Apply it only where compatible with the Continuum chunk contract:\n"
            + custom_guidance
        )
    user_parts.append(
        "Return only the complete replacement body for this logical span. Do not repeat the shared preamble. "
        "Do not emit a standalone mode wrapper or any [start-end] / [Chunk N] header."
    )

    assembled["guide"] = {
        "id": "h3-continuum-chunk-v2",
        "title": "MiniMax H3 Continuum chunk authoring contract",
    }
    assembled["supporting_guides"] = []
    assembled["system_prompt"] = {"custom": False, "content": CONTINUUM_CHUNK_SYSTEM_PROMPT}
    assembled["messages"] = [
        {
            "role": "system",
            "name": "h3_continuum_chunk_writer",
            "content": CONTINUUM_CHUNK_SYSTEM_PROMPT,
        },
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]
    assembled["input"].update(
        {
            "generation_target": GENERATION_TARGET_CONTINUUM,
            "continuum_stage": "refine_chunk" if instruction is not None else "chunk",
            "continuum": settings,
            "continuum_chunk_index": index,
            "continuum_chunk_allowed_references": sorted(allowed_references),
            "continuum_plan": plan,
        }
    )
    return assembled


def assemble_continuum_chunk_request(
    body: dict[str, Any],
    plan: dict[str, Any],
    index: int,
    *,
    previous_prompt: str | None,
) -> dict[str, Any]:
    settings = validate_continuum_settings(body)
    if not 1 <= index <= settings["chunks"]:
        raise ContinuumError("INVALID_CONTINUUM_CHUNK", "Chunk index is outside the configured sequence.")
    single_body = dict(body)
    single_body["duration_seconds"] = settings["chunk_seconds"]
    single_body["generation_target"] = GENERATION_TARGET_CONTINUUM
    assembled = assemble_request(single_body)
    expected_references = stable_reference_tags(assembled["input"])
    plan = validate_sequence_plan(
        plan,
        settings,
        expected_references=expected_references,
        persistent_references=persistent_reference_tags(
            assembled["input"],
            chunks=settings["chunks"],
        ),
        chunk_reference_scopes=sequence_reference_scopes(
            assembled["input"],
            chunks=settings["chunks"],
        ),
        allow_legacy=False,
        allow_application_owned_fields=True,
    )
    return _configure_continuum_chunk_messages(
        assembled,
        body,
        plan,
        index,
        previous_prompt=previous_prompt,
    )


def _contains_reserved_sequence_header(value: str) -> bool:
    return any(
        _LEGACY_CHUNK_HEADER.fullmatch(line) or _TIMELINE_HEADER.fullmatch(line)
        for line in value.splitlines()
    )


def validate_generated_chunk(prompt: str, assembled: dict[str, Any]) -> str:
    if not isinstance(prompt, str) or not prompt.strip():
        raise ContinuumError("EMPTY_CONTINUUM_CHUNK", "The model returned an empty Continuum chunk prompt.")
    value = prompt.strip()
    request_input = assembled["input"]
    preamble = str(
        request_input.get("continuum_plan", {})
        .get("global", {})
        .get("sequence_preamble", "")
    )
    format_violations = continuum_chunk_format_violations(
        value,
        preamble=preamble,
    )
    if format_violations:
        raise ContinuumError(
            "INVALID_CONTINUUM_CHUNK_FORMAT",
            "A generated Continuum chunk violated the chunk-local Timeline body contract.",
            {
                "chunk_index": request_input.get("continuum_chunk_index"),
                "violations": format_violations,
            },
        )
    if "continuum_chunk_allowed_references" in request_input:
        allowed = set(request_input["continuum_chunk_allowed_references"])
    else:
        allowed = effective_reference_tags(request_input, continuum=True)
    actual = reference_tags(value)
    unexpected = actual - allowed
    if unexpected:
        raise ContinuumError(
            "CONTINUUM_REFERENCE_IDENTITY_DRIFT",
            "A generated chunk introduced reference labels outside the declared downstream sequence inventory.",
            {"unexpected": sorted(unexpected), "allowed": sorted(allowed)},
        )
    planned_subjects = {
        item["id"] for item in assembled["input"].get("continuum_plan", {}).get("global", {}).get("subject_anchors", [])
    }
    actual_subjects = subject_tags(value)
    unexpected_subjects = actual_subjects - planned_subjects
    if unexpected_subjects:
        raise ContinuumError(
            "CONTINUUM_SUBJECT_IDENTITY_DRIFT",
            "A generated chunk introduced a subject label outside the stable sequence plan.",
            {"unexpected": sorted(unexpected_subjects), "planned": sorted(planned_subjects)},
        )
    return value


def _decimal_number(value: int | float | Decimal, *, positive: bool) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ContinuumError("INVALID_CONTINUUM_DURATION", "Continuum timeline duration is invalid.") from error
    if not result.is_finite() or (result <= 0 if positive else result < 0):
        qualifier = "positive" if positive else "non-negative"
        raise ContinuumError("INVALID_CONTINUUM_DURATION", f"Continuum timeline duration must be {qualifier}.")
    return result


def _decimal_seconds(value: int | float | Decimal) -> Decimal:
    return _decimal_number(value, positive=True)


def format_timeline_seconds(value: int | float | Decimal) -> str:
    decimal_value = _decimal_number(value, positive=False)
    rendered = format(decimal_value.normalize(), "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


def _normalize_chunk_bodies(prompts: list[str]) -> list[str]:
    if not isinstance(prompts, list) or not prompts:
        raise ContinuumError("INVALID_CONTINUUM_SEQUENCE", "A Continuum sequence must contain at least one chunk prompt.")
    normalized = []
    for index, prompt in enumerate(prompts, start=1):
        if not isinstance(prompt, str) or not prompt.strip():
            raise ContinuumError(
                "INVALID_CONTINUUM_SEQUENCE",
                f"Chunk {index} prompt must be non-empty text.",
                {"chunk_index": index},
            )
        value = prompt.strip()
        if _contains_reserved_sequence_header(value):
            raise ContinuumError(
                "INVALID_CONTINUUM_CHUNK_FORMAT",
                f"Chunk {index} contains a reserved Continuum timeline or legacy chunk header.",
            )
        normalized.append(value)
    return normalized


def serialize_timeline(preamble: str, prompts: list[str], chunk_seconds: int | float) -> str:
    if not isinstance(preamble, str):
        raise ContinuumError("INVALID_CONTINUUM_SEQUENCE", "Continuum shared preamble must be text.")
    preamble_value = preamble.strip()
    if preamble_value and _contains_reserved_sequence_header(preamble_value):
        raise ContinuumError(
            "INVALID_CONTINUUM_SEQUENCE",
            "Continuum shared preamble cannot contain timeline or legacy chunk headers.",
        )
    bodies = _normalize_chunk_bodies(prompts)
    duration = _decimal_seconds(chunk_seconds)
    sections = []
    for index, body in enumerate(bodies):
        start = duration * index
        end = duration * (index + 1)
        sections.append(
            f"[{format_timeline_seconds(start)}-{format_timeline_seconds(end)}s]\n{body}"
        )
    if preamble_value:
        return preamble_value + "\n\n" + "\n\n".join(sections)
    return "\n\n".join(sections)


def parse_timeline_sequence(
    script: str,
    *,
    expected_chunks: int,
    chunk_seconds: int | float,
) -> tuple[str, list[str]]:
    if not isinstance(script, str) or not script.strip():
        raise ContinuumError("INVALID_CONTINUUM_SEQUENCE", "Continuum sequence text is empty.")
    duration = _decimal_seconds(chunk_seconds)
    preamble_lines: list[str] = []
    bodies: list[str] = []
    body_lines: list[str] = []
    current_index: int | None = None

    def finish_body() -> None:
        nonlocal body_lines
        if current_index is None:
            return
        body = "\n".join(body_lines).strip()
        if not body:
            raise ContinuumError(
                "INVALID_CONTINUUM_SEQUENCE",
                f"Timeline section {current_index + 1} is empty.",
                {"chunk_index": current_index + 1},
            )
        bodies.append(body)
        body_lines = []

    for line_number, line in enumerate(script.splitlines(), start=1):
        match = _TIMELINE_HEADER.fullmatch(line)
        if match:
            finish_body()
            next_index = 0 if current_index is None else current_index + 1
            if next_index >= expected_chunks:
                raise ContinuumError(
                    "INVALID_CONTINUUM_SEQUENCE",
                    "Timeline contains more sections than configured chunks.",
                    {"line": line_number},
                )
            expected_start = duration * next_index
            expected_end = duration * (next_index + 1)
            actual_start = Decimal(match.group(1))
            actual_end = Decimal(match.group(2))
            if actual_start != expected_start or actual_end != expected_end:
                raise ContinuumError(
                    "INVALID_CONTINUUM_SEQUENCE",
                    "Timeline boundaries must exactly follow the configured chunk_seconds.",
                    {
                        "line": line_number,
                        "expected": f"[{format_timeline_seconds(expected_start)}-{format_timeline_seconds(expected_end)}s]",
                        "actual": line.strip(),
                    },
                )
            current_index = next_index
            continue
        if current_index is None:
            if _LEGACY_CHUNK_HEADER.fullmatch(line):
                raise ContinuumError(
                    "INVALID_CONTINUUM_SEQUENCE",
                    "Legacy [Chunk N] syntax is not canonical Continuum Timeline syntax.",
                    {"line": line_number},
                )
            preamble_lines.append(line)
        else:
            if _LEGACY_CHUNK_HEADER.fullmatch(line):
                raise ContinuumError(
                    "INVALID_CONTINUUM_SEQUENCE",
                    "Legacy [Chunk N] syntax cannot appear inside a Timeline sequence.",
                    {"line": line_number},
                )
            body_lines.append(line)
    finish_body()
    if current_index is None:
        raise ContinuumError("INVALID_CONTINUUM_SEQUENCE", "No canonical [start-end] Timeline sections were found.")
    if len(bodies) != expected_chunks:
        raise ContinuumError(
            "INVALID_CONTINUUM_SEQUENCE",
            "Continuum Timeline section count does not match the configured chunk count.",
            {"expected": expected_chunks, "actual": len(bodies)},
        )
    preamble = "\n".join(preamble_lines).strip()
    canonical = serialize_timeline(preamble, bodies, chunk_seconds)
    if canonical != script.strip():
        raise ContinuumError(
            "INVALID_CONTINUUM_SEQUENCE",
            "Continuum Timeline contains non-canonical whitespace or header formatting.",
        )
    return preamble, bodies


def parse_chunk_prompts(script: str, *, expected_chunks: int | None = None) -> list[str]:
    """Strict migration reader for saved v1 Prompt Writer drafts only."""
    if not isinstance(script, str) or not script.strip():
        raise ContinuumError("INVALID_CONTINUUM_SEQUENCE", "Continuum sequence text is empty.")
    prompts: list[str] = []
    current_index: int | None = None
    body: list[str] = []

    def finish() -> None:
        nonlocal body
        if current_index is None:
            if any(line.strip() for line in body):
                raise ContinuumError(
                    "INVALID_CONTINUUM_SEQUENCE",
                    "Legacy Continuum migration does not accept text before [Chunk 1].",
                )
            body = []
            return
        prompt = "\n".join(body).strip()
        if not prompt:
            raise ContinuumError(
                "INVALID_CONTINUUM_SEQUENCE",
                f"Legacy Chunk {current_index} prompt is empty.",
                {"chunk_index": current_index},
            )
        prompts.append(prompt)
        body = []

    for line_number, line in enumerate(script.splitlines(), start=1):
        match = _LEGACY_CHUNK_HEADER.fullmatch(line)
        if match:
            finish()
            index = int(match.group(1))
            expected_index = len(prompts) + 1
            if index != expected_index:
                raise ContinuumError(
                    "INVALID_CONTINUUM_SEQUENCE",
                    "Legacy Continuum chunk headers must be contiguous, unique, and one-based.",
                    {"line": line_number, "expected": expected_index, "actual": index},
                )
            current_index = index
            continue
        if _TIMELINE_HEADER.fullmatch(line):
            raise ContinuumError(
                "INVALID_CONTINUUM_SEQUENCE",
                "Legacy draft migration cannot mix [Chunk N] and Timeline headers.",
                {"line": line_number},
            )
        body.append(line)
    finish()
    if not prompts:
        raise ContinuumError("INVALID_CONTINUUM_SEQUENCE", "No legacy [Chunk N] sections were found.")
    if expected_chunks is not None and len(prompts) != expected_chunks:
        raise ContinuumError(
            "INVALID_CONTINUUM_SEQUENCE",
            "Legacy Continuum sequence chunk count does not match the configured count.",
            {"expected": expected_chunks, "actual": len(prompts)},
        )
    return prompts


def serialize_chunk_prompts(prompts: list[str]) -> str:
    """Legacy v1 serializer retained only for deterministic saved-draft migration tests."""
    bodies = _normalize_chunk_bodies(prompts)
    return "\n\n".join(f"[Chunk {index}]\n{body}" for index, body in enumerate(bodies, start=1))


def resolved_chunk_prompt(preamble: str, body: str) -> str:
    preamble_value = str(preamble or "").strip()
    body_value = str(body or "").strip()
    if preamble_value:
        return preamble_value + "\n\n" + body_value
    return body_value


def prompt_hash(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def sequence_result(
    settings: dict[str, Any],
    plan: dict[str, Any],
    prompts: list[str],
    *,
    preamble: str | None = None,
    downstream_reference_inventory: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bodies = _normalize_chunk_bodies(prompts)
    if len(bodies) != settings["chunks"]:
        raise ContinuumError(
            "INVALID_CONTINUUM_SEQUENCE",
            "Continuum chunk count does not match configured settings.",
            {"expected": settings["chunks"], "actual": len(bodies)},
        )
    shared = (
        str(plan.get("global", {}).get("sequence_preamble", ""))
        if preamble is None
        else str(preamble)
    ).strip()
    canonical = serialize_timeline(shared, bodies, settings["chunk_seconds"])
    parsed_preamble, parsed_bodies = parse_timeline_sequence(
        canonical,
        expected_chunks=settings["chunks"],
        chunk_seconds=settings["chunk_seconds"],
    )
    if parsed_preamble != shared or parsed_bodies != bodies:
        raise ContinuumError("INVALID_CONTINUUM_SEQUENCE", "Canonical Continuum Timeline did not round-trip.")
    chunks = []
    for index, body in enumerate(parsed_bodies, start=1):
        resolved = resolved_chunk_prompt(parsed_preamble, body)
        chunks.append({
            "index": index,
            "body": body,
            "prompt": body,
            "resolved_prompt": resolved,
            "hash": prompt_hash(resolved),
        })
    result = {
        "schema_version": CONTINUUM_SCHEMA_VERSION,
        "settings": settings,
        "plan": plan,
        "preamble": parsed_preamble,
        "chunks": chunks,
        "prompt": canonical,
    }
    if downstream_reference_inventory is not None:
        result["downstream_reference_inventory"] = normalized_downstream_inventory(
            downstream_reference_inventory
        )
    return result


def _parse_current_sequence(
    text: str,
    settings: dict[str, Any],
    *,
    allow_legacy: bool = False,
) -> tuple[str, list[str], bool]:
    try:
        preamble, bodies = parse_timeline_sequence(
            text,
            expected_chunks=settings["chunks"],
            chunk_seconds=settings["chunk_seconds"],
        )
        return preamble, bodies, False
    except ContinuumError as timeline_error:
        if not allow_legacy:
            raise timeline_error
        try:
            bodies = parse_chunk_prompts(text, expected_chunks=settings["chunks"])
        except ContinuumError:
            raise timeline_error
        return "", bodies, True


def assemble_continuum_refinement(
    body: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], int, dict[str, Any]]:
    settings = validate_continuum_settings(body)
    continuum = body.get("continuum")
    if not isinstance(continuum, dict):
        raise ContinuumError("INVALID_CONTINUUM_SETTINGS", "H3 Continuum refinement settings are missing.")
    plan_value = continuum.get("plan")
    if not isinstance(plan_value, dict):
        raise ContinuumError("INVALID_CONTINUUM_PLAN", "H3 Continuum refinement requires its saved sequence plan.")

    plan_request = assemble_continuum_plan_request(body)
    active_inventory = plan_request["input"]["downstream_reference_inventory"]
    saved_inventory = validate_saved_downstream_inventory(
        continuum.get("downstream_reference_inventory"),
        active_inventory,
    )
    expected_references = stable_reference_tags(plan_request["input"])
    plan = validate_sequence_plan(
        plan_value,
        settings,
        expected_references=expected_references,
        persistent_references=persistent_reference_tags(
            plan_request["input"],
            chunks=settings["chunks"],
        ),
        chunk_reference_scopes=sequence_reference_scopes(
            plan_request["input"],
            chunks=settings["chunks"],
        ),
        allow_legacy=True,
        allow_application_owned_fields=plan_value.get("schema_version") == CONTINUUM_SCHEMA_VERSION,
    )
    current_text = str(body.get("current_prompt") or "")
    preamble, prompts, migrated_legacy = _parse_current_sequence(
        current_text,
        settings,
        allow_legacy=plan_value.get("schema_version") == LEGACY_CONTINUUM_SCHEMA_VERSION,
    )
    if not migrated_legacy and preamble != plan["global"]["sequence_preamble"]:
        raise ContinuumError(
            "INVALID_CONTINUUM_SEQUENCE",
            "The edited Timeline preamble no longer matches the saved sequence-wide plan. Regenerate the sequence to change global state.",
        )
    _preflight_body_references(
        plan_request["input"],
        [
            plan_request["input"]["creative_brief"],
            current_text,
            str(body.get("instruction") or ""),
        ],
    )
    validate_sequence_reference_scope(
        plan_request["input"],
        preamble=preamble,
        prompts=prompts,
        chunks=settings["chunks"],
    )
    chunk_index = continuum.get("chunk_index")
    if not isinstance(chunk_index, int) or isinstance(chunk_index, bool) or not 1 <= chunk_index <= settings["chunks"]:
        raise ContinuumError(
            "INVALID_CONTINUUM_CHUNK",
            "Select a valid one-based Continuum chunk to refine.",
            {"chunk_index": chunk_index},
        )

    refine_body = dict(body)
    refine_body["duration_seconds"] = settings["chunk_seconds"]
    refine_body["generation_target"] = GENERATION_TARGET_CONTINUUM
    refine_body["current_prompt"] = prompts[chunk_index - 1]
    assembled = assemble_refinement(refine_body, None)
    previous_prompt = prompts[chunk_index - 2] if chunk_index > 1 else None
    following_prompt = prompts[chunk_index] if chunk_index < len(prompts) else None
    assembled = _configure_continuum_chunk_messages(
        assembled,
        body,
        plan,
        chunk_index,
        previous_prompt=previous_prompt,
        current_prompt=prompts[chunk_index - 1],
        instruction=str(body.get("instruction") or ""),
        following_prompt=following_prompt,
    )
    return assembled, {
        "preamble": preamble,
        "prompts": prompts,
        "downstream_reference_inventory": saved_inventory,
    }, chunk_index, plan


def apply_continuum_refinement(
    result_prompt: str,
    assembled: dict[str, Any],
    sequence_state: dict[str, Any],
    chunk_index: int,
    plan: dict[str, Any],
) -> dict[str, Any]:
    refined = validate_generated_chunk(result_prompt, assembled)
    preamble = str(sequence_state.get("preamble") or "")
    if preamble and refined.startswith(preamble):
        raise ContinuumError(
            "INVALID_CONTINUUM_CHUNK_FORMAT",
            "Chunk-local refinement repeated the immutable sequence-wide preamble.",
            {"chunk_index": chunk_index},
        )
    updated = list(sequence_state["prompts"])
    updated[chunk_index - 1] = refined
    settings = assembled["input"]["continuum"]
    return sequence_result(
        settings,
        plan,
        updated,
        preamble=preamble,
        downstream_reference_inventory=sequence_state.get("downstream_reference_inventory"),
    )
