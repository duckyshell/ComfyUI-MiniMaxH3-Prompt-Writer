from __future__ import annotations

import argparse
import asyncio
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

from aiohttp import web

from . import __version__ as STANDALONE_VERSION
from .config import PACKAGE_ROOT, Settings, load_settings, validate_upstream


LOCALHOST = "127.0.0.1"
MAX_REQUEST_BYTES = 1024 * 1024 * 1024 + 16 * 1024 * 1024
SETTINGS_KEY = web.AppKey("settings", Settings)
VERSION_KEY = web.AppKey("upstream_version", str)
MANAGED_CONTROLLER_KEY = web.AppKey("managed_gguf_controller", object)
MANAGED_BACKEND_KEY = web.AppKey("managed_gguf_backend", object)


def _prepare_environment(settings: Settings) -> None:
    validate_upstream(settings.upstream_repo)
    local_models = PACKAGE_ROOT / "models"
    local_models.mkdir(parents=True, exist_ok=True)
    temp_root = PACKAGE_ROOT / "data" / "tmp"
    temp_root.mkdir(parents=True, exist_ok=True)

    roots = [local_models, *settings.model_roots]
    os.environ["H3_STANDALONE_MODEL_ROOTS"] = os.pathsep.join(str(path) for path in roots)
    os.environ["H3_STANDALONE_TEMP"] = str(temp_root)

    compat_dir = Path(__file__).resolve().parent / "compat"
    for path in (settings.upstream_repo, compat_dir):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)

    # The upstream imports these exact ComfyUI module names.
    import folder_paths  # noqa: F401, PLC0415
    import server  # noqa: F401, PLC0415


def create_app(settings: Settings) -> web.Application:
    _prepare_environment(settings)

    from backend import routes as upstream_routes  # noqa: PLC0415
    from backend.context import CONTEXT_PROFILES, estimate_text_tokens  # noqa: PLC0415
    from backend.gguf_metadata import read_gguf_metadata  # noqa: PLC0415
    from backend.models.contract import ModelError  # noqa: PLC0415
    from backend.models.external_server_backend import ExternalServerBackend  # noqa: PLC0415
    from backend.models.gguf_policies import (  # noqa: PLC0415
        identify_model_policy,
        sampling_options,
        template_kwargs,
    )
    from backend.version import VERSION  # noqa: PLC0415
    from .external_backend import standalone_external_backend_class  # noqa: PLC0415
    from .managed_gguf import (  # noqa: PLC0415
        ManagedGGUFBackend,
        ManagedGGUFController,
        managed_runtime_diagnostics,
    )

    local_models = PACKAGE_ROOT / "models"
    controller = ManagedGGUFController(
        package_root=PACKAGE_ROOT,
        initial_roots=(local_models, *settings.model_roots),
        metadata_reader=read_gguf_metadata,
        policy_resolver=identify_model_policy,
    )
    managed_external_class = standalone_external_backend_class(
        ExternalServerBackend,
        sampling_options,
        template_kwargs,
        ModelError,
        estimate_text_tokens,
    )
    managed_backend = ManagedGGUFBackend(
        controller,
        managed_external_class(),
        ModelError,
        CONTEXT_PROFILES,
    )

    # A narrow standalone seam: keep upstream request/pipeline behavior and replace
    # only Direct GGUF discovery, diagnostics, and execution.
    upstream_routes.discover_models_with_diagnostics = controller.catalog
    upstream_routes.find_model = controller.find_model
    upstream_routes.get_gguf_runtime_diagnostics = lambda *args, **kwargs: managed_runtime_diagnostics(
        controller, *args, **kwargs
    )
    upstream_routes.GGUF_BACKEND = managed_backend
    upstream_routes.BACKENDS["gguf"] = managed_backend

    app = web.Application(client_max_size=MAX_REQUEST_BYTES)
    app[SETTINGS_KEY] = settings
    app[VERSION_KEY] = VERSION
    app[MANAGED_CONTROLLER_KEY] = controller
    app[MANAGED_BACKEND_KEY] = managed_backend
    app.add_routes(upstream_routes.routes)

    web_root = settings.upstream_repo / "web"
    static_root = Path(__file__).resolve().parent / "static"
    index_path = PACKAGE_ROOT / "ui" / "index.html"

    async def index(_request: web.Request) -> web.FileResponse:
        return web.FileResponse(index_path)

    def error_response(error: Exception, *, status: int = 400) -> web.Response:
        return web.json_response(
            {"error": {"code": "STANDALONE_GGUF_ERROR", "message": str(error)}},
            status=status,
        )

    async def managed_state(request: web.Request) -> web.Response:
        refresh = request.query.get("refresh", "").strip().lower() in {"1", "true", "yes"}
        return web.json_response(controller.state(refresh=refresh))

    async def managed_config(request: web.Request) -> web.Response:
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object.")
            return web.json_response({"config": controller.update_config(body)})
        except (ValueError, OSError) as error:
            return error_response(error)

    async def add_model_root(request: web.Request) -> web.Response:
        try:
            body = await request.json()
            return web.json_response({"config": controller.add_root(str(body.get("path") or ""))})
        except (AttributeError, ValueError, OSError) as error:
            return error_response(error)

    async def remove_model_root(request: web.Request) -> web.Response:
        try:
            body = await request.json()
            return web.json_response({"config": controller.remove_root(str(body.get("path") or ""))})
        except (AttributeError, ValueError, OSError) as error:
            return error_response(error)

    async def clear_model_roots(_request: web.Request) -> web.Response:
        try:
            return web.json_response({"config": controller.clear_roots()})
        except OSError as error:
            return error_response(error)

    async def browse_path(request: web.Request) -> web.Response:
        try:
            body = await request.json()
            kind = str(body.get("kind") or "")
            if kind not in {"server", "model", "folder", "projector"}:
                raise ValueError("Browse kind must be server, model, folder, or projector.")
            selected = await asyncio.to_thread(_native_path_dialog, kind)
            return web.json_response({"path": selected})
        except (RuntimeError, ValueError, OSError) as error:
            return error_response(error)

    async def start_managed(request: web.Request) -> web.Response:
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object.")
            controller.update_config({
                key: body[key]
                for key in ("server_path", "selected_model", "selected_projector")
                if key in body
            })
            model = controller.find_model(controller.config()["selected_model"])
            if model is None:
                raise ValueError("Select a model GGUF from one of the configured folders.")
            managed_backend.prepare_request()
            plan = await asyncio.to_thread(
                managed_backend.preflight,
                model,
                {"messages": [{"content": "Managed runtime readiness check."}], "media_inputs": []},
                context_profile=str(body.get("context_profile") or "auto"),
                kv_cache=str(body.get("kv_cache") or "auto"),
                thinking=False,
            )
            return web.json_response({"runtime": controller.runtime.status(), "runtime_plan": plan})
        except ModelError as error:
            return web.json_response(
                {"error": {"code": error.code, "message": error.message, "details": error.details}},
                status=400,
            )
        except (ValueError, OSError) as error:
            return error_response(error)

    async def stop_managed(_request: web.Request) -> web.Response:
        await asyncio.to_thread(managed_backend.unload)
        return web.json_response({"runtime": controller.runtime.status()})

    async def free_vram(_request: web.Request) -> web.Response:
        await asyncio.to_thread(managed_backend.unload)
        return web.json_response({"ok": True, "standalone": True})

    async def health(_request: web.Request) -> web.Response:
        return web.json_response(
            {
                "ok": True,
                "version": STANDALONE_VERSION,
                "standalone_version": STANDALONE_VERSION,
                "core_version": VERSION,
                "upstream_repo": str(settings.upstream_repo),
                "model_roots": [str(path) for path in settings.model_roots],
                "managed_llama_server": controller.runtime.status(),
            }
        )

    async def cleanup(_app: web.Application) -> None:
        await asyncio.to_thread(managed_backend.unload)

    app.router.add_get("/", index)
    app.router.add_get("/healthz", health)
    app.router.add_get("/standalone/gguf/state", managed_state)
    app.router.add_post("/standalone/gguf/config", managed_config)
    app.router.add_post("/standalone/gguf/roots/add", add_model_root)
    app.router.add_post("/standalone/gguf/roots/remove", remove_model_root)
    app.router.add_post("/standalone/gguf/roots/clear", clear_model_roots)
    app.router.add_post("/standalone/gguf/browse", browse_path)
    app.router.add_post("/standalone/gguf/start", start_managed)
    app.router.add_post("/standalone/gguf/stop", stop_managed)
    app.router.add_post("/free", free_vram)
    app.router.add_static("/scripts/", static_root)
    app.router.add_static("/", web_root)
    app.on_cleanup.append(cleanup)
    return app


