"""One backend lease and one immutable model/media snapshot per Sequence operation."""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import sys
from aiohttp import web

from .assembly import AssemblyError
from .media import MediaError
from .models.contract import ModelError
from .h3_pipeline import validate_media_capabilities
from .sequence import validate_sequence, snapshot_media, assemble_chunk, timeline, plain_chunk_prompt, normalize_local_timestamps
from .sequence_plan import assemble_plan, parse_plan
from .sequence_repair import assemble_repair, attention_message, preserve_content

ACTIVE_OPERATIONS = {}


async def run_sequence(body, services, emit):
    state = validate_sequence(body)
    targets = [i for i,c in enumerate(state["chunks"]) if body["action"] == "all" or ((not c["prompt"].strip() or c.get("attention")) if body["action"] == "missing" else c["id"] == body["chunk_id"])]
    if not targets:
        return
    if body["action"] in {"all", "missing"}:
        # Replaced prompts are not accepted neighbors in this operation's working copy.
        for index in targets:
            state["chunks"][index]["prompt"] = ""
    request_id = services._claim_generation_request()
    if request_id is None:
        raise ModelError("GENERATION_BUSY", "Another Writer operation is still running.")
    backend = model = None
    current_chunk = None
    raw = None
    delivered = False
    try:
        ACTIVE_OPERATIONS[body.get("operation_id")] = (request_id, body["session_id"])
        await emit({"type": "started"})
        # The shared generation lease excludes media mutation while bytes are copied.
        media = snapshot_media(state, body["session_id"])
        assembled = [assemble_chunk(state, i, body, media) for i in targets]
        planning_request = assemble_plan(state, body, targets, timeline(state)) if len(state["chunks"]) > 1 else None
        # Keep the selected runtime stable; the pipeline checks each actual input
        # again after the schedule and newly accepted predecessors are available.
        if planning_request is not None:
            await emit({"type": "phase", "phase": "planning"})
            assembled.append(planning_request)
        representative = max(assembled, key=lambda a: sum(len(m["content"]) for m in a["messages"]) + len(a["media_inputs"]) * 2000)
        model, backend, plan = await services._prepare_generation_runtime(body, representative, request_id)
        model = copy.deepcopy(model)
        for item in assembled:
            validate_media_capabilities(model, item)
        async def generate(item):
            result, cancellation = await services._run_thread_worker(
                backend.generate, model, item, body["session_id"], on_cancel=backend.cancel,
                thinking=body.get("thinking", False), seed=body.get("seed"), unload_after=False,
                context_profile=body.get("context_profile", "auto"), kv_cache=body.get("kv_cache", "auto"), runtime_plan=plan,
                on_phase=lambda phase: services._set_request_phase(request_id, phase))
            services._propagate_worker_cancellation(cancellation)
            if services._request_cancelled(request_id):
                raise ModelError("GENERATION_CANCELLED", "Sequence cancelled.")
            return result

        action_plan = None
        if planning_request is not None:
            if services._request_cancelled(request_id):
                raise ModelError("GENERATION_CANCELLED", "Sequence cancelled.")
            result = await generate(planning_request)
            steps = parse_plan(result.get("prompt") if isinstance(result, dict) else None, len(targets), [i + 1 for i in targets])
            action_plan = dict(zip(targets, steps))
            if result.get("lifecycle_warning"):
                await emit({"type": "warning", "message": result["lifecycle_warning"]})
        for index in targets:
            if services._request_cancelled(request_id):
                raise ModelError("GENERATION_CANCELLED", "Sequence cancelled.")
            raw = None
            delivered = False
            current_chunk = {"chunk_id": state["chunks"][index]["id"], "chunk_index": index + 1}
            item = assemble_chunk(state, index, body, media, action_plan)
            await emit({"type": "phase", "phase": "generating", **current_chunk})
            result = await generate(item)
            if not isinstance(result, dict) or not isinstance(result.get("prompt"), str) or not result["prompt"].strip():
                raise ModelError("EMPTY_GENERATION", "No completed chunk was returned.")
            raw = result["prompt"]
            original_prompt = raw
            repaired = False
            failure = None
            for attempt in range(2):
                await emit({"type": "phase", "phase": "checking", **current_chunk})
                try:
                    prompt = plain_chunk_prompt(raw, item["input"]["mode"], item["input"]["duration_seconds"], item["input"]["media_manifest"]["assets"], item["input"].get("output_format", "official"))
                    if repaired:
                        preserve_content(normalize_local_timestamps(original_prompt, item["input"]["duration_seconds"]), prompt, item["input"]["mode"], item["input"].get("output_format", "official"))
                    failure = None
                    break
                except ModelError as error:
                    failure = error
                    if attempt or not isinstance(error.details, dict) or not error.details.get("repairable"):
                        break
                    await emit({"type": "phase", "phase": "repairing", **current_chunk})
                    if services._request_cancelled(request_id):
                        raise ModelError("GENERATION_CANCELLED", "Sequence cancelled.")
                    repaired = True
                    result = await generate(assemble_repair(item, raw, error))
                    if not isinstance(result, dict) or not isinstance(result.get("prompt"), str) or not result["prompt"].strip():
                        raise ModelError("EMPTY_GENERATION", "The model returned no completed repair.")
                    raw = result["prompt"]
            if failure:
                await emit({"type": "chunk", **current_chunk, "prompt": raw,
                            "attention": attention_message(failure, item), "repair": "failed" if repaired else "not_attempted"})
                return
            if not prompt.strip():
                raise ModelError("EMPTY_GENERATION", "No completed chunk was returned.")
            state["chunks"][index]["prompt"] = prompt
            await emit({"type": "chunk", **current_chunk, "prompt": prompt, "repair": "applied" if repaired else "not_needed"})
            delivered = True
            if result.get("lifecycle_warning"):
                await emit({"type": "warning", "message": result["lifecycle_warning"]})
    except Exception as error:
        if current_chunk and not (isinstance(error, ModelError) and error.code == "GENERATION_CANCELLED"):
            if raw and not delivered:
                await emit({"type": "chunk", **current_chunk, "prompt": raw, "repair": "failed",
                            "attention": "The model's prompt could not be checked or corrected because the request stopped. "
                                         "Its text is kept here. Suggested fix: review it, or Refine / Regenerate this chunk."})
            await emit({"type": "phase", "phase": "failed", **current_chunk})
            details = current_chunk
            if isinstance(error, ModelError) and error.code == "CONTEXT_BUDGET_EXCEEDED" and isinstance(error.details, dict):
                details = {**error.details, **current_chunk}
            raise ModelError(getattr(error, "code", "SEQUENCE_FAILED"),
                             f"Chunk {current_chunk['chunk_index']} failed: {error}", details) from error
        raise
    finally:
        primary_error = sys.exc_info()[1]
        try:
            if backend is not None and body.get("unload_after", True):
                # Provider-specific argument signatures remain infrastructure, not chunk semantics.
                family = model["family"]
                if family == "gguf":
                    await services._run_thread_worker(backend.unload)
                elif family == "ollama":
                    await services._run_thread_worker(backend.unload, model.get("remote_model"), model.get("endpoint"))
                elif family == "external" and model.get("lifecycle_supported"):
                    # Router cancellation already runs its ownership-aware cleanup.
                    owned = any(t["model_id"] == model["id"] and t.get("writer_owned") for t in backend.router.snapshot()["targets"])
                    if owned:
                        await services._run_thread_worker(backend.unload, model["id"])
        except Exception as cleanup_error:
            logging.getLogger(__name__).warning("Sequence runtime cleanup failed: %s", cleanup_error)
            if primary_error is None:
                await emit({"type": "warning", "message": "Sequence completed, but runtime unload was not confirmed."})
            elif isinstance(primary_error, ModelError):
                primary_error.details = {"primary_detail": primary_error.details, "cleanup_warning": str(cleanup_error)}
        finally:
            ACTIVE_OPERATIONS.pop(body.get("operation_id"), None)
            services._release_generation_request(request_id)


