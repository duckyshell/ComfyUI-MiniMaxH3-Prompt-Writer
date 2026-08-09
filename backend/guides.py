from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path


GUIDES_DIR = Path(__file__).resolve().parent.parent / "guides"
SOURCE_REVISION = "bfc8ed0353f5a9733be73e6b2c98ec0948195b86"
SOURCE_ROOT = f"https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/{SOURCE_REVISION}/docs"


@dataclass(frozen=True)
class GuideSpec:
    id: str
    title: str
    filename: str
    source_sha256: str

    @property
    def source_url(self) -> str:
        return f"{SOURCE_ROOT}/{self.filename}"


GUIDES = {
    "base": GuideSpec(
        id="base",
        title="MiniMax H3 Video Prompt Writing Guide",
        filename="VIDEO_PROMPT_WRITING_GUIDE_base_en.md",
        source_sha256="2cfebc096a6e08370f288d468d90b60f7f9bcb938f94bf090816e910e48e75fc",
    ),
    "reference": GuideSpec(
        id="reference",
        title="MiniMax H3 Reference Prompt Writing Guide",
        filename="VIDEO_PROMPT_WRITING_GUIDE_ref_en.md",
        source_sha256="1e574f356716ad55612247ffb7bbccbcdb484ad96599d63c7dca1af186b1fab7",
    ),
}
MODE_GUIDES = {
    "T2VA": "base",
    "I2VA": "base",
    "FL2VA": "base",
    "L2VA": "base",
    "Reference": "reference",
}


def _normalized(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").rstrip() + "\n"


@lru_cache(maxsize=2)
def load_guide(guide_id: str) -> dict[str, str]:
    spec = GUIDES[guide_id]
    content = _normalized((GUIDES_DIR / spec.filename).read_text(encoding="utf-8-sig"))
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if digest != spec.source_sha256:
        raise RuntimeError(f"Official guide integrity check failed for {spec.filename}.")
    return {
        **asdict(spec),
        "source_url": spec.source_url,
        "source_revision": SOURCE_REVISION,
        "content_sha256": digest,
        "content": content,
    }


def guide_for_mode(mode: str) -> dict[str, str]:
    return load_guide(MODE_GUIDES[mode])


@lru_cache(maxsize=1)
def reference_base_excerpt() -> str:
    """Return only the shared base-guide rules referenced by full-reference mode."""
    content = load_guide("base")["content"]
    sections = content.split("\n### ")
    selected: list[str] = []
    paragraph_limits = {
        "4.2 Shots and Cuts": 1,
        "4.3 Camera Motion: Motion Type + Amplitude + Speed": 1,
        "4.4 Speakers, Dialogue, and Singing": 2,
        "4.5 On-Screen Text": 1,
        "4.6 overall_soundscape": 1,
        "4.7 non_diegetic_music": 1,
    }
    for section in sections:
        title, _, body = section.partition("\n")
        limit = paragraph_limits.get(title.strip())
        if limit is None:
            continue
        paragraphs = [part.strip() for part in body.split("\n\n") if part.strip()]
        prose = [part for part in paragraphs if not part.startswith(("```", "|", "## "))]
        selected.append(f"### {title.strip()}\n\n" + "\n\n".join(prose[:limit]))
    if len(selected) != len(paragraph_limits):
        raise RuntimeError("Could not extract the required shared rules from the official base guide.")
    return (
        "# Shared official base-guide rules used by full-reference mode\n\n"
        + "\n\n".join(selected)
        + "\n"
    )


def guide_catalog() -> list[dict[str, str | list[str]]]:
    result = []
    for guide_id in GUIDES:
        guide = load_guide(guide_id)
        result.append({
            key: value for key, value in guide.items() if key != "content"
        } | {"modes": [mode for mode, mapped in MODE_GUIDES.items() if mapped == guide_id]})
    return result
