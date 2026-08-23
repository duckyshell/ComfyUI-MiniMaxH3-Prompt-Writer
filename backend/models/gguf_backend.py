from __future__ import annotations

import ctypes
import gc
import sys
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable

from ..context import ContextPlanError, plan_context
from ..h3_pipeline import run_h3_pipeline, validate_media_capabilities
from ..runtime_diagnostics import cached_gguf_runtime_diagnostics
from .contract import ModelError
from .gguf_policies import sampling_options, template_kwargs


CONSOLE_PREFIX = "[H3 Prompt Writer]"
_MTMD_LOG_CALLBACK = None
_MTMD_LOG_LOCK = threading.Lock()
_MTMD_LAST_LOG_LEVEL = 0
_MTMD_QUIET_REQUESTS = 0
_MTMD_WARNING_LEVEL = 3
_MTMD_ERROR_LEVEL = 4
_MTMD_CONTINUE_LEVEL = 5


def _write_console(message: str) -> None:
    print(f"{CONSOLE_PREFIX} {message}", file=sys.stderr, flush=True)


def _configure_mtmd_logging(mtmd_cpp: Any) -> None:
    """Keep native MTMD warnings and errors without exposing INFO prompt dumps."""
    global _MTMD_LOG_CALLBACK
    global _MTMD_LAST_LOG_LEVEL

    with _MTMD_LOG_LOCK:
        if _MTMD_LOG_CALLBACK is None:
            from llama_cpp import llama_log_callback

            @llama_log_callback
            def mtmd_log_callback(level, text, _user_data):
                global _MTMD_LAST_LOG_LEVEL
                try:
                    decoded = text.decode("utf-8", errors="replace") if text else ""
                    with _MTMD_LOG_LOCK:
                        previous_level = _MTMD_LAST_LOG_LEVEL
                        if level != _MTMD_CONTINUE_LEVEL:
                            _MTMD_LAST_LOG_LEVEL = level
                        quiet = _MTMD_QUIET_REQUESTS > 0
                    if not quiet:
                        print(decoded, end="", file=sys.stderr, flush=True)
                        return
                    effective_level = previous_level if level == _MTMD_CONTINUE_LEVEL else level
                    if effective_level not in {_MTMD_WARNING_LEVEL, _MTMD_ERROR_LEVEL}:
                        return
                    if level == _MTMD_CONTINUE_LEVEL:
                        print(decoded, end="", file=sys.stderr, flush=True)
                        return
                    label = "Warning" if effective_level == _MTMD_WARNING_LEVEL else "Error"
                    print(
                        f"{CONSOLE_PREFIX} MTMD {label.lower()}: {decoded}",
                        end="" if decoded.endswith("\n") else "\n",
                        file=sys.stderr,
                        flush=True,
                    )
                except Exception:
                    return

            _MTMD_LOG_CALLBACK = mtmd_log_callback
        callback = _MTMD_LOG_CALLBACK

    for setter_name in ("mtmd_log_set", "mtmd_helper_log_set"):
        setter = getattr(mtmd_cpp, setter_name, None)
        if callable(setter):
            setter(callback, ctypes.c_void_p())


@contextmanager
def _quiet_mtmd_info():
    global _MTMD_QUIET_REQUESTS
    with _MTMD_LOG_LOCK:
        _MTMD_QUIET_REQUESTS += 1
    try:
        yield
    finally:
        with _MTMD_LOG_LOCK:
            _MTMD_QUIET_REQUESTS = max(0, _MTMD_QUIET_REQUESTS - 1)


def _short_value(value: Any, fallback: str) -> str:
    text = " ".join(str(value or fallback).split())
    return text[:120]


def _context_label(tokens: int) -> str:
    return f"{tokens // 1024}K" if tokens > 0 and tokens % 1024 == 0 else str(tokens)


def _visual_reference_label(assembled: dict[str, Any]) -> str | None:
    count = sum(
        item.get("type") in {"image", "video"}
        for item in assembled.get("media_inputs", [])
    )
    if count == 0:
        return None
    noun = "visual reference" if count == 1 else "visual references"
    return f"{count} {noun}"


def _cancel_to_eos(cancel_event: threading.Event, eos_token: int) -> Callable[..., Any]:
    def processor(_input_ids, scores):
        if cancel_event.is_set():
            scores[:] = float("-inf")
            scores[eos_token] = 0.0
        return scores

    return processor