def _native_path_dialog(kind: str) -> str | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as error:
        raise RuntimeError("This Python installation has no native file-dialog support. Enter the path manually.") from error
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        if kind == "folder":
            value = filedialog.askdirectory(title="Select a folder containing GGUF files")
        elif kind == "server":
            value = filedialog.askopenfilename(
                title="Select llama-server.exe",
                filetypes=[("llama-server", "llama-server.exe"), ("Executables", "*.exe"), ("All files", "*.*")],
            )
        elif kind == "model":
            value = filedialog.askopenfilename(
                title="Select a model GGUF",
                filetypes=[("GGUF files", "*.gguf"), ("All files", "*.*")],
            )
        else:
            value = filedialog.askopenfilename(
                title="Select a vision projector GGUF",
                filetypes=[("GGUF files", "*.gguf"), ("All files", "*.*")],
            )
        return str(Path(value).resolve()) if value else None
    finally:
        root.destroy()


def _pick_port(preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((LOCALHOST, preferred))
            return sock.getsockname()[1]
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((LOCALHOST, 0))
        return sock.getsockname()[1]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run H3 Prompt Writer without ComfyUI.")
    parser.add_argument("--upstream", help="Path to the Prompt Writer repository.")
    parser.add_argument("--model-root", action="append", default=[], help="Additional GGUF folder; repeatable.")
    parser.add_argument("--port", type=int, help="Preferred localhost port. Uses another free port if occupied.")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser automatically.")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    settings = load_settings(
        upstream_override=args.upstream,
        model_root_overrides=args.model_root,
        port_override=args.port,
        no_browser=args.no_browser,
    )
    try:
        app = create_app(settings)
    except FileNotFoundError as error:
        raise SystemExit(f"Configuration error: {error}") from error

    port = _pick_port(settings.port)
    url = f"http://{LOCALHOST}:{port}/"
    print(f"H3 Prompt Writer Standalone {STANDALONE_VERSION}")
    print(f"Core:     {app[VERSION_KEY]}")
    print(f"Upstream: {settings.upstream_repo}")
    print(f"Serving:  {url}")
    print("Stop with Ctrl+C.")
    if settings.open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    web.run_app(app, host=LOCALHOST, port=port, print=None)


if __name__ == "__main__":
    main()
