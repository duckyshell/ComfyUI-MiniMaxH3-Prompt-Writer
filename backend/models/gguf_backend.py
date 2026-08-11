from __future__ import annotations

import gc
import threading
import time
from typing import Any, Callable

from ..context import ContextPlanError, plan_context
from ..h3_pipeline import run_h3_pipeline, validate_media_capabilities
from ..runtime_diagnostics import cached_gguf_runtime_diagnostics
from .contract import ModelError


class GGUFBackend:
    def __init__(self) -> None:
        self.model = None
        self.chat_handler = None
        self.model_id: str | None = None
        self.runtime_signature: tuple[str, int, str] | None = None
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

    def load(self, model_info: dict[str, Any], runtime_plan: dict[str, Any]) -> None:
        signature = (model_info["id"], runtime_plan["context_tokens"], runtime_plan["kv_cache"])
        if self.model is not None and self.runtime_signature == signature:
            return
        if not model_info.get("runtime_ready", True):
            raise ModelError(
                "MODEL_DEPENDENCY_MISSING",
                "The selected GGUF model needs its optional runtime or multimodal projector.",
                {"packages": model_info.get("missing_dependencies", [])},
            )
        self.unload()
        try:
            from llama_cpp import GGML_TYPE_F16, GGML_TYPE_Q8_0, Llama
            from llama_cpp.llama_chat_format import Gemma4ChatHandler

            kv_types = {"q8": GGML_TYPE_Q8_0, "f16": GGML_TYPE_F16}
            kv_type = kv_types[runtime_plan["kv_cache"]]

            self.chat_handler = Gemma4ChatHandler(
                clip_model_path=model_info["projector"],
                verbose=False,
                use_gpu=True,
            )
            self.model = Llama(
                model_path=model_info["path"],
                chat_handler=self.chat_handler,
                n_gpu_layers=-1,
                n_ctx=runtime_plan["context_tokens"],
                n_batch=512,
                flash_attn=True,
                type_k=kv_type,
                type_v=kv_type,
                verbose=False,
            )
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
        if self.model is not None:
            self.model.close()
        if self.chat_handler is not None:
            self.chat_handler._exit_stack.close()
        self.model = None
        self.chat_handler = None
        self.model_id = None
        self.runtime_signature = None
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
            validate_media_capabilities(model_info, assembled)
            try:
                runtime_plan = runtime_plan or self.preflight(
                    model_info,
                    assembled,
                    context_profile=context_profile,
                    kv_cache=kv_cache,
                    thinking=thinking,
                )
                signature = (model_info["id"], runtime_plan["context_tokens"], runtime_plan["kv_cache"])
                cold_start = self.model is None or self.runtime_signature != signature
                if on_phase:
                    on_phase("loading_model")
                load_started = time.perf_counter()
                self.load(model_info, runtime_plan)
                load_seconds = time.perf_counter() - load_started
                if self.cancel_event.is_set():
                    raise ModelError("GENERATION_CANCELLED", "Generation was cancelled after model loading.")

                def stop_if_cancelled(_input_ids, scores):
                    if self.cancel_event.is_set():
                        raise ModelError("GENERATION_CANCELLED", "Generation was cancelled.")
                    return scores

                logits_processors = self._logits_processors(stop_if_cancelled)

                def complete(
                    *,
                    messages: list[dict[str, Any]],
                    temperature: float,
                    top_p: float,
                    top_k: int,
                    max_tokens: int,
                    seed: int | None,
                    thinking: bool,
                ) -> dict[str, Any]:
                    return self.chat_handler(
                        llama=self.model,
                        messages=messages,
                        temperature=temperature,
                        top_p=top_p,
                        top_k=top_k,
                        max_tokens=max_tokens,
                        seed=seed,
                        logits_processor=logits_processors,
                        enable_thinking=thinking,
                    )

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
                    on_phase=on_phase,
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
            except ModelError:
                raise
            except MemoryError as error:
                raise ModelError("GENERATION_OOM", "GGUF generation ran out of memory.") from error
            except Exception as error:
                raise ModelError("GENERATION_FAILED", "The GGUF model could not generate a prompt.", str(error)) from error
            finally:
                force_unload = self.force_unload_event.is_set()
                if unload_after or force_unload:
                    self.unload()
                self.force_unload_event.clear()


BACKEND = GGUFBackend()
