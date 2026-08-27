"""Thin standalone host for H3 Prompt Writer."""

from pathlib import Path


VERSION_FILE = Path(__file__).resolve().parents[1] / "VERSION"
__version__ = VERSION_FILE.read_text(encoding="utf-8").strip()
