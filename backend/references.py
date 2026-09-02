from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


CANONICAL_REFERENCE_TAG = re.compile(r"<(Picture|Video|Audio) ([1-9]\d*)>")
REFERENCE_TAG = re.compile(r"<\s*(Picture|Video|Audio)\s+(\d+)\s*>", re.IGNORECASE)

DOWNSTREAM_REFERENCE_SCHEMA_VERSION = 1
DOWNSTREAM_REFERENCE_ROLES = {
    "reference_image": "image",
    "first_frame": "image",
    "last_frame": "image",
    "video_reference": "video",
    "reference_audio": "audio",
    "driving_audio": "audio",
}
DOWNSTREAM_REFERENCE_SOURCES = {"workflow", "manual"}


def canonical_reference_tags(text: str, kind: str | None = None) -> set[str]:
    return {
        f"<{tag_kind} {number}>"
        for tag_kind, number in CANONICAL_REFERENCE_TAG.findall(text)
        if kind is None or tag_kind == kind
    }


def reference_tags(text: str) -> set[str]:
    return {
        f"<{kind.title()} {number}>"
        for kind, number in REFERENCE_TAG.findall(text)
        if int(number) > 0
    }


def normalize_downstream_reference_inventory(value: Any) -> dict[str, Any]:
    if value is None:
        return {"schema_version": DOWNSTREAM_REFERENCE_SCHEMA_VERSION, "items": []}
    if not isinstance(value, dict):
        raise ValueError("Downstream H3 reference inventory must be a JSON object.")
    schema_version = value.get("schema_version", DOWNSTREAM_REFERENCE_SCHEMA_VERSION)
    if schema_version != DOWNSTREAM_REFERENCE_SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported downstream H3 reference inventory schema {schema_version}; "
            f"expected {DOWNSTREAM_REFERENCE_SCHEMA_VERSION}."
        )
    raw_items = value.get("items", [])
    if not isinstance(raw_items, list):
        raise ValueError("Downstream H3 reference inventory items must be a list.")

    items: list[dict[str, Any]] = []
    seen_tags: set[str] = set()
    seen_singleton_roles: set[str] = set()
    for offset, raw in enumerate(raw_items, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"Downstream H3 reference inventory item {offset} must be an object.")
        role = raw.get("role")
        if role not in DOWNSTREAM_REFERENCE_ROLES:
            raise ValueError(f"Downstream H3 reference inventory item {offset} has an unsupported role.")
        if role != "reference_image":
            if role in seen_singleton_roles:
                raise ValueError(f"Downstream H3 reference inventory defines role {role!r} more than once.")
            seen_singleton_roles.add(role)

        expected_kind = DOWNSTREAM_REFERENCE_ROLES[role]
        kind = raw.get("kind", expected_kind)
        if kind != expected_kind:
            raise ValueError(
                f"Downstream H3 reference inventory item {offset} kind must be {expected_kind!r} for role {role!r}."
            )
        source = raw.get("source", "workflow")
        if source not in DOWNSTREAM_REFERENCE_SOURCES:
            raise ValueError(f"Downstream H3 reference inventory item {offset} has an unsupported source.")
        visible_to_model = raw.get("visible_to_model", False)
        if not isinstance(visible_to_model, bool):
            raise ValueError(
                f"Downstream H3 reference inventory item {offset} visible_to_model must be a boolean."
            )

        tag = raw.get("tag")
        if tag in (None, ""):
            tag = None
        else:
            tag = str(tag)
            if reference_tags(tag) != {tag} or not CANONICAL_REFERENCE_TAG.fullmatch(tag):
                raise ValueError(
                    f"Downstream H3 reference inventory item {offset} uses an invalid public reference tag."
                )
            if tag in seen_tags:
                raise ValueError(f"Downstream H3 reference inventory defines {tag} more than once.")
            seen_tags.add(tag)

        if role == "reference_image" and (tag is None or not tag.startswith("<Picture ")):
            raise ValueError(
                f"Downstream H3 reference inventory item {offset} must use a canonical <Picture N> tag."
            )
        if role in {"first_frame", "last_frame"} and tag is not None and not tag.startswith("<Picture "):
            raise ValueError(f"Downstream H3 role {role!r} can only own a <Picture N> tag.")
        if role == "video_reference" and tag != "<Video 1>":
            raise ValueError("Downstream H3 Video Reference must use public tag <Video 1>.")
        if role == "reference_audio" and tag != "<Audio 1>":
            raise ValueError("Downstream H3 Reference Audio must use public tag <Audio 1>.")
        if role == "driving_audio" and tag is not None:
            raise ValueError("Downstream H3 Driving Audio does not own a public <Audio N> tag.")

        item: dict[str, Any] = {
            "role": role,
            "kind": kind,
            "source": source,
            "visible_to_model": visible_to_model,
        }
        if tag:
            item["tag"] = tag
        for field in ("input_name", "source_node_id", "source_node_class", "source_output_name"):
            field_value = raw.get(field)
            if field_value is not None:
                if not isinstance(field_value, (str, int)) or isinstance(field_value, bool):
                    raise ValueError(
                        f"Downstream H3 reference inventory item {offset} {field} must be text or an integer."
                    )
                item[field] = field_value
        model_asset_id = raw.get("model_asset_id")
        if model_asset_id is not None:
            if not isinstance(model_asset_id, str) or not model_asset_id.strip():
                raise ValueError(
                    f"Downstream H3 reference inventory item {offset} model_asset_id must be non-empty text."
                )
            model_asset_id = model_asset_id.strip()
            item["model_asset_id"] = model_asset_id
        if visible_to_model != bool(model_asset_id):
            raise ValueError(
                f"Downstream H3 reference inventory item {offset} visible_to_model must be true exactly when model_asset_id is set."
            )

        source_slot = raw.get("source_slot")
        if source_slot is not None:
            if not isinstance(source_slot, int) or isinstance(source_slot, bool) or source_slot < 0:
                raise ValueError(
                    f"Downstream H3 reference inventory item {offset} source_slot must be a non-negative integer."
                )
            item["source_slot"] = source_slot

        source_identity = raw.get("source_identity")
        if source_identity is not None:
            if not isinstance(source_identity, str) or not source_identity.strip():
                raise ValueError(
                    f"Downstream H3 reference inventory item {offset} source_identity must be non-empty text."
                )
            item["source_identity"] = source_identity.strip()
        items.append(item)

    reference_images = [item for item in items if item["role"] == "reference_image"]
    first_frame = next((item for item in items if item["role"] == "first_frame"), None)
    last_frame = next((item for item in items if item["role"] == "last_frame"), None)

    expected_reference_tags = [f"<Picture {index}>" for index in range(1, len(reference_images) + 1)]
    actual_reference_tags = [str(item.get("tag") or "") for item in reference_images]
    if actual_reference_tags != expected_reference_tags:
        raise ValueError(
            "Downstream H3 Reference Images must use compact public tags <Picture 1> through <Picture N> "
            "in active connection order."
        )

    if reference_images:
        if any(item is not None and item.get("tag") for item in (first_frame, last_frame)):
            raise ValueError(
                "First/Last Frame must not own public <Picture N> tags when H3 Continuum Reference Images are active; "
                "Continuum reserves public Picture numbering for the Reference Images in hybrid presentation."
            )
    else:
        keyframes = [item for item in (first_frame, last_frame) if item is not None]
        expected_keyframe_tags = [f"<Picture {index}>" for index in range(1, len(keyframes) + 1)]
        actual_keyframe_tags = [str(item.get("tag") or "") for item in keyframes]
        if actual_keyframe_tags != expected_keyframe_tags:
            raise ValueError(
                "Without H3 Continuum Reference Images, active First/Last Frame inputs must own compact public "
                "<Picture 1> through <Picture N> tags in temporal order."
            )

    return {"schema_version": DOWNSTREAM_REFERENCE_SCHEMA_VERSION, "items": items}


