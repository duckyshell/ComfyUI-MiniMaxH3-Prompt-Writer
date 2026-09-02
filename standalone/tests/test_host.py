from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from backend.gguf_metadata import classify_gguf_file
from backend.models.contract import ModelError
from h3_standalone.app import create_app
from h3_standalone.config import load_settings, validate_upstream
from h3_standalone.external_backend import _ManagedChatHandler, standalone_external_backend_class
from h3_standalone.managed_gguf import ManagedGGUFBackend, ManagedGGUFController, managed_runtime_diagnostics
from h3_standalone.managed_runtime import ManagedLlamaServer


class StandaloneHostTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.settings = load_settings(no_browser=True)
        validate_upstream(self.settings.upstream_repo)
        self.client = TestClient(TestServer(create_app(self.settings)))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()

    async def test_shell_and_health(self) -> None:
        response = await self.client.get("/")
        self.assertEqual(response.status, 200)
        self.assertIn("/scripts/boot.js", await response.text())

        response = await self.client.get("/healthz")
        payload = await response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["version"], "0.1.3")
        self.assertEqual(payload["standalone_version"], "0.1.3")
        self.assertRegex(payload["core_version"], r"^\d+\.\d+\.\d+$")

        response = await self.client.get("/standalone/gguf/state")
        payload = await response.json()
        self.assertIn("server_selected", payload)
        self.assertIn("discovery", payload)

    async def test_upstream_routes_and_static_assets(self) -> None:
        for path in (
            "/h3studio/status",
            "/h3studio/models",
            "/h3studio/guides",
            "/h3studio/system-prompt/T2VA",
            "/h3studio/ollama/status",
            "/h3studio/api-provider/presets",
        ):
            with self.subTest(path=path):
                response = await self.client.get(path)
                self.assertEqual(response.status, 200)

        response = await self.client.get("/main.js")
        self.assertEqual(response.status, 200)
        self.assertIn('from "/scripts/app.js"', await response.text())

        response = await self.client.get("/scripts/managed_gguf.js")
        self.assertEqual(response.status, 200)
        script = await response.text()
        self.assertIn("Get llama.cpp", script)
        self.assertIn("Add models", script)
        self.assertIn("Scan a folder of GGUFs", script)
        self.assertIn("Locations ·", script)
        self.assertIn("Forget all locations", script)
        self.assertIn("Forget runtime", script)
        self.assertNotIn("Test / start selected model", script)

        response = await self.client.get("/scripts/standalone_shell.js")
        self.assertEqual(response.status, 200)
        shell = await response.text()
        self.assertIn("enterStandaloneFullscreen", shell)
        self.assertIn("keepComfyActionInactive", shell)

        response = await self.client.get("/h3studio/models")
        payload = await response.json()
        self.assertGreater(len(payload["setup"]), 0)
        self.assertTrue(all(item.get("model_url") for item in payload["setup"]))


