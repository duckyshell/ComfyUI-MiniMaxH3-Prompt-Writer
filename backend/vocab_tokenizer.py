from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Any


class TokenizerPreflightError(RuntimeError):
    pass


def model_identity(model_path: str | Path) -> tuple[str, int, int]:
    resolved = Path(model_path).resolve(strict=True)
    stat = resolved.stat()
    return str(resolved), stat.st_size, stat.st_mtime_ns


class VocabOnlyTokenizerClient:
    def __init__(
        self,
        model_path: str | Path,
        *,
        worker_path: str | Path | None = None,
        startup_timeout: float = 120.0,
        request_timeout: float = 30.0,
    ) -> None:
        self.identity = model_identity(model_path)
        self.request_timeout = request_timeout
        self._lock = threading.Lock()
        self._messages: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._stderr = deque(maxlen=40)
        self._request_id = 0
        worker = Path(worker_path) if worker_path else Path(__file__).with_name("gguf_tokenizer_worker.py")
        environment = os.environ.copy()
        environment["CUDA_VISIBLE_DEVICES"] = "-1"
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        self.process = subprocess.Popen(
            [sys.executable, str(worker), self.identity[0]],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            env=environment,
            creationflags=creation_flags,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        startup = self._next_message(startup_timeout)
        if startup.get("ready") is not True:
            self.close()
            raise TokenizerPreflightError(startup.get("error") or "The vocab-only tokenizer did not start.")
        self.startup = startup

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        try:
            for line in self.process.stdout:
                try:
                    self._messages.put(json.loads(line))
                except ValueError:
                    self._messages.put({"error": "The tokenizer worker returned invalid JSON."})
        finally:
            self._messages.put(None)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self._stderr.append(line.rstrip())

    def _next_message(self, timeout: float) -> dict[str, Any]:
        try:
            message = self._messages.get(timeout=timeout)
        except queue.Empty as error:
            raise TokenizerPreflightError("The vocab-only tokenizer timed out.") from error
        if message is None:
            detail = "\n".join(self._stderr) or f"worker exited with code {self.process.poll()}"
            raise TokenizerPreflightError(f"The vocab-only tokenizer stopped: {detail}")
        return message

    def count(self, text: str) -> int:
        with self._lock:
            if self.process.poll() is not None:
                raise TokenizerPreflightError("The vocab-only tokenizer is no longer running.")
            self._request_id += 1
            request_id = self._request_id
            assert self.process.stdin is not None
            self.process.stdin.write(json.dumps({
                "operation": "count",
                "id": request_id,
                "text": text,
            }, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
            response = self._next_message(self.request_timeout)
            if response.get("id") != request_id:
                raise TokenizerPreflightError("The vocab-only tokenizer response was out of sequence.")
            count = response.get("count")
            if not isinstance(count, int) or count < 0:
                raise TokenizerPreflightError(response.get("error") or "The vocab-only tokenizer returned no count.")
            return count

    def close(self) -> None:
        process = getattr(self, "process", None)
        if process is None:
            return
        try:
            if process.poll() is None and process.stdin is not None:
                process.stdin.write('{"operation":"shutdown"}\n')
                process.stdin.flush()
            if process.poll() is None:
                process.wait(timeout=2)
        except Exception:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=2)
            except Exception:
                pass
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
