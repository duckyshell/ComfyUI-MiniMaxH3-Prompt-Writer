from __future__ import annotations

import json
import sys
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


class _FakeRoutes:
    def get(self, _path):
        return lambda function: function

    post = get
    delete = get


sys.modules.setdefault(
    "server",
    types.SimpleNamespace(
        PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=_FakeRoutes()))
    ),
)

from backend import routes  # noqa: E402


class _Request:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def _settings(chunks=2, chunk_seconds=5):
    return {
        "schema_version": 2,
        "chunks": chunks,
        "chunk_seconds": float(chunk_seconds),
        "total_seconds": chunks * float(chunk_seconds),
    }


def _plan(chunks=2, *, preamble="Stable identity, wardrobe, location, camera language, lighting, and room tone persist."):
    return {
        "schema_version": 2,
        "global": {
            "sequence_preamble": preamble,
            "continuity_anchors": "Same subject, place, wardrobe, camera axis, light, and room tone.",
            "persistent_constraints": "Preserve the requested continuity and exclusions.",
            "subject_anchors": [],
        },
        "chunks": [
            {
                "continuity": "initial" if index == 1 else "continuous",
                "transition": "",
                "start_state": f"Start {index}.",
                "action": f"Action {index}.",
                "end_state": f"End {index}.",
            }
            for index in range(1, chunks + 1)
        ],
    }