def downstream_reference_tags(request_input: dict[str, Any]) -> set[str]:
    inventory = normalize_downstream_reference_inventory(
        request_input.get("downstream_reference_inventory")
    )
    return {str(item["tag"]) for item in inventory["items"] if item.get("tag")}


def effective_reference_tags(request_input: dict[str, Any], *, continuum: bool = False) -> set[str]:
    assets = request_input.get("media_manifest", {}).get("assets", [])
    manifest_tags = {
        str(asset["reference"])
        for asset in assets
        if asset.get("reference")
    }
    if not continuum:
        return manifest_tags

    inventory_declared = "downstream_reference_inventory" in request_input
    downstream = downstream_reference_tags(request_input)
    if inventory_declared:
        # Continuum's selected downstream workflow owns the public prompt identities.
        # Prompt Writer media can be model-visible analysis without being a generation
        # reference, so its manifest labels must not leak into the allowed Continuum set.
        return downstream
    return manifest_tags | downstream


def missing_reference_declarations(
    request_input: dict[str, Any],
    texts: list[str],
    *,
    continuum: bool = False,
) -> list[str]:
    used: set[str] = set()
    for text in texts:
        used.update(reference_tags(str(text or "")))
    return sorted(used - effective_reference_tags(request_input, continuum=continuum))


