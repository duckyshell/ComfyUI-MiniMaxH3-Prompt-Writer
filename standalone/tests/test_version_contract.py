from __future__ import annotations

import re
import tomllib
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
STANDALONE_ROOT = REPOSITORY_ROOT / "standalone"


class VersionContractTest(unittest.TestCase):
    def test_extension_and_standalone_versions_are_independent(self) -> None:
        project = tomllib.loads((REPOSITORY_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        extension_version = project["project"]["version"]
        backend_source = (REPOSITORY_ROOT / "backend" / "version.py").read_text(encoding="utf-8")
        match = re.search(r'^VERSION\s*=\s*"([^"]+)"', backend_source, re.MULTILINE)
        self.assertIsNotNone(match)
        self.assertEqual(extension_version, "0.4.4")
        self.assertEqual(match.group(1), extension_version)

        standalone_version = (STANDALONE_ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertEqual(standalone_version, "0.1.3")
        self.assertNotEqual(standalone_version, extension_version)
        self.assertNotIn("standalone", project["project"]["name"].lower())

    def test_registry_package_excludes_standalone_files(self) -> None:
        patterns = {
            line.strip()
            for line in (REPOSITORY_ROOT / ".comfyignore").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        self.assertIn("standalone/", patterns)
        self.assertIn("docs/dev/standalone/", patterns)
        self.assertIn("scripts/", patterns)
        self.assertIn("tests/", patterns)

    def test_release_builds_are_clean_and_preserve_user_settings(self) -> None:
        extension_build = (REPOSITORY_ROOT / "scripts" / "build_extension.ps1").read_text(encoding="utf-8")
        standalone_build = (REPOSITORY_ROOT / "scripts" / "build_standalone.ps1").read_text(encoding="utf-8")

        self.assertIn("ls-files", extension_build)
        self.assertIn("core.excludesFile", extension_build)
        self.assertIn("AllowDirty", extension_build)
        self.assertIn("AllowDirty", standalone_build)
        self.assertIn('"settings.example.json"', standalone_build)
        self.assertNotIn('(Join-Path $dataTarget "settings.json")', standalone_build)