class GGUFBackend:
    def __init__(self) -> None:
        self.model = None
        self.chat_handler = None
        self.model_id: str | None = None
        self.runtime_signature: tuple[str, int, str, str] | None = None
        self.cancel_event = threading.Event()
        self.force_unload_event = threading.Event()
        self.lock = threading.RLock()

    def status(self) -> dict[str, Any]:
        return {
            "loaded_model_id": self.model_id,
            "loaded": self.model is not None,
            "loaded_context_tokens": self.runtime_signature[1] if self.runtime_signature else None,
            "loaded_kv_cache": self.runtime_signature[2] if self.runtime_signature else None,
        }

    def cancel(self) -> bool:
        self.cancel_event.set()
        return True

    def prepare_request(self) -> None:
        self.cancel_event.clear()

    def request_unload(self) -> bool:
        self.force_unload_event.set()
        self.cancel_event.set()
        return True

    def _logits_processors(self, stop_if_cancelled: Callable[..., Any]) -> Any:
        from llama_cpp import LogitsProcessorList

        return LogitsProcessorList([stop_if_cancelled])

    def _console(self, message: str) -> None:
        _write_console(message)

    def _console_error(self, error: ModelError, runtime_plan: dict[str, Any] | None) -> None:
        if error.code == "GENERATION_CANCELLED":
            self._console("Generation cancelled")
        elif error.code == "GENERATION_TRUNCATED":
            details = error.details if isinstance(error.details, dict) else {}
            limit = details.get("max_output_tokens") or (runtime_plan or {}).get("max_output_tokens")
            suffix = f" · {limit} tokens" if limit else ""
            self._console(f"Error: output limit reached{suffix}")
        elif error.code in {"MODEL_LOAD_OOM", "GENERATION_OOM"}:
            stage = "loading the model" if error.code == "MODEL_LOAD_OOM" else "generating"
            self._console(f"Error: out of VRAM while {stage}")
        elif error.code == "MODEL_LOAD_FAILED":
            self._console("Error: model failed to load")
        else:
            safe_messages = {
                "EMPTY_GENERATION": "model returned an empty prompt",
                "GENERATION_FAILED": "generation failed",
                "MODEL_DEPENDENCY_MISSING": "Direct GGUF runtime is unavailable",
                "DIRECT_THINKING_UNAVAILABLE": "model template has no Thinking control",
                "THINKING_TRUNCATED": "Thinking ended before the final prompt",
            }
            message = safe_messages.get(error.code, f"request failed · {error.code}")
            self._console(f"Error: {message}")

    def preflight(
        self,
        model_info: dict[str, Any],
        assembled: dict[str, Any],
        *,
        context_profile: str | None,
        kv_cache: str | None,
        thinking: bool,
    ) -> dict[str, Any]:
        try:
            return plan_context(
                assembled,
                model_info,
                requested_context=context_profile,
                requested_kv_cache=kv_cache,
                thinking=thinking,
            )
        except ContextPlanError as error:
            raise ModelError(error.code, error.message, error.details) from error

    def load(
        self,
        model_info: dict[str, Any],
        runtime_plan: dict[str, Any],
        *,
        text_only: bool = False,
    ) -> None:
        runtime_kind = "text" if text_only else "multimodal"
        signature = (model_info["id"], runtime_plan["context_tokens"], runtime_plan["kv_cache"], runtime_kind)
        if self.model is not None and self.runtime_signature == signature:
            return
        if not model_info.get("runtime_ready", True):
            raise ModelError(
                "MODEL_DEPENDENCY_MISSING",
                "The selected GGUF model is not ready for Direct inference.",
                {"packages": model_info.get("missing_dependencies", [])},
            )
        self.unload()
        try:
            from llama_cpp import Llama
            try:
                from llama_cpp import GGML_TYPE_F16, GGML_TYPE_Q8_0
            except ImportError:
                from llama_cpp._ggml import GGMLType
                GGML_TYPE_F16 = GGMLType.GGML_TYPE_F16.value
                GGML_TYPE_Q8_0 = GGMLType.GGML_TYPE_Q8_0.value

            kv_types = {"q8": GGML_TYPE_Q8_0, "f16": GGML_TYPE_F16}
            kv_type = kv_types[runtime_plan["kv_cache"]]
            llama_options = {
                "model_path": model_info["path"],
                "n_gpu_layers": -1,
                "n_ctx": runtime_plan["context_tokens"],
                "n_batch": 512,
                "flash_attn": True,
                "type_k": kv_type,
                "type_v": kv_type,
                "verbose": False,
            }
            if not text_only:
                from llama_cpp.llama_chat_format import MTMDChatHandler

                self.chat_handler = MTMDChatHandler(
                    clip_model_path=model_info["projector"],
                    verbose=False,
                    use_gpu=True,
                )
                mtmd_cpp = getattr(self.chat_handler, "_mtmd_cpp", None)
                if mtmd_cpp is not None:
                    _configure_mtmd_logging(mtmd_cpp)
                llama_options["chat_handler"] = self.chat_handler
            self.model = Llama(**llama_options)
            self.model_id = model_info["id"]
            self.runtime_signature = signature
        except MemoryError as error:
            self.unload()
            raise ModelError("MODEL_LOAD_OOM", "The GGUF model did not fit in available memory.") from error
        except Exception as error:
            self.unload()
            details: dict[str, Any] = {"exception": str(error)}
            runtime = cached_gguf_runtime_diagnostics()
            if runtime is not None:
                details["runtime"] = runtime
            raise ModelError("MODEL_LOAD_FAILED", "The GGUF model could not be loaded.", details) from error

    def unload(self) -> None:
        model = self.model
        chat_handler = self.chat_handler
        self.model = None
        self.chat_handler = None
        self.model_id = None
        self.runtime_signature = None

        if model is not None:
            try:
                model.close()
            except Exception:
                self._console("Warning: model cleanup did not complete")
        if chat_handler is not None:
            try:
                exit_stack = getattr(chat_handler, "_exit_stack", None)
                if exit_stack is not None:
                    exit_stack.close()
            except Exception:
                self._console("Warning: vision handler cleanup did not complete")
        gc.collect()

    def generate(
        self,
        model_info: dict[str, Any],
        assembled: dict[str, Any],
        session_id: str,
        *,
        thinking: bool,
        seed: int | None,
        unload_after: bool,
        context_profile: str | None = None,
        kv_cache: str | None = None,
        runtime_plan: dict[str, Any] | None = None,
        on_phase: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            if thinking and model_info.get("thinking") is not True:
                raise ModelError(
                    "DIRECT_THINKING_UNAVAILABLE",
                    "This Direct GGUF chat template does not expose Thinking controls.",
                )
            validate_media_capabilities(model_info, assembled)
            try:
                runtime_plan = runtime_plan or self.preflight(
                    model_info,
                    assembled,
                    context_profile=context_profile,
                    kv_cache=kv_cache,
                    thinking=thinking,
                )
                text_only = (
                    assembled.get("input", {}).get("mode") == "Music3"
                    or model_info.get("capabilities", {}).get("images") is False
                )
                runtime_kind = "text" if text_only else "multimodal"
                signature = (model_info["id"], runtime_plan["context_tokens"], runtime_plan["kv_cache"], runtime_kind)
                cold_start = self.model is None or self.runtime_signature != signature
                model_name = _short_value(model_info.get("name"), model_info["id"])
                context = _context_label(runtime_plan["context_tokens"])
                kv_label = str(runtime_plan["kv_cache"]).upper()
                if cold_start:
                    self._console(f"Direct GGUF · {model_name}")
                    self._console("Loading model...")
                else:
                    self._console(
                        f"Direct GGUF · {model_name} · model already loaded · context {context} · KV {kv_label}"
                    )
                if on_phase:
                    on_phase("loading_model")
                load_started = time.perf_counter()
                self.load(model_info, runtime_plan, text_only=text_only)
                load_seconds = time.perf_counter() - load_started
                if cold_start:
                    self._console(f"Loaded in {load_seconds:.1f}s · context {context} · KV {kv_label}")
                if self.cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Generation was cancelled after model loading.")

                logits_processors = self._logits_processors(
                    _cancel_to_eos(self.cancel_event, self.model.token_eos())
                )
                media_started: float | None = None
                visual_references = _visual_reference_label(assembled)

                def direct_phase(phase: str) -> None:
                    nonlocal media_started
                    if phase == "processing_media":
                        media_started = time.perf_counter()
                    elif phase == "generating":
                        if visual_references and media_started is not None:
                            elapsed = time.perf_counter() - media_started
                            self._console(f"Prepared {visual_references} in {elapsed:.1f}s")
                        thinking_label = "on" if thinking else "off"
                        self._console(
                            f"Generating · Thinking {thinking_label} · max output {runtime_plan['max_output_tokens']}"
                        )
                    if on_phase:
                        on_phase(phase)

                def complete(
                    *,
                    messages: list[dict[str, Any]],
                    temperature: float,
                    top_p: float,
                    top_k: int,
                    max_tokens: int,
                    seed: int | None,
                    thinking: bool,
                    purpose: str,
                ) -> dict[str, Any]:
                    fallback_sampling = {
                        "temperature": temperature,
                        "top_p": top_p,
                        "top_k": top_k,
                    }
                    sampling = (
                        sampling_options(model_info, thinking=thinking, fallback=fallback_sampling)
                        if purpose == "generation"
                        else fallback_sampling
                    )
                    options = {
                        "messages": messages,
                        **sampling,
                        "max_tokens": max_tokens,
                        "seed": seed,
                        "logits_processor": logits_processors,
                    }
                    chat_template_options = template_kwargs(model_info, thinking=thinking)
                    if text_only:
                        if chat_template_options:
                            base_chat_handler = (
                                getattr(self.model, "chat_handler", None)
                                or getattr(self.model, "_chat_handlers", {}).get(self.model.chat_format)
                            )
                            if base_chat_handler is None:
                                from llama_cpp.llama_chat_format import get_chat_completion_handler

                                base_chat_handler = get_chat_completion_handler(self.model.chat_format)
                            response = base_chat_handler(
                                llama=self.model,
                                **options,
                                **chat_template_options,
                            )
                        else:
                            response = self.model.create_chat_completion(**options)
                    else:
                        self.chat_handler.verbose = False
                        with _quiet_mtmd_info():
                            response = self.chat_handler(
                                llama=self.model,
                                **options,
                                **chat_template_options,
                            )
                    if self.cancel_event.is_set():
                        raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.")
                    return response

                result = run_h3_pipeline(
                    model_info,
                    assembled,
                    session_id,
                    runtime_plan,
                    complete=complete,
                    count_text_tokens=lambda text: len(self.model.tokenize(text.encode("utf-8"), add_bos=True)),
                    is_cancelled=self.cancel_event.is_set,
                    thinking=thinking,
                    seed=seed,
                    on_phase=direct_phase,
                )
                if result.get("format_repair_attempted"):
                    if result.get("format_repair_applied"):
                        self._console(
                            f"Reference correction applied · {int(result.get('format_repair_tokens') or 0)} tokens"
                        )
                    else:
                        failure = _short_value(
                            result.get("format_repair_failure"),
                            "prompt correction did not pass validation",
                        )
                        self._console(f"Warning: prompt correction failed · {failure}")
                output_tokens = int(result.get("output_tokens") or 0)
                tokens_per_second = float(result.get("tokens_per_second") or 0)
                generation_seconds = float(result.get("generation_seconds") or 0)
                self._console(
                    f"Done · {output_tokens} tokens · {tokens_per_second:.1f} tok/s · {generation_seconds:.1f}s"
                )
                return {
                    **result,
                    "cold_start": cold_start,
                    "model_load_seconds": round(load_seconds, 3),
                    "context_profile": runtime_plan["context_profile"],
                    "context_tokens": runtime_plan["context_tokens"],
                    "kv_cache": runtime_plan["kv_cache"],
                    "max_output_tokens": runtime_plan["max_output_tokens"],
                    "thinking_budget_reduced": runtime_plan["thinking_budget_reduced"],
                }
            except ModelError as error:
                self._console_error(error, runtime_plan)
                raise
            except MemoryError as error:
                wrapped = ModelError("GENERATION_OOM", "GGUF generation ran out of memory.")
                self._console_error(wrapped, runtime_plan)
                raise wrapped from error
            except Exception as error:
                wrapped = ModelError("GENERATION_FAILED", "The GGUF model could not generate a prompt.", str(error))
                self._console_error(wrapped, runtime_plan)
                raise wrapped from error
            finally:
                force_unload = self.force_unload_event.is_set()
                if unload_after or force_unload:
                    self.unload()
                self.force_unload_event.clear()


BACKEND = GGUFBackend()
