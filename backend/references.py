from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


CANONICAL_REFERENCE_TAG = re.compile(r"<(Picture|Video|Audio) ([1-9]\d*)>")
REFERENCE_TAG = re.compile(r"<\s*(Picture|Video|Audio)\s+(\d+)\s*>", re.IGNORECASE)


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
    }


@dataclass(frozen=True)
class ReferencePolicy:
    required: set[str]
    mutable: set[str]
    allowed: set[str]


def reference_policy(request_input: dict[str, Any]) -> ReferencePolicy:
    if request_input.get("mode") != "Reference":
        return ReferencePolicy(set(), set(), set())

    assets = request_input.get("media_manifest", {}).get("assets", [])
    allowed = {asset["reference"] for asset in assets if asset.get("reference")}
    required = {
        asset["reference"]
        for asset in assets
        if asset.get("reference") and asset.get("type") != "audio"
    }
    allowed_audio = {
        asset["reference"]
        for asset in assets
        if asset.get("reference") and asset.get("type") == "audio"
    }
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