class ContinuumRouteTests(unittest.IsolatedAsyncioTestCase):
    session_id = "11111111-2222-4333-8444-555555555555"

    def setUp(self):
        routes.STATE.update({
            "phase": "idle",
            "active_request_id": None,
            "selected_model_id": None,
            "selected_model_family": None,
            "cancel_requested": False,
            "pending_unload_family": None,
            "pending_unload_model_id": None,
            "pending_unload_endpoint": None,
            "sequence_chunk_index": None,
            "sequence_chunk_total": None,
        })

    def tearDown(self):
        routes._release_generation_request(routes.STATE.get("active_request_id") or "")

    def body(self, chunks=2, chunk_seconds=5):
        return {
            "session_id": self.session_id,
            "mode": "T2VA",
            "generation_target": "continuum",
            "continuum": {"schema_version": 2, "chunks": chunks, "chunk_seconds": chunk_seconds},
            "duration_seconds": chunk_seconds,
            "aspect_ratio": "16:9",
            "creative_brief": "A continuous walk through one room.",
            "downstream_reference_inventory": {"schema_version": 1, "items": []},
            "model_id": "test-model",
            "seed": 10,
            "unload_after": True,
        }

    @staticmethod
    def payload(response):
        return json.loads(response.body.decode("utf-8"))

    async def run_sequence(self, stage_results, *, chunks=2, chunk_seconds=5, cancelled=False):
        body = self.body(chunks, chunk_seconds)
        assembled = {
            "input": {
                "media_manifest": {"assets": []},
                "downstream_reference_inventory": {"schema_version": 1, "items": []},
            }
        }
        model = {"id": "test-model", "name": "Test", "family": "test", "format": "test"}
        backend = MagicMock(externally_managed=False)
        stage = AsyncMock(side_effect=stage_results)
        chunk_assembled = {
            "input": {
                "mode": "T2VA",
                "generation_target": "continuum",
                "media_manifest": {"assets": []},
                "continuum_plan": _plan(chunks),
            },
        }
        with (
            patch.object(routes, "_prepare_generation_runtime", new_callable=AsyncMock, return_value=(model, backend, {"context_profile": "standard", "kv_cache": "q8"})),
            patch.object(routes, "_run_generation_stage", stage),
            patch.object(routes, "_preflight_sequence_stage", new_callable=AsyncMock, return_value={"context_profile": "standard", "kv_cache": "q8"}),
            patch.object(routes, "assemble_continuum_chunk_request", return_value=chunk_assembled),
            patch.object(routes, "_request_cancelled", return_value=cancelled),
            patch.object(routes, "write_event"),
            patch.object(routes.PeakVRAMMonitor, "start"),
            patch.object(routes.PeakVRAMMonitor, "stop", return_value=0),
        ):
            response = await routes._generate_continuum(body, assembled, _settings(chunks, chunk_seconds))
        return response, stage, backend

    async def test_generate_returns_400_for_continuum_mode_topology_preflight(self):
        error = routes.ContinuumError(
            "CONTINUUM_MODE_TOPOLOGY_MISMATCH",
            "The selected mode does not match the V3.4 conditioning topology.",
            {"mode": "T2VA"},
        )
        with patch.object(routes, "assemble_continuum_plan_request", side_effect=error):
            response = await routes.generate(_Request(self.body()))
        self.assertEqual(response.status, 400)
        self.assertEqual(
            self.payload(response)["error"]["code"],
            "CONTINUUM_MODE_TOPOLOGY_MISMATCH",
        )

    async def test_refine_returns_400_for_saved_continuum_source_drift_preflight(self):
        body = self.body()
        body.update({
            "current_prompt": "[0-5s]\nOne.\n\n[5-10s]\nTwo.",
            "instruction": "Slow Chunk 2.",
        })
        error = routes.ContinuumError(
            "CONTINUUM_REFERENCE_SOURCE_DRIFT",
            "The selected V3.4 conditioning sources changed.",
            {"saved_inventory": {}, "active_inventory": {}},
        )
        with patch.object(routes, "assemble_continuum_refinement", side_effect=error):
            response = await routes.refine(_Request(body))
        self.assertEqual(response.status, 400)
        self.assertEqual(
            self.payload(response)["error"]["code"],
            "CONTINUUM_REFERENCE_SOURCE_DRIFT",
        )

    async def test_sequence_calls_planner_then_chunks_and_returns_canonical_timeline(self):
        response, stage, _backend = await self.run_sequence([
            {"prompt": json.dumps(_plan()), "output_tokens": 10, "generation_seconds": 1},
            {"prompt": "Complete H3 prompt one.", "output_tokens": 20, "generation_seconds": 2},
            {"prompt": "Complete H3 prompt two.", "output_tokens": 30, "generation_seconds": 3},
        ])
        self.assertEqual(response.status, 200)
        payload = self.payload(response)
        self.assertEqual(payload["generation_target"], "continuum")
        self.assertEqual(
            payload["prompt"],
            "Stable identity, wardrobe, location, camera language, lighting, and room tone persist.\n\n"
            "[0-5s]\nComplete H3 prompt one.\n\n"
            "[5-10s]\nComplete H3 prompt two.",
        )
        self.assertEqual(payload["sequence"]["preamble"], _plan()["global"]["sequence_preamble"])
        self.assertEqual(payload["sequence"]["chunks"][0]["resolved_prompt"], (
            _plan()["global"]["sequence_preamble"] + "\n\nComplete H3 prompt one."
        ))
        self.assertEqual(payload["sequence_request_count"], 3)
        self.assertEqual(payload["output_tokens"], 60)
        self.assertEqual([call.kwargs["unload_after"] for call in stage.await_args_list], [False, False, True])
        self.assertEqual(
            [call.kwargs["seed"] for call in stage.await_args_list],
            [10, routes._sequence_seed(10, 1), routes._sequence_seed(10, 2)],
        )
        self.assertIsNone(routes.STATE["active_request_id"])

    async def test_fractional_duration_serializes_exact_boundaries(self):
        response, _stage, _backend = await self.run_sequence([
            {"prompt": json.dumps(_plan(3))},
            {"prompt": "One."},
            {"prompt": "Two."},
            {"prompt": "Three."},
        ], chunks=3, chunk_seconds=6.5)
        self.assertEqual(response.status, 200)
        prompt = self.payload(response)["prompt"]
        self.assertIn("[0-6.5s]\nOne.", prompt)
        self.assertIn("[6.5-13s]\nTwo.", prompt)
        self.assertIn("[13-19.5s]\nThree.", prompt)

    async def test_empty_internal_planning_fields_do_not_trigger_repair(self):
        planned = _plan()
        planned["global"]["continuity_anchors"] = ""
        planned["global"]["persistent_constraints"] = ""
        response, stage, _backend = await self.run_sequence([
            {"prompt": json.dumps(planned)},
            {"prompt": "Prompt one."},
            {"prompt": "Prompt two."},
        ])
        self.assertEqual(response.status, 200)
        payload = self.payload(response)
        self.assertFalse(payload["planner_repair_attempted"])
        self.assertFalse(payload["planner_contract_recovery_applied"])
        self.assertEqual(payload["sequence"]["plan"]["global"]["continuity_anchors"], "")
        self.assertEqual(payload["sequence"]["plan"]["global"]["persistent_constraints"], "")
        self.assertEqual(stage.await_count, 3)

    async def test_malformed_plan_gets_exactly_one_narrow_repair(self):
        response, stage, _backend = await self.run_sequence([
            {"prompt": "not json"},
            {"prompt": json.dumps(_plan())},
            {"prompt": "Prompt one."},
            {"prompt": "Prompt two."},
        ])
        self.assertEqual(response.status, 200)
        self.assertTrue(self.payload(response)["planner_repair_attempted"])
        self.assertEqual(stage.await_count, 4)
        self.assertEqual(
            [call.kwargs["unload_after"] for call in stage.await_args_list],
            [False, False, False, True],
        )

    async def test_non_json_initial_then_empty_preamble_repair_recovers_without_third_model_call(self):
        repaired = _plan()
        repaired["global"]["sequence_preamble"] = ""
        repaired["global"]["continuity_anchors"] = "Same subject, room, wardrobe, camera axis, light, and room tone."
        repaired["global"]["persistent_constraints"] = "Preserve the requested continuity and exclusions."

        response, stage, _backend = await self.run_sequence([
            {"prompt": "not json at all"},
            {"prompt": json.dumps(repaired)},
            {"prompt": "Prompt one."},
            {"prompt": "Prompt two."},
        ])
        self.assertEqual(response.status, 200)
        payload = self.payload(response)
        self.assertTrue(payload["planner_repair_attempted"])
        self.assertTrue(payload["planner_contract_recovery_applied"])
        self.assertIn("synthesized_sequence_preamble", payload["planner_contract_recovery_actions"])
        self.assertEqual(stage.await_count, 4)
        self.assertIn(
            "Same subject, room, wardrobe, camera axis, light, and room tone.",
            payload["sequence"]["preamble"],
        )

    async def test_wrapped_valid_initial_plan_is_recovered_without_spending_llm_repair(self):
        wrapped = "Planner result follows:\n" + json.dumps(_plan()) + "\nEnd planner result."
        response, stage, _backend = await self.run_sequence([
            {"prompt": wrapped},
            {"prompt": "Prompt one."},
            {"prompt": "Prompt two."},
        ])
        self.assertEqual(response.status, 200)
        payload = self.payload(response)
        self.assertFalse(payload["planner_repair_attempted"])
        self.assertTrue(payload["planner_contract_recovery_applied"])
        self.assertEqual(payload["planner_contract_recovery_actions"], ["extracted_embedded_json"])
        self.assertEqual(stage.await_count, 3)

    async def test_llm_repair_survives_alphabetic_subject_aliases(self):
        repaired = _plan()
        repaired["global"]["subject_anchors"] = [
            {"id": "<Subject A>", "meaning": "<Subject A> is the same courier throughout."}
        ]
        repaired["global"]["sequence_preamble"] += " Keep <Subject A> visually stable."
        repaired["chunks"][0]["start_state"] = "<Subject A> begins by the door."
        repaired["chunks"][1]["action"] = "<Subject A> crosses the room."

        response, stage, _backend = await self.run_sequence([
            {"prompt": "not json"},
            {"prompt": json.dumps(repaired)},
            {"prompt": "Prompt one."},
            {"prompt": "Prompt two."},
        ])
        self.assertEqual(response.status, 200)
        payload = self.payload(response)
        self.assertTrue(payload["planner_repair_attempted"])
        self.assertFalse(payload["planner_contract_recovery_applied"])
        self.assertEqual(stage.await_count, 4)
        normalized = payload["sequence"]["plan"]
        self.assertEqual(
            normalized["global"]["subject_anchors"],
            [{"id": "<Subject 1>", "meaning": "<Subject 1> is the same courier throughout."}],
        )
        self.assertNotIn("<Subject A>", json.dumps(normalized))
        self.assertIn("<Subject 1>", normalized["global"]["sequence_preamble"])
        self.assertIn("<Subject 1>", normalized["chunks"][1]["action"])

    async def test_chunk_failure_reports_its_index_and_unloads_the_acquired_runtime(self):
        unload = AsyncMock()
        body = self.body(3)
        assembled = {"input": {"media_manifest": {"assets": []}}}
        model = {"id": "test-model", "name": "Test", "family": "test", "format": "test"}
        backend = MagicMock(externally_managed=False)
        stage = AsyncMock(side_effect=[
            {"prompt": json.dumps(_plan(3))},
            {"prompt": "Prompt one."},
            {"prompt": "[5-10s]\nNested reserved header."},
        ])
        chunk_assembled = {
            "input": {
                "mode": "T2VA",
                "generation_target": "continuum",
                "media_manifest": {"assets": []},
                "continuum_plan": _plan(3),
            },
        }
        with (
            patch.object(routes, "_prepare_generation_runtime", new_callable=AsyncMock, return_value=(model, backend, {"context_profile": "standard", "kv_cache": "q8"})),
            patch.object(routes, "_run_generation_stage", stage),
            patch.object(routes, "_preflight_sequence_stage", new_callable=AsyncMock, return_value={}),
            patch.object(routes, "assemble_continuum_chunk_request", return_value=chunk_assembled),
            patch.object(routes, "_unload_failed_sequence", unload),
            patch.object(routes, "write_event"),
            patch.object(routes.PeakVRAMMonitor, "start"),
            patch.object(routes.PeakVRAMMonitor, "stop", return_value=0),
        ):
            response = await routes._generate_continuum(body, assembled, _settings(3))
        self.assertEqual(response.status, 502)
        error = self.payload(response)["error"]
        self.assertEqual(error["code"], "INVALID_CONTINUUM_CHUNK_FORMAT")
        self.assertIn("Chunk 2", error["message"])
        self.assertEqual(error["details"]["chunk_index"], 2)
        unload.assert_awaited_once_with(backend, model, body)

    async def test_pending_cancellation_stops_before_the_first_chunk(self):
        unload = AsyncMock()
        body = self.body()
        assembled = {"input": {"media_manifest": {"assets": []}}}
        model = {"id": "test-model", "name": "Test", "family": "test", "format": "test"}
        backend = MagicMock(externally_managed=False)
        stage = AsyncMock(return_value={"prompt": json.dumps(_plan())})
        with (
            patch.object(routes, "_prepare_generation_runtime", new_callable=AsyncMock, return_value=(model, backend, {"context_profile": "standard", "kv_cache": "q8"})),
            patch.object(routes, "_run_generation_stage", stage),
            patch.object(routes, "_request_cancelled", return_value=True),
            patch.object(routes, "_unload_failed_sequence", unload),
            patch.object(routes, "write_event"),
            patch.object(routes.PeakVRAMMonitor, "start"),
            patch.object(routes.PeakVRAMMonitor, "stop", return_value=0),
        ):
            response = await routes._generate_continuum(body, assembled, _settings())
        self.assertEqual(response.status, 499)
        self.assertEqual(self.payload(response)["error"]["code"], "GENERATION_CANCELLED")
        self.assertEqual(stage.await_count, 1)
        unload.assert_awaited_once_with(backend, model, body)

    async def test_backend_failure_during_a_chunk_is_annotated_with_the_chunk_index(self):
        failure = routes.ModelError("API_RATE_LIMITED", "Quota window exhausted.", {"retry_after": 30})
        response, stage, _backend = await self.run_sequence([
            {"prompt": json.dumps(_plan())},
            {"prompt": "Prompt one."},
            failure,
        ])
        self.assertEqual(response.status, 429)
        error = self.payload(response)["error"]
        self.assertEqual(error["code"], "API_RATE_LIMITED")
        self.assertIn("Chunk 2", error["message"])
        self.assertEqual(error["details"], {"chunk_index": 2, "cause": {"retry_after": 30}})
        self.assertEqual(stage.await_count, 3)

    async def test_invalid_native_bounds_stop_before_sequence_generation(self):
        body = self.body()
        body["continuum"]["chunks"] = 17
        with patch.object(routes, "_generate_continuum", new_callable=AsyncMock) as sequence:
            response = await routes.generate(_Request(body))
        self.assertEqual(response.status, 400)
        self.assertEqual(self.payload(response)["error"]["code"], "INVALID_CONTINUUM_CHUNKS")
        sequence.assert_not_awaited()

    async def test_continuum_refine_route_preserves_preamble_and_untouched_chunks(self):
        preamble = _plan()["global"]["sequence_preamble"]
        body = self.body()
        body["current_prompt"] = (
            preamble + "\n\n[0-5s]\nPrompt one.\n\n[5-10s]\nPrompt two."
        )
        body["instruction"] = "Tighten the second chunk without changing the first."
        body["continuum"]["plan"] = _plan()
        body["continuum"]["chunk_index"] = 2
        assembled = {
            "input": {
                "mode": "T2VA",
                "generation_target": "continuum",
                "continuum": _settings(),
                "continuum_plan": _plan(),
                "media_manifest": {"assets": []},
            }
        }
        sequence_state = {"preamble": preamble, "prompts": ["Prompt one.", "Prompt two."]}
        model = {"id": "test-model", "name": "Test", "family": "test", "format": "test"}
        backend = MagicMock(externally_managed=False)
        with (
            patch.object(
                routes,
                "assemble_continuum_refinement",
                return_value=(assembled, sequence_state, 2, _plan()),
            ),
            patch.object(
                routes,
                "_prepare_generation_runtime",
                new_callable=AsyncMock,
                return_value=(model, backend, {"context_profile": "standard", "kv_cache": "q8"}),
            ),
            patch.object(
                routes,
                "_run_thread_worker",
                new_callable=AsyncMock,
                return_value=({"prompt": "Refined prompt two."}, None),
            ),
            patch.object(routes, "write_event"),
            patch.object(routes.PeakVRAMMonitor, "start"),
            patch.object(routes.PeakVRAMMonitor, "stop", return_value=0),
        ):
            response = await routes.refine(_Request(body))

        self.assertEqual(response.status, 200)
        payload = self.payload(response)
        self.assertEqual(payload["generation_target"], "continuum")
        self.assertEqual(payload["chunk_index"], 2)
        self.assertEqual(payload["chunk_prompt"], "Refined prompt two.")
        self.assertEqual(
            payload["prompt"],
            preamble + "\n\n[0-5s]\nPrompt one.\n\n[5-10s]\nRefined prompt two.",
        )
        self.assertEqual(
            [item["body"] for item in payload["sequence"]["chunks"]],
            ["Prompt one.", "Refined prompt two."],
        )

    async def test_continuum_refine_route_annotates_backend_failure_with_chunk(self):
        body = self.body()
        body["current_prompt"] = "Global.\n\n[0-5s]\nPrompt one.\n\n[5-10s]\nPrompt two."
        body["instruction"] = "Tighten the second chunk."
        body["continuum"]["plan"] = _plan(preamble="Global.")
        body["continuum"]["chunk_index"] = 2
        assembled = {
            "input": {
                "mode": "T2VA",
                "generation_target": "continuum",
                "continuum": _settings(),
                "continuum_plan": _plan(preamble="Global."),
                "media_manifest": {"assets": []},
            }
        }
        model = {"id": "test-model", "name": "Test", "family": "test", "format": "test"}
        backend = MagicMock(externally_managed=False)
        failure = routes.ModelError("API_RATE_LIMITED", "Quota window exhausted.", {"retry_after": 30})
        with (
            patch.object(
                routes,
                "assemble_continuum_refinement",
                return_value=(assembled, {"preamble": "Global.", "prompts": ["Prompt one.", "Prompt two."]}, 2, _plan(preamble="Global.")),
            ),
            patch.object(
                routes,
                "_prepare_generation_runtime",
                new_callable=AsyncMock,
                return_value=(model, backend, {"context_profile": "standard", "kv_cache": "q8"}),
            ),
            patch.object(routes, "_run_thread_worker", new_callable=AsyncMock, side_effect=failure),
            patch.object(routes, "write_event"),
            patch.object(routes.PeakVRAMMonitor, "start"),
            patch.object(routes.PeakVRAMMonitor, "stop", return_value=0),
        ):
            response = await routes.refine(_Request(body))

        self.assertEqual(response.status, 429)
        error = self.payload(response)["error"]
        self.assertEqual(error["code"], "API_RATE_LIMITED")
        self.assertIn("Continuum refinement failed at Chunk 2", error["message"])
        self.assertEqual(error["details"], {"chunk_index": 2, "cause": {"retry_after": 30}})


