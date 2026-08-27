"""Own one user-supplied llama-server process without bundling a runtime."""

from __future__ import annotations

import atexit
import http.client
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


LOCALHOST = "127.0.0.1"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((LOCALHOST, 0))
        return int(sock.getsockname()[1])


def _health_ready(port: int, timeout: float = 2.0) -> bool:
    connection = http.client.HTTPConnection(LOCALHOST, port, timeout=timeout)
    try:
        connection.request("GET", "/health")
        response = connection.getresponse()
        response.read()
        return response.status == 200
    except (OSError, TimeoutError, http.client.HTTPException):
        return False
    finally:
        connection.close()


class ManagedLlamaServer:
    def __init__(
        self,
        log_path: Path,
        *,
        readiness_timeout: float = 300.0,
        script_launcher: str | None = None,
    ) -> None:
        self.log_path = log_path
        self.readiness_timeout = readiness_timeout
        self.script_launcher = script_launcher
        self._lock = threading.RLock()
        self._process: subprocess.Popen[bytes] | None = None
        self._job: Any = None
        self._log_handle: Any = None
        self._signature: tuple[str, ...] | None = None
        self._endpoint: str | None = None
        self._last_error: str | None = None
        atexit.register(self.stop)

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def status(self) -> dict[str, Any]:
        with self._lock:
            exit_code = None
            if self._process is not None and not self.running:
                exit_code = self._process.poll()
            return {
                "running": self.running,
                "pid": self._process.pid if self.running and self._process else None,
                "endpoint": self._endpoint if self.running else None,
                "log_path": str(self.log_path),
                "last_error": self._last_error,
                "exit_code": exit_code,
            }

    def _close_handles(self) -> None:
        if self._job is not None and sys.platform == "win32":
            from .job_object import close_job

            close_job(self._job)
        self._job = None
        if self._log_handle is not None:
            self._log_handle.close()
        self._log_handle = None

    def _stop_locked(self) -> bool:
        process = self._process
        was_running = bool(process and process.poll() is None)
        if was_running and process is not None:
            process.terminate()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        self._process = None
        self._endpoint = None
        self._signature = None
        self._close_handles()
        return was_running

    def stop(self) -> dict[str, Any]:
        with self._lock:
            return {"stopped": self._stop_locked(), **self.status()}

    def _wait_until_ready(self, port: int) -> None:
        deadline = time.monotonic() + self.readiness_timeout
        while time.monotonic() < deadline:
            process = self._process
            if process is None:
                raise RuntimeError("llama-server ownership was lost during startup.")
            exit_code = process.poll()
            if exit_code is not None:
                raise RuntimeError(
                    f"llama-server exited during startup with code {exit_code}. See {self.log_path}."
                )
            if _health_ready(port):
                return
            time.sleep(0.4)
        raise RuntimeError(
            f"llama-server did not become ready within {self.readiness_timeout:g}s. See {self.log_path}."
        )

    def start(
        self,
        *,
        binary: Path,
        model: Path,
        projector: Path | None,
        context_tokens: int,
        kv_cache: str,
        force_restart: bool = False,
    ) -> dict[str, Any]:
        binary = binary.resolve(strict=True)
        model = model.resolve(strict=True)
        projector = projector.resolve(strict=True) if projector else None
        if not binary.is_file():
            raise FileNotFoundError(f"llama-server was not found: {binary}")
        if model.suffix.lower() != ".gguf":
            raise ValueError("The selected model must be a GGUF file.")
        if projector is not None and projector.suffix.lower() != ".gguf":
            raise ValueError("The selected projector must be a GGUF file.")
        if context_tokens < 1024:
            raise ValueError("Context size must be at least 1024 tokens.")
        if kv_cache not in {"auto", "q8", "f16"}:
            raise ValueError("KV cache must be auto, q8, or f16.")

        signature = (
            str(binary),
            str(model),
            str(projector or ""),
            str(context_tokens),
            kv_cache,
        )
        with self._lock:
            if self.running and signature == self._signature and not force_restart:
                return {**self.status(), "reused": True}
            self._stop_locked()
            port = _free_port()
            command = [
                *([self.script_launcher] if self.script_launcher else []),
                str(binary),
                "--model", str(model),
                "--host", LOCALHOST,
                "--port", str(port),
                "--ctx-size", str(context_tokens),
                "--alias", "h3-managed",
            ]
            if projector is not None:
                command.extend(["--mmproj", str(projector)])
            if kv_cache in {"q8", "f16"}:
                cache_type = "q8_0" if kv_cache == "q8" else "f16"
                command.extend(["--cache-type-k", cache_type, "--cache-type-v", cache_type])

            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_handle = self.log_path.open("ab")
            self._log_handle.write(("\n[standalone] " + subprocess.list2cmdline(command) + "\n").encode("utf-8"))
            self._log_handle.flush()
            options: dict[str, Any] = {
                "cwd": str(binary.parent),
                "stdin": subprocess.DEVNULL,
                "stdout": self._log_handle,
                "stderr": subprocess.STDOUT,
            }
            if sys.platform == "win32":
                options["creationflags"] = subprocess.CREATE_NO_WINDOW
            try:
                self._process = subprocess.Popen(command, **options)
                if sys.platform == "win32":
                    from .job_object import assign_process, create_kill_on_close_job

                    self._job = create_kill_on_close_job()
                    assign_process(self._job, self._process._handle)  # type: ignore[attr-defined]
            except Exception:
                self._stop_locked()
                raise
            self._endpoint = f"http://{LOCALHOST}:{port}"
            self._signature = signature
            self._last_error = None

        try:
            self._wait_until_ready(port)
        except Exception as error:
            with self._lock:
                self._last_error = str(error)
                self._stop_locked()
            raise
        return {**self.status(), "reused": False}