def register_sequence_routes(routes, services):
    @routes.post(f"{services.ROUTE_PREFIX}/sequence/cancel")
    async def cancel_sequence(request):
        body = await services._json_body(request)
        operation_id = (body or {}).get("operation_id")
        identity = ACTIVE_OPERATIONS.get(operation_id) if isinstance(operation_id, str) else None
        with services.STATE_LOCK:
            if not identity or identity != (services.STATE["active_request_id"], (body or {}).get("session_id")):
                return web.json_response({"cancelled": False})
            services.STATE["cancel_requested"] = True
            backend = services.BACKENDS.get(services.STATE["selected_model_family"])
            if backend is not None:
                backend.cancel()
        return web.json_response({"cancelled": True})

    @routes.post(f"{services.ROUTE_PREFIX}/sequence")
    async def sequence(request):
        body = await services._json_body(request)
        if body is None:
            return services._error("INVALID_REQUEST", "Expected a JSON object.", status=400)
        try:
            validate_sequence(body)
        except AssemblyError as error:
            return services._error(error.code, error.message, status=400)
        response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson", "Cache-Control": "no-store"})
        await response.prepare(request)
        async def emit(event):
            await response.write((json.dumps({**event, "operation_id": body.get("operation_id")}) + "\n").encode())
        try:
            await run_sequence(body, services, emit)
            await emit({"type": "done"})
        except (ModelError, AssemblyError, MediaError) as error:
            await emit({"type": "error", "code": error.code, "message": str(error), "details": error.details})
        except (ConnectionError, asyncio.CancelledError):
            raise
        except Exception:
            await emit({"type": "error", "code": "SEQUENCE_FAILED", "message": "Sequence stopped because the runtime request failed."})
        await response.write_eof()
        return response