class ContinuumMetricsTests(unittest.TestCase):
    def test_model_output_continuum_errors_map_to_bad_gateway(self):
        for code in (
            "EMPTY_CONTINUUM_CHUNK",
            "INVALID_CONTINUUM_SEQUENCE",
            "CONTINUUM_REFERENCE_IDENTITY_DRIFT",
            "CONTINUUM_REFERENCE_SCOPE_DRIFT",
            "CONTINUUM_SUBJECT_IDENTITY_DRIFT",
        ):
            with self.subTest(code=code):
                self.assertEqual(routes._model_error_status(routes.ModelError(code, "bad model output")), 502)

    def test_saved_conditioning_source_drift_is_a_request_error_not_bad_gateway(self):
        self.assertEqual(
            routes._model_error_status(
                routes.ModelError(
                    "CONTINUUM_REFERENCE_SOURCE_DRIFT",
                    "saved workflow conditioning changed",
                )
            ),
            400,
        )

    def test_final_provider_counters_are_kept_while_stage_tokens_are_summed(self):
        metrics = routes._aggregate_sequence_metrics([
            {"output_tokens": 10, "generation_seconds": 1, "provider_request_count": 1},
            {"output_tokens": 20, "generation_seconds": 2, "provider_request_count": 2},
            {"output_tokens": 30, "generation_seconds": 3, "provider_request_count": 3, "provider_request_ids": ["one", "two", "three"]},
        ])
        self.assertEqual(metrics["sequence_request_count"], 3)
        self.assertEqual(metrics["output_tokens"], 60)
        self.assertEqual(metrics["provider_request_count"], 3)
        self.assertEqual(metrics["provider_request_ids"], ["one", "two", "three"])


if __name__ == "__main__":
    unittest.main()
