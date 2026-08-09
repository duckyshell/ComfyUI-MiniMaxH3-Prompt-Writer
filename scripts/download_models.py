from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser(description="Download pinned H3 Prompt Writer models with Hugging Face Xet.")
    parser.add_argument("model", nargs="*", help="Configured model id; omit to download all")
    parser.add_argument("--target", type=Path, required=True)
    args = parser.parse_args()

    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    from huggingface_hub import snapshot_download

    configured = json.loads((ROOT / "models.json").read_text(encoding="utf-8"))["models"]
    selected = set(args.model)
    if selected:
        configured = [item for item in configured if item["id"] in selected]
    if not configured:
        raise SystemExit("No configured model matched.")

    args.target.mkdir(parents=True, exist_ok=True)
    for item in configured:
        destination = args.target / item["id"]
        print(f"Downloading {item['repo']} at {item['revision']} -> {destination}", flush=True)
        snapshot_download(
            repo_id=item["repo"],
            revision=item["revision"],
            local_dir=destination,
            allow_patterns=item.get("files"),
        )
        print(f"Completed {item['id']}", flush=True)


if __name__ == "__main__":
    main()