class ManagedGGUFTest(unittest.TestCase):
    @staticmethod
    def qwen38_policy_resolver(_architecture, _name, _values):
        class Policy:
            id = "qwen38-27b"
            reasoning_effort = "low"
        return Policy()

    def test_metadata_classification_does_not_use_filenames(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "mmproj-is-just-a-name.gguf"
            projector = root / "vision-without-special-name.gguf"
            unknown = root / "mystery.gguf"
            shard = root / "weights-part-two.gguf"
            for path in (model, projector, unknown, shard):
                path.touch()

            metadata = {
                model.name: {"architecture": "qwen35", "values": {}, "template_controls": {}},
                projector.name: {
                    "architecture": "clip",
                    "projector_type": "qwen3vl_merger",
                    "has_vision_encoder": True,
                    "values": {},
                    "template_controls": {},
                },
                shard.name: {
                    "architecture": "qwen35",
                    "values": {"split.count": 2, "split.no": 1},
                    "template_controls": {},
                },
            }

            def reader(path: Path) -> dict[str, object]:
                if path.name == unknown.name:
                    raise ValueError("unreadable fixture")
                return metadata[path.name]

            controller = ManagedGGUFController(
                package_root=root / "package",
                initial_roots=(root,),
                metadata_reader=reader,
                file_classifier=classify_gguf_file,
            )
            kinds = {Path(item["path"]).name: item["kind"] for item in controller.discover()["files"]}
            self.assertEqual(kinds[model.name], "model")
            self.assertEqual(kinds[projector.name], "projector")
            self.assertEqual(kinds[unknown.name], "unknown")
            self.assertEqual(kinds[shard.name], "shard")
            self.assertEqual({Path(item["id"]).name for item in controller.catalog()[0]}, {model.name, unknown.name})

    def test_direct_file_selection_normalizes_server_and_pairs_vision_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            runtime = root / "runtime"
            runtime.mkdir()
            executable = runtime / "llama-server.exe"
            executable.touch()
            model = root / "Qwen3.8-27B-UD-Q4_K_XL.gguf"
            other_model = root / "Qwen3.8-27B-UD-Q5_K_XL.gguf"
            projector = root / "vision-with-an-arbitrary-name.gguf"
            model.touch()
            other_model.touch()
            projector.touch()

            model_paths = {model.resolve(), other_model.resolve()}

            def reader(path: Path) -> dict[str, object]:
                if path.resolve() in model_paths:
                    return {
                        "architecture": "qwen35",
                        "name": "Qwen3.8-27B",
                        "values": {"tokenizer.chat_template": "reasoning_effort in ('xhigh', 'medium', 'low')"},
                        "template_controls": {"enable_thinking": True, "reasoning_effort": True},
                    }
                return {
                    "architecture": "clip",
                    "name": "Qwen3.8-27B",
                    "projector_type": "qwen3vl_merger",
                    "has_vision_encoder": True,
                    "values": {},
                    "template_controls": {},
                }

            controller = ManagedGGUFController(
                package_root=package,
                initial_roots=(),
                metadata_reader=reader,
                policy_resolver=self.qwen38_policy_resolver,
            )
            config = controller.update_config({"server_path": str(runtime), "selected_model": str(model)})
            self.assertEqual(config["server_path"], str(executable.resolve()))
            self.assertEqual(config["selected_projector"], str(projector.resolve()))
            self.assertIn(str(root.resolve()), config["model_roots"])
            selected = controller.find_model(str(model))
            self.assertEqual(selected["name"], model.stem)
            self.assertEqual(selected["metadata_name"], "Qwen3.8-27B")
            other = controller.find_model(str(other_model))
            self.assertEqual(other["projector"], str(projector.resolve()))
            self.assertEqual(selected["recommended_context"], "extended")
            self.assertEqual(selected["reasoning_effort"], "low")

    def test_reasoning_effort_requires_template_support(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "model.gguf"
            model.touch()

            controller = ManagedGGUFController(
                package_root=root / "package",
                initial_roots=(root,),
                metadata_reader=lambda _path: {
                    "architecture": "qwen35",
                    "name": "Qwen3.8-27B",
                    "values": {"tokenizer.chat_template": "{{ reasoning_effort }} ('xhigh', 'medium', 'low')"},
                    "template_controls": {"enable_thinking": True, "reasoning_effort": False},
                },
                policy_resolver=self.qwen38_policy_resolver,
            )
            selected = controller.find_model(str(model))
            self.assertEqual(selected["recommended_context"], "standard")
            self.assertEqual(
                selected["template_controls"],
                {"enable_thinking": True, "reasoning_effort": False},
            )

    def test_modified_provenance_can_use_low_only_when_template_advertises_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "modified-model.gguf"
            model.touch()

            controller = ManagedGGUFController(
                package_root=root / "package",
                initial_roots=(root,),
                metadata_reader=lambda _path: {
                    "architecture": "qwen35",
                    "name": "Modified model",
                    "values": {"tokenizer.chat_template": "reasoning_effort in ('xhigh', 'medium', 'low')"},
                    "template_controls": {"enable_thinking": True, "reasoning_effort": True},
                },
                policy_resolver=lambda *_args: None,
            )
            selected = controller.find_model(str(model))
            self.assertIsNone(selected["model_policy"])
            self.assertEqual(selected["recommended_context"], "extended")
            self.assertEqual(
                selected["template_controls"],
                {"enable_thinking": True, "reasoning_effort": True},
            )
            self.assertEqual(selected["reasoning_effort"], "low")

    def test_managed_chat_passes_template_confirmed_low_reasoning(self) -> None:
        class Transport:
            payload = None

            def _request_chat_completion_stream(self, _endpoint, payload):
                self.payload = payload
                return {"choices": []}

        transport = Transport()
        handler = _ManagedChatHandler(
            transport,
            "http://127.0.0.1:1",
            "managed",
            {
                "model_policy": None,
                "reasoning_effort": "low",
                "architecture_adapter": "qwen35",
                "template_controls": {"enable_thinking": True, "reasoning_effort": True},
            },
            lambda _model, *, thinking, fallback: fallback,
            lambda _model, *, thinking: {"enable_thinking": thinking},
        )
        handler(
            messages=[], temperature=1.0, top_p=.95, top_k=64,
            max_tokens=128, seed=None, enable_thinking=True,
        )
        self.assertEqual(
            transport.payload["chat_template_kwargs"],
            {"enable_thinking": True, "reasoning_effort": "low"},
        )
        self.assertEqual(transport.payload["reasoning_format"], "deepseek-legacy")

    def test_standalone_managed_adapter_owns_reasoning_controls(self) -> None:
        class Upstream:
            reasoning_managed_by_server = True

        backend_class = standalone_external_backend_class(
            Upstream,
            lambda _model, *, thinking, fallback: fallback,
            lambda _model, *, thinking: {"enable_thinking": thinking},
            ModelError,
            lambda text: len(text),
        )

        self.assertFalse(backend_class.reasoning_managed_by_server)

    def test_managed_local_server_restores_its_own_generation_budget(self) -> None:
        class Runtime:
            started = None

            def start(self, **options):
                self.started = options
                return {"endpoint": "http://127.0.0.1:8080"}

            def stop(self):
                return {"stopped": True}

            def status(self):
                return {"running": True}

        class Controller:
            def __init__(self, binary):
                self.binary = binary
                self.runtime = Runtime()

            def config(self):
                return {"server_path": str(self.binary)}

        class External:
            def probe_model(self, _config):
                return {"id": "managed", "server_context_tokens": 16_384}

            def preflight(self, *_args, **_kwargs):
                return {
                    "estimated_input_tokens": 1_000,
                    "max_output_tokens": None,
                    "reserved_output_tokens": 512,
                    "thinking_budget_reduced": False,
                }

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "llama-server.exe"
            model_path = root / "model.gguf"
            binary.touch()
            model_path.touch()
            controller = Controller(binary)
            backend = ManagedGGUFBackend(
                controller,
                External(),
                ModelError,
                {"standard": 16_384},
            )
            model = {
                "id": str(model_path),
                "path": str(model_path),
                "projector": None,
                "recommended_context": "standard",
                "context_profiles": ["standard"],
                "reasoning_effort_values": ["low"],
                "reasoning_effort": "low",
            }
            assembled = {"input": {"mode": "T2VA"}, "messages": [], "media_inputs": []}

            automatic = backend.preflight(
                model,
                assembled,
                context_profile="auto",
                kv_cache="auto",
                thinking=False,
            )
            self.assertEqual(automatic["max_output_tokens"], 2_048)
            self.assertFalse(automatic["output_tokens_managed_by_server"])

            manual = backend.preflight(
                model,
                assembled,
                context_profile="standard",
                kv_cache="q8",
                thinking=True,
                generation_budget=4_096,
                reasoning_effort="low",
            )
            self.assertEqual(manual["max_output_tokens"], 4_096)
            self.assertTrue(manual["generation_budget_manual"])
            self.assertEqual(manual["reasoning_effort"], "low")
            self.assertEqual(controller.runtime.started["kv_cache"], "q8")

    def test_managed_diagnostics_never_report_python_runtime_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            controller = ManagedGGUFController(
                package_root=Path(temporary),
                initial_roots=(),
                metadata_reader=lambda _path: {},
            )
            diagnostics = managed_runtime_diagnostics(controller)
            self.assertEqual(diagnostics["status"], "ok")
            self.assertEqual(diagnostics["onboarding"]["state"], "ready")

    def test_discovery_caches_metadata_until_file_changes_or_refreshes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "model.gguf"
            model.write_bytes(b"one")
            reads = 0

            def reader(_path: Path) -> dict[str, object]:
                nonlocal reads
                reads += 1
                return {"architecture": "qwen35", "values": {}, "template_controls": {}}

            controller = ManagedGGUFController(
                package_root=root / "package",
                initial_roots=(root,),
                metadata_reader=reader,
            )
            controller.discover()
            controller.discover()
            self.assertEqual(reads, 1)
            controller.discover(refresh=True)
            self.assertEqual(reads, 1)
            model.write_bytes(b"two-two")
            controller.discover(refresh=True)
            self.assertEqual(reads, 2)

    def test_forgotten_locations_stay_forgotten_and_can_be_added_again(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            models = root / "models"
            models.mkdir()
            model = models / "model.gguf"
            model.touch()

            def make_controller() -> ManagedGGUFController:
                return ManagedGGUFController(
                    package_root=package,
                    initial_roots=(models,),
                    metadata_reader=lambda _path: {
                        "architecture": "qwen35",
                        "values": {},
                        "template_controls": {},
                    },
                )

            controller = make_controller()
            controller.update_config({"selected_model": str(model)})
            removed = controller.remove_root(str(models))
            self.assertEqual(removed["model_roots"], [])
            self.assertEqual(removed["selected_model"], "")

            restarted = make_controller()
            self.assertEqual(restarted.config()["model_roots"], [])
            self.assertEqual(restarted.discover()["files"], [])

            restored = restarted.add_root(str(models))
            self.assertEqual(restored["model_roots"], [str(models.resolve())])
            self.assertEqual(len(restarted.discover()["files"]), 1)

    def test_forget_all_locations_clears_model_pair_but_keeps_runtime_choice(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            models = root / "models"
            models.mkdir()
            model = models / "model.gguf"
            model.touch()
            runtime = root / "llama-server.exe"
            runtime.touch()
            controller = ManagedGGUFController(
                package_root=package,
                initial_roots=(models,),
                metadata_reader=lambda _path: {
                    "architecture": "qwen35",
                    "values": {},
                    "template_controls": {},
                },
            )
            controller.update_config({"server_path": str(runtime), "selected_model": str(model)})
            cleared = controller.clear_roots()
            self.assertEqual(cleared["model_roots"], [])
            self.assertEqual(cleared["selected_model"], "")
            self.assertEqual(cleared["selected_projector"], "")
            self.assertEqual(cleared["server_path"], str(runtime.resolve()))

    def test_managed_server_lifecycle_with_fake_server(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "model.gguf"
            projector = root / "projector-with-any-name.gguf"
            model.touch()
            projector.touch()
            server = ManagedLlamaServer(
                root / "server.log",
                readiness_timeout=10,
                script_launcher=sys.executable,
            )
            fixture = Path(__file__).with_name("fake_llama_server.py")
            started = server.start(
                binary=fixture,
                model=model,
                projector=projector,
                context_tokens=8192,
                kv_cache="q8",
            )
            self.assertTrue(started["running"])
            self.assertTrue(started["endpoint"].startswith("http://127.0.0.1:"))
            reused = server.start(
                binary=fixture,
                model=model,
                projector=projector,
                context_tokens=8192,
                kv_cache="q8",
            )
            self.assertTrue(reused["reused"])
            self.assertTrue(server.stop()["stopped"])
            self.assertFalse(server.status()["running"])
            # Windows can release an inherited redirected-file handle a moment
            # after the process handle is signalled, even though wait() returned.
            time.sleep(0.2)


if __name__ == "__main__":
    unittest.main()