@dataclass(frozen=True)
class ReferencePolicy:
    required: set[str]
    mutable: set[str]
    allowed: set[str]


def reference_policy(request_input: dict[str, Any]) -> ReferencePolicy:
    if request_input.get("mode") != "Reference":
        return ReferencePolicy(set(), set(), set())

    continuum = request_input.get("generation_target") == "continuum"
    allowed = effective_reference_tags(request_input, continuum=continuum)
    assets = request_input.get("media_manifest", {}).get("assets", [])
    required = {
        str(asset["reference"])
        for asset in assets
        if asset.get("reference") and asset.get("type") != "audio"
    }
    if continuum and "downstream_reference_inventory" in request_input:
        required = {
            tag for tag in allowed
            if tag.startswith("<Picture ") or tag in {"<Video 1>", "<Audio 1>"}
        }
    allowed_audio = {
        str(asset["reference"])
        for asset in assets
        if asset.get("reference") and asset.get("type") == "audio"
    }
    if continuum and "downstream_reference_inventory" in request_input:
        allowed_audio = {tag for tag in allowed if tag.startswith("<Audio ")}
    if "instruction" not in request_input:
        brief_audio = canonical_reference_tags(str(request_input.get("creative_brief", "")), "Audio")
        required.update(brief_audio & allowed_audio)
        return ReferencePolicy(required, set(), allowed)

    mutable = canonical_reference_tags(str(request_input.get("instruction", "")), "Audio") & allowed_audio
    current_audio = {
        tag for tag in reference_tags(str(request_input.get("current_prompt", "")))
        if tag.startswith("<Audio ")
    }
    required.update((current_audio & allowed_audio) - mutable)
    required.difference_update(mutable)
    return ReferencePolicy(required, mutable, allowed)


def bind_downstream_reference_inventory(
    inventory: dict[str, Any] | None,
    manifest: dict[str, Any],
) -> dict[str, Any] | None:
    if inventory is None:
        return None
    normalized = normalize_downstream_reference_inventory(inventory)
    assets = {str(asset.get("id")): asset for asset in manifest.get("assets", []) if asset.get("id")}
    seen_asset_ids: set[str] = set()
    for item in normalized["items"]:
        asset_id = item.get("model_asset_id")
        if not asset_id:
            continue
        if asset_id in seen_asset_ids:
            raise ValueError(f"Prompt Writer media asset {asset_id} is bound to more than one downstream H3 conditioning input.")
        seen_asset_ids.add(asset_id)
        asset = assets.get(asset_id)
        if asset is None:
            raise ValueError(
                f"Downstream H3 conditioning item {item.get('tag') or item['role']} references missing Prompt Writer media asset {asset_id}."
            )
        if asset.get("type") != item["kind"]:
            raise ValueError(
                f"Prompt Writer media asset {asset_id} is {asset.get('type')!r}, but downstream role {item['role']!r} requires {item['kind']!r}."
            )
    return normalized


def model_media_labels(
    manifest: dict[str, Any],
    inventory: dict[str, Any] | None,
    *,
    mode: str,
) -> dict[str, str]:
    assets = list(manifest.get("assets", []))
    if inventory is None:
        return {
            str(asset["id"]): str(asset.get("reference") or asset.get("filename") or asset["id"])
            for asset in assets
            if asset.get("id")
        }
    bindings = {
        str(item["model_asset_id"]): item
        for item in inventory.get("items", [])
        if item.get("model_asset_id")
    }
    counters = {"image": 0, "video": 0, "audio": 0}
    labels: dict[str, str] = {}
    role_labels = {
        "first_frame": "Downstream First Frame",
        "last_frame": "Downstream Last Frame",
        "video_reference": "Downstream Video Reference",
        "reference_audio": "Downstream Reference Audio",
        "driving_audio": "Downstream Driving Audio",
    }
    for asset in assets:
        asset_id = str(asset.get("id") or "")
        if not asset_id:
            continue
        bound = bindings.get(asset_id)
        if bound is not None:
            labels[asset_id] = str(bound.get("tag") or role_labels.get(bound["role"]) or bound["role"])
            continue
        kind = str(asset.get("type") or "media")
        if kind in counters:
            counters[kind] += 1
            labels[asset_id] = f"Analysis {kind} {counters[kind]} (no downstream public reference identity)"
        else:
            labels[asset_id] = f"Analysis media {asset_id} (no downstream public reference identity)"
    return labels
