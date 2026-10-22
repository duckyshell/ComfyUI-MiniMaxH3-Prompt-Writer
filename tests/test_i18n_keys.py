import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EN_SOURCE = (ROOT / "web" / "locales" / "en.js").read_text(encoding="utf-8")
ZH_SOURCE = (ROOT / "web" / "locales" / "zh-CN.js").read_text(encoding="utf-8")
KEY_RE = re.compile(r'^\s*"([^"]+)"\s*:\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)', re.M)
CODE_RE = re.compile(
    r'\b(?:_error|ModelError|MediaError|AssemblyError|ContextPlanError|SystemPromptError)\(\s*"([A-Z][A-Z0-9_]*)"'
)

FRONTEND_CODES = {
    "REQUEST_FAILED", "INVALID_RESPONSE", "NETWORK_ERROR", "REQUEST_TIMEOUT",
    "STREAM_INTERRUPTED", "UNKNOWN", "INSUFFICIENT_FREE_VRAM",
    "EXTERNAL_VISION_REQUIRED", "CONTEXT_BUDGET_EXCEEDED",
    "WRITER_PREPARATION_CANCELLED", "COMFYUI_STATE_UNAVAILABLE", "COMFYUI_BUSY",
    "COMFYUI_BECAME_BUSY", "COMFYUI_RELEASE_TIMEOUT", "WRITER_UNLOAD_FAILED",
    "WRITER_UNLOAD_TIMEOUT", "WRITER_HANDOFF_TIMEOUT",
    "SEQUENCE_ATTENTION_REQUIRED", "SEQUENCE_CURSOR_MISSING",
    "SEQUENCE_MEDIA_NOT_IN_SEQUENCE", "SEQUENCE_MEDIA_NOT_IN_CHUNK",
    "SEQUENCE_UNSUPPORTED_MEDIA",
}


def keys(source):
    return {match.group(1) for match in KEY_RE.finditer(source)}


def backend_codes():
    codes = set()
    for path in (ROOT / "backend").rglob("*.py"):
        codes.update(CODE_RE.findall(path.read_text(encoding="utf-8")))
    return codes


class I18nKeysTest(unittest.TestCase):
    def test_dictionaries_have_identical_keys(self):
        self.assertEqual(keys(EN_SOURCE), keys(ZH_SOURCE))

    def test_no_empty_translation_values(self):
        for source in (EN_SOURCE, ZH_SOURCE):
            for match in KEY_RE.finditer(source):
                self.assertTrue(match.group(2).strip('"`').strip(), match.group(1))

    def test_every_static_backend_error_code_is_translated(self):
        codes = backend_codes()
        self.assertTrue(codes, "backend error-code scan matched nothing; the regex or backend layout changed")
        missing = {f"errors.{code}" for code in codes} - keys(ZH_SOURCE)
        self.assertFalse(missing, sorted(missing))

    def test_frontend_and_vram_codes_are_translated(self):
        missing = {f"errors.{code}" for code in FRONTEND_CODES} - keys(ZH_SOURCE)
        self.assertFalse(missing, sorted(missing))
