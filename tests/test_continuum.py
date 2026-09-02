from __future__ import annotations

import copy
import json
import unittest
from unittest.mock import patch

from backend.assembly import AssemblyError
from backend.continuum import (
    CONTINUUM_SCHEMA_VERSION,
    ContinuumError,
    continuum_chunk_format_violations,
    apply_continuum_refinement,
    assemble_continuum_chunk_request,
    assemble_continuum_plan_repair_request,
    assemble_continuum_plan_request,
    assemble_continuum_refinement,
    format_timeline_seconds,
    generation_target,
    parse_chunk_prompts,
    parse_sequence_plan,
    recover_sequence_plan_contract,
    parse_timeline_sequence,
    prompt_hash,
    resolved_chunk_prompt,
    sequence_result,
    serialize_chunk_prompts,
    serialize_timeline,
    validate_continuum_settings,
    validate_continuum_mode_topology,
    validate_generated_chunk,
    validate_saved_downstream_inventory,
    validate_sequence_plan,
    validate_sequence_reference_scope,
)
from backend.references import (
    bind_downstream_reference_inventory,
    effective_reference_tags,
    model_media_labels,
    normalize_downstream_reference_inventory,
    reference_policy,
)


SESSION_ID = "11111111-2222-4333-8444-555555555555"


def manifest(mode="T2VA", assets=None):
    return {
        "session_id": SESSION_ID,
        "mode": mode,
        "assets": list(assets or []),
        "valid": True,
        "violations": [],
    }


def picture(number=1):
    return {
        "id": f"picture-{number}",
        "type": "image",
        "filename": f"picture-{number}.png",
        "reference": f"<Picture {number}>",
        "content_url": f"/picture-{number}",
        "frames": [],
        "prepared_width": 1024,
        "prepared_height": 768,
    }


def video(number=1):
    return {
        "id": f"video-{number}",
        "type": "video",
        "filename": f"video-{number}.mp4",
        "reference": f"<Video {number}>",
        "content_url": f"/video-{number}",
        "frames": [],
        "contact_sheet_width": 1152,
        "contact_sheet_height": 768,
    }


def downstream_inventory(
    pictures=0,
    *,
    first_frame=False,
    last_frame=False,
    video_reference=False,
    reference_audio=False,
    driving_audio=False,
    visible=False,
):
    items = [
        {
            "tag": f"<Picture {index}>",
            "kind": "image",
            "source": "workflow",
            "visible_to_model": visible,
            "role": "reference_image",
            "input_name": f"reference_image_{index}",
            "source_node_id": 100 + index,
            "source_node_class": "LoadImage",
            "source_output_name": "IMAGE",
            "source_slot": 0,
        }
        for index in range(1, pictures + 1)
    ]
    keyframe_index = 0
    for enabled, role, kind, input_name in (
        (first_frame, "first_frame", "image", "first_frame"),
        (last_frame, "last_frame", "image", "last_frame"),
        (video_reference, "video_reference", "video", "reference_video_1"),
        (reference_audio, "reference_audio", "audio", "reference_audio_1"),
        (driving_audio, "driving_audio", "audio", "driving_audio"),
    ):
        if not enabled:
            continue
        tag = None
        if pictures == 0 and role in {"first_frame", "last_frame"}:
            keyframe_index += 1
            tag = f"<Picture {keyframe_index}>"
        elif role == "video_reference":
            tag = "<Video 1>"
        elif role == "reference_audio":
            tag = "<Audio 1>"
        item = {
            "kind": kind,
            "source": "workflow",
            "visible_to_model": False,
            "role": role,
            "input_name": input_name,
            "source_node_id": 900 + len(items),
            "source_node_class": "TestSource",
            "source_output_name": kind.upper(),
            "source_slot": 0,
        }
        if tag:
            item["tag"] = tag
        items.append(item)
    return {"schema_version": 1, "items": items}


def settings(chunks=3, chunk_seconds=5.0):
    return {
        "schema_version": CONTINUUM_SCHEMA_VERSION,
        "chunks": chunks,
        "chunk_seconds": float(chunk_seconds),
        "total_seconds": chunks * float(chunk_seconds),
    }


def plan_v2(chunks=3, *, preamble="Stable cinematic identity, wardrobe, environment, camera language, and room tone persist."):
    return {
        "schema_version": CONTINUUM_SCHEMA_VERSION,
        "global": {
            "sequence_preamble": preamble,
            "continuity_anchors": "Same subject, location, wardrobe, light, camera axis, and room tone.",
            "persistent_constraints": "Preserve identity and requested exclusions throughout.",
            "subject_anchors": [],
        },
        "chunks": [
            {
                "continuity": "initial" if index == 1 else "continuous",
                "transition": "",
                "start_state": f"Start state {index}.",
                "action": f"Action {index}.",
                "end_state": f"End state {index}.",
            }
            for index in range(1, chunks + 1)
        ],
    }


def plan_v1(chunks=3):
    return {
        "schema_version": 1,
        "global": {
            "continuity_anchors": "Same subject and place.",
            "persistent_constraints": "Preserve continuity.",
            "reference_assignments": [],
            "subject_anchors": [],
        },
        "chunks": [
            {
                "index": index,
                "continuity": "initial" if index == 1 else "continuous",
                "transition": "",
                "start_state": f"Start {index}.",
                "action": f"Action {index}.",
                "end_state": f"End {index}.",
            }
            for index in range(1, chunks + 1)
        ],
    }


def body(mode="T2VA", *, chunks=3, chunk_seconds=5, brief="One continuous shot.", inventory=None):
    value = {
        "session_id": SESSION_ID,
        "mode": mode,
        "generation_target": "continuum",
        "continuum": {
            "schema_version": CONTINUUM_SCHEMA_VERSION,
            "chunks": chunks,
            "chunk_seconds": chunk_seconds,
        },
        "duration_seconds": chunk_seconds,
        "aspect_ratio": "16:9",
        "creative_brief": brief,
    }
    value["downstream_reference_inventory"] = (
        downstream_inventory(0) if inventory is None else inventory
    )
    return value


class ContinuumSettingsTests(unittest.TestCase):
    def test_generation_target_defaults_to_single_clip(self):
        self.assertEqual(generation_target({}), "single")
        self.assertEqual(generation_target({"generation_target": "continuum"}), "continuum")

    def test_native_boundary_values_are_valid_and_legacy_settings_migrate(self):
        for schema in (1, CONTINUUM_SCHEMA_VERSION):
            for chunks in (1, 16):
                for seconds in (4, 30):
                    with self.subTest(schema=schema, chunks=chunks, seconds=seconds):
                        value = validate_continuum_settings({
                            "continuum": {
                                "schema_version": schema,
                                "chunks": chunks,
                                "chunk_seconds": seconds,
                            }
                        })
                        self.assertEqual(value["schema_version"], CONTINUUM_SCHEMA_VERSION)
                        self.assertEqual(value["chunks"], chunks)
                        self.assertEqual(value["chunk_seconds"], float(seconds))
                        self.assertEqual(value["total_seconds"], chunks * seconds)

    def test_invalid_native_values_are_rejected(self):
        invalid = (
            {"chunks": 0, "chunk_seconds": 5},
            {"chunks": 17, "chunk_seconds": 5},
            {"chunks": True, "chunk_seconds": 5},
            {"chunks": 3, "chunk_seconds": 3.9},
            {"chunks": 3, "chunk_seconds": 30.1},
            {"chunks": 3, "chunk_seconds": True},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ContinuumError):
                validate_continuum_settings({"continuum": {"schema_version": 2, **value}})

    def test_total_sequence_duration_is_not_limited_to_twenty_seconds(self):
        value = validate_continuum_settings({
            "continuum": {"schema_version": 2, "chunks": 12, "chunk_seconds": 5}
        })
        self.assertEqual(value["total_seconds"], 60)


class DownstreamReferenceInventoryTests(unittest.TestCase):
    def test_reference_images_are_compact_and_keyframes_do_not_own_picture_tags(self):
        value = normalize_downstream_reference_inventory(
            downstream_inventory(
                2,
                first_frame=True,
                last_frame=True,
                video_reference=True,
                driving_audio=True,
            )
        )
        pictures = [item for item in value["items"] if item["role"] == "reference_image"]
        self.assertEqual([item["tag"] for item in pictures], ["<Picture 1>", "<Picture 2>"])
        self.assertEqual(
            [(item["role"], item.get("tag")) for item in value["items"] if item["role"] != "reference_image"],
            [
                ("first_frame", None),
                ("last_frame", None),
                ("video_reference", "<Video 1>"),
                ("driving_audio", None),
            ],
        )

    def test_optional_source_identity_is_preserved_and_must_be_nonempty_text(self):
        value = downstream_inventory(1)
        value["items"][0]["source_identity"] = "image-conveyor-ref-v1:0123456789abcdef"
        normalized = normalize_downstream_reference_inventory(value)
        self.assertEqual(
            normalized["items"][0]["source_identity"],
            "image-conveyor-ref-v1:0123456789abcdef",
        )

        for invalid in ("", "   ", 7):
            broken = downstream_inventory(1)
            broken["items"][0]["source_identity"] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "source_identity"):
                normalize_downstream_reference_inventory(broken)

    def test_saved_inventory_source_identity_upgrades_legacy_and_then_detects_drift(self):
        active = downstream_inventory(1)
        active["items"][0]["source_identity"] = "image-conveyor-ref-v1:1111111111111111"

        legacy = downstream_inventory(1)
        upgraded = validate_saved_downstream_inventory(legacy, active)
        self.assertEqual(
            upgraded["items"][0]["source_identity"],
            "image-conveyor-ref-v1:1111111111111111",
        )

        same = downstream_inventory(1)
        same["items"][0]["source_identity"] = "image-conveyor-ref-v1:1111111111111111"
        self.assertEqual(
            validate_saved_downstream_inventory(same, active)["items"][0]["source_identity"],
            "image-conveyor-ref-v1:1111111111111111",
        )

        changed = downstream_inventory(1)
        changed["items"][0]["source_identity"] = "image-conveyor-ref-v1:2222222222222222"
        with self.assertRaises(ContinuumError) as raised:
            validate_saved_downstream_inventory(changed, active)
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SOURCE_DRIFT")

        no_fingerprint = downstream_inventory(1)
        with self.assertRaises(ContinuumError) as raised:
            validate_saved_downstream_inventory(same, no_fingerprint)
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SOURCE_DRIFT")

    def test_model_visible_source_can_be_rematerialized_under_a_new_temporary_asset_id(self):
        saved = downstream_inventory(1)
        saved["items"][0].update({
            "source_identity": "image-conveyor-ref-v1:1111111111111111",
            "visible_to_model": True,
            "model_asset_id": "old-session-asset",
        })
        active = copy.deepcopy(saved)
        active["items"][0]["model_asset_id"] = "new-session-asset"

        upgraded = validate_saved_downstream_inventory(saved, active)
        self.assertEqual(upgraded["items"][0]["model_asset_id"], "new-session-asset")

        missing = copy.deepcopy(active)
        missing["items"][0]["visible_to_model"] = False
        missing["items"][0].pop("model_asset_id")
        with self.assertRaises(ContinuumError) as raised:
            validate_saved_downstream_inventory(saved, missing)
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SOURCE_DRIFT")

        unfingerprinted_saved = downstream_inventory(1)
        unfingerprinted_saved["items"][0].update({
            "visible_to_model": True,
            "model_asset_id": "old-session-asset",
        })
        unfingerprinted_active = copy.deepcopy(unfingerprinted_saved)
        unfingerprinted_active["items"][0]["model_asset_id"] = "new-session-asset"
        with self.assertRaises(ContinuumError) as raised:
            validate_saved_downstream_inventory(unfingerprinted_saved, unfingerprinted_active)
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SOURCE_DRIFT")

    def test_gapped_public_picture_numbers_are_rejected(self):
        value = downstream_inventory(2)
        value["items"][1]["tag"] = "<Picture 3>"
        with self.assertRaisesRegex(ValueError, "compact public tags"):
            normalize_downstream_reference_inventory(value)

    def test_declared_workflow_pictures_override_unrelated_manifest_picture_numbers(self):
        request_input = {
            "mode": "Reference",
            "generation_target": "continuum",
            "media_manifest": manifest("Reference", [picture(1), video(1)]),
            "downstream_reference_inventory": downstream_inventory(2),
        }
        self.assertEqual(
            effective_reference_tags(request_input, continuum=True),
            {"<Picture 1>", "<Picture 2>"},
        )

    def test_model_visible_binding_requires_explicit_existing_matching_asset(self):
        value = downstream_inventory(1)
        value["items"][0].update({
            "visible_to_model": True,
            "model_asset_id": "picture-1",
        })
        bound = bind_downstream_reference_inventory(
            value,
            manifest("Reference", [picture(1)]),
        )
        self.assertEqual(bound["items"][0]["model_asset_id"], "picture-1")
        self.assertTrue(bound["items"][0]["visible_to_model"])

    def test_visible_flag_without_model_asset_binding_is_rejected(self):
        value = downstream_inventory(1)
        value["items"][0]["visible_to_model"] = True
        with self.assertRaisesRegex(ValueError, "visible_to_model must be true exactly when model_asset_id is set"):
            normalize_downstream_reference_inventory(value)

    def test_missing_wrong_type_and_duplicate_model_asset_bindings_are_rejected(self):
        missing = downstream_inventory(1)
        missing["items"][0].update({"visible_to_model": True, "model_asset_id": "missing"})
        with self.assertRaisesRegex(ValueError, "missing Prompt Writer media asset"):
            bind_downstream_reference_inventory(missing, manifest("Reference", [picture(1)]))

        wrong_type = downstream_inventory(1)
        wrong_type["items"][0].update({"visible_to_model": True, "model_asset_id": "video-1"})
        with self.assertRaisesRegex(ValueError, "requires 'image'"):
            bind_downstream_reference_inventory(wrong_type, manifest("Reference", [video(1)]))

        duplicate = downstream_inventory(2)
        for item in duplicate["items"]:
            item.update({"visible_to_model": True, "model_asset_id": "picture-1"})
        with self.assertRaisesRegex(ValueError, "bound to more than one downstream H3 conditioning input"):
            bind_downstream_reference_inventory(duplicate, manifest("Reference", [picture(1)]))

    def test_unbound_analysis_media_never_inherits_downstream_picture_identity(self):
        labels = model_media_labels(
            manifest("Reference", [picture(1)]),
            downstream_inventory(1),
            mode="Reference",
        )
        self.assertEqual(
            labels["picture-1"],
            "Analysis image 1 (no downstream public reference identity)",
        )

    def test_explicitly_bound_analysis_media_inherits_exact_downstream_picture_identity(self):
        value = downstream_inventory(1)
        value["items"][0].update({
            "visible_to_model": True,
            "model_asset_id": "picture-1",
        })
        bound = bind_downstream_reference_inventory(
            value,
            manifest("Reference", [picture(1)]),
        )
        labels = model_media_labels(
            manifest("Reference", [picture(1)]),
            bound,
            mode="Reference",
        )
        self.assertEqual(labels["picture-1"], "<Picture 1>")

    def test_non_reference_continuum_media_identity_requires_explicit_binding(self):
        inventory = downstream_inventory(0, first_frame=True)
        unbound = model_media_labels(
            manifest("I2VA", [picture(1)]),
            inventory,
            mode="I2VA",
        )
        self.assertEqual(
            unbound["picture-1"],
            "Analysis image 1 (no downstream public reference identity)",
        )

        inventory["items"][0].update({
            "visible_to_model": True,
            "model_asset_id": "picture-1",
        })
        bound_inventory = bind_downstream_reference_inventory(
            inventory,
            manifest("I2VA", [picture(1)]),
        )
        bound = model_media_labels(
            manifest("I2VA", [picture(1)]),
            bound_inventory,
            mode="I2VA",
        )
        self.assertEqual(bound["picture-1"], "<Picture 1>")

    def test_continuum_uses_only_downstream_public_tags_when_inventory_is_declared(self):
        request_input = {
            "mode": "Reference",
            "generation_target": "continuum",
            "media_manifest": manifest("Reference", [video(1)]),
            "downstream_reference_inventory": downstream_inventory(
                1,
                video_reference=True,
                reference_audio=True,
                driving_audio=True,
            ),
        }
        self.assertEqual(
            effective_reference_tags(request_input, continuum=True),
            {"<Picture 1>", "<Video 1>", "<Audio 1>"},
        )

    def test_keyframes_own_picture_tags_only_when_reference_images_are_absent(self):
        keyframes = normalize_downstream_reference_inventory(
            downstream_inventory(0, first_frame=True, last_frame=True)
        )
        self.assertEqual(
            [(item["role"], item.get("tag")) for item in keyframes["items"]],
            [("first_frame", "<Picture 1>"), ("last_frame", "<Picture 2>")],
        )

        hybrid = normalize_downstream_reference_inventory(
            downstream_inventory(2, first_frame=True, last_frame=True)
        )
        self.assertEqual(
            [(item["role"], item.get("tag")) for item in hybrid["items"]],
            [
                ("reference_image", "<Picture 1>"),
                ("reference_image", "<Picture 2>"),
                ("first_frame", None),
                ("last_frame", None),
            ],
        )

    def test_video_and_reference_audio_own_public_tags_while_driving_audio_stays_untagged(self):
        value = normalize_downstream_reference_inventory(
            downstream_inventory(
                0,
                video_reference=True,
                reference_audio=True,
                driving_audio=True,
            )
        )
        self.assertEqual(
            [(item["role"], item.get("tag")) for item in value["items"]],
            [
                ("video_reference", "<Video 1>"),
                ("reference_audio", "<Audio 1>"),
                ("driving_audio", None),
            ],
        )

        broken = downstream_inventory(0, reference_audio=True)
        broken["items"][0]["tag"] = "<Audio 2>"
        with self.assertRaisesRegex(ValueError, "Reference Audio must use public tag <Audio 1>"):
            normalize_downstream_reference_inventory(broken)

    def test_continuum_reference_policy_requires_active_reference_audio_and_keeps_it_mutable_by_name(self):
        inventory = downstream_inventory(1, reference_audio=True)
        generated = {
            "mode": "Reference",
            "generation_target": "continuum",
            "creative_brief": "Use the image identity and the reference audio character.",
            "media_manifest": manifest("Reference", []),
            "downstream_reference_inventory": inventory,
        }
        policy = reference_policy(generated)
        self.assertEqual(policy.required, {"<Picture 1>", "<Audio 1>"})
        self.assertEqual(policy.allowed, {"<Picture 1>", "<Audio 1>"})

        refined = {
            **generated,
            "current_prompt": "Keep <Picture 1> and <Audio 1>.",
            "instruction": "Replace the role of <Audio 1>.",
        }
        policy = reference_policy(refined)
        self.assertEqual(policy.required, {"<Picture 1>"})
        self.assertEqual(policy.mutable, {"<Audio 1>"})

    def test_invalid_hybrid_keyframe_picture_identity_is_rejected(self):
        value = downstream_inventory(1, first_frame=True)
        value["items"][1]["tag"] = "<Picture 2>"
        with self.assertRaisesRegex(ValueError, "must not own public <Picture N> tags"):
            normalize_downstream_reference_inventory(value)


class ContinuumModeTopologyTests(unittest.TestCase):
    def test_temporal_modes_require_matching_first_last_wiring(self):
        cases = (
            ("T2VA", downstream_inventory(0), True),
            ("T2VA", downstream_inventory(1), False),
            ("T2VA", downstream_inventory(0, first_frame=True), False),
            ("I2VA", downstream_inventory(0, first_frame=True), True),
            ("I2VA", downstream_inventory(2, first_frame=True), True),
            ("I2VA", downstream_inventory(0), False),
            ("I2VA", downstream_inventory(0, first_frame=True, last_frame=True), False),
            ("FL2VA", downstream_inventory(0, first_frame=True, last_frame=True), True),
            ("FL2VA", downstream_inventory(1, first_frame=True, last_frame=True), True),
            ("FL2VA", downstream_inventory(0, first_frame=True), False),
            ("L2VA", downstream_inventory(0, last_frame=True), True),
            ("L2VA", downstream_inventory(1, last_frame=True), True),
            ("L2VA", downstream_inventory(0, first_frame=True, last_frame=True), False),
        )
        for mode, inventory, valid in cases:
            request_input = {
                "downstream_reference_inventory": inventory,
                "media_manifest": manifest(mode, []),
            }
            with self.subTest(mode=mode, inventory=inventory):
                if valid:
                    validate_continuum_mode_topology(mode, request_input)
                else:
                    with self.assertRaises(ContinuumError) as raised:
                        validate_continuum_mode_topology(mode, request_input)
                    self.assertEqual(
                        raised.exception.code,
                        "CONTINUUM_MODE_TOPOLOGY_MISMATCH",
                    )

    def test_t2va_rejects_reference_images_without_keyframes(self):
        request_input = {
            "downstream_reference_inventory": downstream_inventory(1),
            "media_manifest": manifest("T2VA", []),
        }
        with self.assertRaises(ContinuumError) as raised:
            validate_continuum_mode_topology("T2VA", request_input)
        self.assertEqual(raised.exception.code, "CONTINUUM_MODE_TOPOLOGY_MISMATCH")
        self.assertEqual(raised.exception.details["actual"]["reference_images"], 1)
        self.assertEqual(raised.exception.details["required"]["reference_images"], 0)

    def test_reference_mode_keeps_hybrid_keyframe_topologies_valid(self):
        for inventory in (
            downstream_inventory(1),
            downstream_inventory(1, first_frame=True),
            downstream_inventory(1, last_frame=True),
            downstream_inventory(1, first_frame=True, last_frame=True),
        ):
            validate_continuum_mode_topology(
                "Reference",
                {
                    "downstream_reference_inventory": inventory,
                    "media_manifest": manifest("Reference", []),
                },
            )

    def test_plan_assembly_rejects_fl2va_without_both_sampler_keyframes(self):
        request = body(
            "FL2VA",
            brief="Reach the final composition.",
            inventory=downstream_inventory(0, first_frame=True),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("FL2VA", [])):
            with self.assertRaises(ContinuumError) as raised:
                assemble_continuum_plan_request(request)
        self.assertEqual(raised.exception.code, "CONTINUUM_MODE_TOPOLOGY_MISMATCH")
        self.assertEqual(
            raised.exception.details["required"],
            {"first_frame": True, "last_frame": True},
        )


class SequencePlanTests(unittest.TestCase):
    def test_v2_plan_injects_application_owned_indexes_and_reference_assignments(self):
        value = validate_sequence_plan(
            plan_v2(),
            settings(),
            expected_references={"<Picture 1>", "<Picture 2>"},
        )
        self.assertEqual([item["index"] for item in value["chunks"]], [1, 2, 3])
        self.assertEqual(
            [item["tag"] for item in value["global"]["reference_assignments"]],
            ["<Picture 1>", "<Picture 2>"],
        )

    def test_planner_must_not_emit_application_owned_chunk_indexes(self):
        value = plan_v2()
        value["chunks"][0]["index"] = 1
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(value, settings(), expected_references=set())
        self.assertEqual(raised.exception.code, "INVALID_CONTINUUM_PLAN")

    def test_sequence_preamble_is_required_for_new_plans_and_rejects_timeline_headers(self):
        for preamble in ("", "[0-5s]\nBad"):
            value = plan_v2(preamble=preamble)
            with self.subTest(preamble=preamble), self.assertRaises(ContinuumError):
                validate_sequence_plan(value, settings(), expected_references=set())

    def test_internal_global_planning_text_may_be_empty_but_must_remain_text(self):
        value = plan_v2()
        value["global"]["continuity_anchors"] = ""
        value["global"]["persistent_constraints"] = "   "
        validated = validate_sequence_plan(value, settings(), expected_references=set())
        self.assertEqual(validated["global"]["continuity_anchors"], "")
        self.assertEqual(validated["global"]["persistent_constraints"], "")

        for field in ("continuity_anchors", "persistent_constraints"):
            invalid = plan_v2()
            invalid["global"][field] = None
            with self.subTest(field=field), self.assertRaises(ContinuumError) as raised:
                validate_sequence_plan(invalid, settings(), expected_references=set())
            self.assertEqual(raised.exception.details["field"], f"global.{field}")
            self.assertIn("must be text", raised.exception.message)

    def test_plan_rejects_reference_identity_drift_in_preamble_or_chunk_state(self):
        preamble_drift = plan_v2(preamble="Keep <Picture 2> fixed.")
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(
                preamble_drift,
                settings(),
                expected_references={"<Picture 1>"},
            )
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_IDENTITY_DRIFT")
        self.assertEqual(raised.exception.details["unexpected"], ["<Picture 2>"])
        self.assertEqual(raised.exception.details["allowed"], ["<Picture 1>"])

        chunk_drift = plan_v2(preamble="Keep <Picture 1> fixed.")
        chunk_drift["chunks"][1]["action"] = "Reveal <Picture 3> behind the subject."
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(
                chunk_drift,
                settings(),
                expected_references={"<Picture 1>"},
            )
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_IDENTITY_DRIFT")
        self.assertEqual(raised.exception.details["unexpected"], ["<Picture 3>"])

    def test_plan_accepts_declared_reference_tags_across_global_and_chunk_fields(self):
        value = plan_v2(preamble="Keep <Picture 1> as the persistent identity reference.")
        value["global"]["continuity_anchors"] += " <Picture 1> remains the same source."
        value["chunks"][1]["action"] = "Continue using <Picture 1> for identity."
        validated = validate_sequence_plan(
            value,
            settings(),
            expected_references={"<Picture 1>"},
        )
        self.assertEqual(validated["global"]["sequence_preamble"], value["global"]["sequence_preamble"])

    def test_multi_chunk_preamble_rejects_opening_or_final_keyframe_tags(self):
        value = plan_v2(preamble="Keep <Picture 2> as the final target.")
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(
                value,
                settings(),
                expected_references={"<Picture 1>", "<Picture 2>"},
                persistent_references=set(),
            )
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SCOPE_DRIFT")
        self.assertEqual(raised.exception.details["unexpected"], ["<Picture 2>"])

    def test_preamble_accepts_persistent_reference_and_video_tags(self):
        value = plan_v2(preamble="Keep <Picture 1> identity and <Video 1> motion language consistent.")
        validated = validate_sequence_plan(
            value,
            settings(),
            expected_references={"<Picture 1>", "<Video 1>"},
            persistent_references={"<Picture 1>", "<Video 1>"},
        )
        self.assertEqual(validated["global"]["sequence_preamble"], value["global"]["sequence_preamble"])

    def test_global_internal_fields_reject_chunk_scoped_keyframe_tags(self):
        value = plan_v2()
        value["global"]["continuity_anchors"] = "Keep the identity from <Picture 1> unchanged."
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(
                value,
                settings(),
                expected_references={"<Picture 1>", "<Picture 2>"},
                persistent_references=set(),
                chunk_reference_scopes=[
                    {"<Picture 1>"},
                    set(),
                    {"<Picture 2>"},
                ],
            )
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SCOPE_DRIFT")
        self.assertEqual(raised.exception.details["scope"], "global")
        self.assertEqual(raised.exception.details["unexpected"], ["<Picture 1>"])

    def test_semantic_chunk_fields_reject_reference_outside_that_chunk_scope(self):
        value = plan_v2()
        value["chunks"][0]["action"] = "Reach <Picture 2> immediately."
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(
                value,
                settings(),
                expected_references={"<Picture 1>", "<Picture 2>"},
                persistent_references=set(),
                chunk_reference_scopes=[
                    {"<Picture 1>"},
                    set(),
                    {"<Picture 2>"},
                ],
            )
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SCOPE_DRIFT")
        self.assertEqual(raised.exception.details["scope"], "chunk")
        self.assertEqual(raised.exception.details["chunk_index"], 1)
        self.assertEqual(raised.exception.details["unexpected"], ["<Picture 2>"])

    def test_semantic_chunk_fields_accept_keyframe_tags_only_at_valid_endpoints(self):
        value = plan_v2()
        value["chunks"][0]["start_state"] = "Opening composition is anchored by <Picture 1>."
        value["chunks"][2]["end_state"] = "Final composition lands on <Picture 2>."
        validated = validate_sequence_plan(
            value,
            settings(),
            expected_references={"<Picture 1>", "<Picture 2>"},
            persistent_references=set(),
            chunk_reference_scopes=[
                {"<Picture 1>"},
                set(),
                {"<Picture 2>"},
            ],
        )
        self.assertIn("<Picture 1>", validated["chunks"][0]["start_state"])
        self.assertIn("<Picture 2>", validated["chunks"][2]["end_state"])

    def test_subject_ids_are_canonicalized_from_common_model_forms(self):
        forms = ("<Subject 1>", "<Subject A>", "Subject 1", "subject 1", "S1", "subject_1", "1", 1)
        for raw in forms:
            with self.subTest(raw=raw):
                value = plan_v2()
                value["global"]["subject_anchors"] = [
                    {"id": raw, "meaning": "The same courier throughout the sequence."}
                ]
                validated = validate_sequence_plan(value, settings(), expected_references=set())
                self.assertEqual(
                    validated["global"]["subject_anchors"],
                    [{"id": "<Subject 1>", "meaning": "The same courier throughout the sequence."}],
                )

    def test_alphabetic_subject_aliases_are_normalized_throughout_the_plan(self):
        value = plan_v2()
        value["global"]["sequence_preamble"] += " Keep <Subject A> visually stable."
        value["global"]["continuity_anchors"] = "<Subject A> remains the same courier."
        value["global"]["persistent_constraints"] = "Do not change <Subject A>'s coat."
        value["global"]["subject_anchors"] = [
            {"id": "<Subject A>", "meaning": "<Subject A> is the courier."}
        ]
        value["chunks"][0]["start_state"] = "<Subject A> waits by the door."
        value["chunks"][1]["action"] = "<Subject A> crosses the room."
        value["chunks"][2]["end_state"] = "<Subject A> stops at the window."
        validated = validate_sequence_plan(value, settings(), expected_references=set())
        serialized = json.dumps(validated)
        self.assertNotIn("<Subject A>", serialized)
        self.assertIn("<Subject 1>", serialized)
        self.assertEqual(
            validated["global"]["subject_anchors"],
            [{"id": "<Subject 1>", "meaning": "<Subject 1> is the courier."}],
        )

    def test_plan_rejects_subject_tag_not_declared_in_subject_anchors(self):
        value = plan_v2()
        value["global"]["subject_anchors"] = []
        value["chunks"][1]["action"] = "<Subject 1> crosses the room."
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(value, settings(), expected_references=set())
        self.assertEqual(raised.exception.code, "CONTINUUM_SUBJECT_IDENTITY_DRIFT")
        self.assertEqual(raised.exception.details["unexpected"], ["<Subject 1>"])
        self.assertEqual(raised.exception.details["planned"], [])

    def test_plan_accepts_subject_tags_declared_in_subject_anchors(self):
        value = plan_v2()
        value["global"]["subject_anchors"] = [
            {"id": "<Subject 1>", "meaning": "The same courier throughout the sequence."}
        ]
        value["global"]["sequence_preamble"] += " Keep <Subject 1> visually stable."
        value["chunks"][1]["action"] = "<Subject 1> crosses the room."
        validated = validate_sequence_plan(value, settings(), expected_references=set())
        self.assertEqual(
            validated["global"]["subject_anchors"],
            [{"id": "<Subject 1>", "meaning": "The same courier throughout the sequence."}],
        )

    def test_duplicate_subjects_after_canonicalization_are_rejected(self):
        value = plan_v2()
        value["global"]["subject_anchors"] = [
            {"id": "Subject 1", "meaning": "Courier."},
            {"id": "1", "meaning": "Same courier again."},
        ]
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(value, settings(), expected_references=set())
        self.assertIn("<Subject 1>", raised.exception.message)

    def test_intentional_break_requires_an_explicit_reason(self):
        value = plan_v2()
        value["chunks"][1]["continuity"] = "intentional_break"
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_plan(value, settings(), expected_references=set())
        self.assertEqual(raised.exception.code, "INVALID_CONTINUUM_PLAN_CONTINUITY")

    def test_strict_parser_rejects_prose_wrapper_but_bounded_recovery_extracts_one_plan_object(self):
        payload = json.dumps(plan_v2())
        parsed = parse_sequence_plan(f"```json\n{payload}\n```", settings(), expected_references=set())
        self.assertEqual(parsed["global"]["sequence_preamble"], plan_v2()["global"]["sequence_preamble"])
        wrapped = f"Here is the plan:\n{payload}\nDone."
        with self.assertRaises(ContinuumError):
            parse_sequence_plan(wrapped, settings(), expected_references=set())
        recovered, actions = recover_sequence_plan_contract(
            wrapped,
            settings(),
            expected_references=set(),
        )
        self.assertEqual(recovered["global"]["sequence_preamble"], plan_v2()["global"]["sequence_preamble"])
        self.assertEqual(actions, ["extracted_embedded_json"])

    def test_bounded_recovery_synthesizes_only_from_global_semantics(self):
        value = plan_v2()
        value["global"]["sequence_preamble"] = ""
        value["global"]["continuity_anchors"] = "Same courier, coat, hallway, and camera axis."
        value["global"]["persistent_constraints"] = "Preserve the requested exclusions."
        value["global"]["subject_anchors"] = [
            {"id": "<Subject A>", "meaning": "<Subject A> remains the same courier."}
        ]
        value["chunks"][0]["action"] = "A chunk-local explosion occurs."
        recovered, actions = recover_sequence_plan_contract(
            json.dumps(value),
            settings(),
            expected_references=set(),
        )
        self.assertIn("synthesized_sequence_preamble", actions)
        preamble = recovered["global"]["sequence_preamble"]
        self.assertIn("<Subject 1> remains the same courier.", preamble)
        self.assertIn("Same courier, coat, hallway, and camera axis.", preamble)
        self.assertIn("Preserve the requested exclusions.", preamble)
        self.assertNotIn("explosion", preamble.lower())

    def test_bounded_recovery_defaults_optional_internal_text_and_strips_application_fields(self):
        value = plan_v2()
        value["global"]["sequence_preamble"] = ""
        value["global"]["continuity_anchors"] = None
        value["global"]["persistent_constraints"] = None
        value["global"]["subject_anchors"] = None
        value["global"]["reference_assignments"] = [{"tag": "<Picture 99>", "role": "wrong"}]
        for index, chunk in enumerate(value["chunks"], start=1):
            chunk["index"] = index
        recovered, actions = recover_sequence_plan_contract(
            json.dumps(value),
            settings(),
            expected_references=set(),
        )
        self.assertEqual(recovered["global"]["continuity_anchors"], "")
        self.assertEqual(recovered["global"]["persistent_constraints"], "")
        self.assertEqual(recovered["global"]["subject_anchors"], [])
        self.assertEqual(recovered["global"]["reference_assignments"], [])
        self.assertTrue(recovered["global"]["sequence_preamble"])
        self.assertIn("defaulted_continuity_anchors", actions)
        self.assertIn("defaulted_persistent_constraints", actions)
        self.assertIn("defaulted_subject_anchors", actions)
        self.assertIn("removed_reference_assignments", actions)
        self.assertIn("removed_chunk_indexes", actions)

    def test_bounded_recovery_does_not_invent_missing_chunk_semantics(self):
        value = plan_v2()
        value["chunks"][1]["action"] = ""
        with self.assertRaises(ContinuumError) as raised:
            recover_sequence_plan_contract(
                json.dumps(value),
                settings(),
                expected_references=set(),
            )
        self.assertEqual(raised.exception.details["field"], "action")


class CanonicalTimelineTests(unittest.TestCase):
    def test_integer_timeline_uses_shared_preamble_and_headers_on_their_own_lines(self):
        preamble = "Same subject and film stock remain consistent."
        prompts = ["First section.", "Second section.", "Third section."]
        script = serialize_timeline(preamble, prompts, 5)
        self.assertEqual(
            script,
            "Same subject and film stock remain consistent.\n\n"
            "[0-5s]\nFirst section.\n\n"
            "[5-10s]\nSecond section.\n\n"
            "[10-15s]\nThird section.",
        )
        self.assertEqual(parse_timeline_sequence(script, expected_chunks=3, chunk_seconds=5), (preamble, prompts))

    def test_fractional_boundaries_are_exact_and_never_emit_float_garbage(self):
        script = serialize_timeline("Global.", ["One.", "Two.", "Three."], 6.5)
        self.assertIn("[0-6.5s]\n", script)
        self.assertIn("[6.5-13s]\n", script)
        self.assertIn("[13-19.5s]\n", script)
        self.assertNotIn("000000", script)
        self.assertEqual(format_timeline_seconds(0), "0")
        self.assertEqual(format_timeline_seconds(13.0), "13")

    def test_one_and_sixteen_chunk_timelines_round_trip(self):
        for chunks in (1, 16):
            prompts = [f"Body {index}." for index in range(1, chunks + 1)]
            script = serialize_timeline("Global.", prompts, 4.25)
            parsed = parse_timeline_sequence(script, expected_chunks=chunks, chunk_seconds=4.25)
            self.assertEqual(parsed, ("Global.", prompts))
            self.assertIn(f"[{format_timeline_seconds((chunks - 1) * 4.25)}-{format_timeline_seconds(chunks * 4.25)}s]", script)

    def test_inline_or_wrong_boundaries_are_rejected_by_writer(self):
        invalid = (
            "[0-5s] inline body",
            "[0-5s]\nOne.\n\n[5-11s]\nTwo.",
            "[0 - 5s]\nOne.\n\n[5-10s]\nTwo.",
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ContinuumError):
                parse_timeline_sequence(value, expected_chunks=2, chunk_seconds=5)

    def test_preamble_reaches_every_resolved_prompt_once_and_hashes_cover_resolved_text(self):
        preamble = "Persistent <Picture 1> role and lighting."
        prompts = ["Action one.", "Action two.", "Action three."]
        value = plan_v2(preamble=preamble)
        result = sequence_result(settings(), value, prompts)
        self.assertEqual(result["preamble"], preamble)
        for index, item in enumerate(result["chunks"]):
            expected = resolved_chunk_prompt(preamble, prompts[index])
            self.assertEqual(item["resolved_prompt"], expected)
            self.assertEqual(item["resolved_prompt"].count(preamble), 1)
            self.assertEqual(item["hash"], prompt_hash(expected))

    def test_empty_preamble_is_only_supported_for_strict_legacy_migration(self):
        legacy = serialize_chunk_prompts(["One.", "Two."])
        self.assertEqual(parse_chunk_prompts(legacy, expected_chunks=2), ["One.", "Two."])
        migrated = serialize_timeline("", ["One.", "Two."], 5)
        self.assertEqual(migrated, "[0-5s]\nOne.\n\n[5-10s]\nTwo.")


class ContinuumAssemblyTests(unittest.TestCase):
    def test_continuum_plan_requires_authoritative_downstream_inventory(self):
        request = body()
        request.pop("downstream_reference_inventory")
        with self.assertRaises(ContinuumError) as raised:
            assemble_continuum_plan_request(request)
        self.assertEqual(raised.exception.code, "INVALID_DOWNSTREAM_REFERENCE_INVENTORY")
        self.assertEqual(
            raised.exception.details["field"],
            "downstream_reference_inventory",
        )

    def test_declared_only_reference_is_allowed_without_model_visible_media(self):
        request = body(
            "Reference",
            brief="Use <Picture 1> for the subject identity and <Picture 2> for the environment.",
            inventory=downstream_inventory(2),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [])):
            assembled = assemble_continuum_plan_request(request)
        self.assertEqual(assembled["media_inputs"], [])
        self.assertEqual(
            [item["tag"] for item in assembled["input"]["downstream_reference_inventory"]["items"]],
            ["<Picture 1>", "<Picture 2>"],
        )
        user = assembled["messages"][-1]["content"]
        self.assertIn(
            "<Picture 1>: downstream reference_image conditioning via reference_image_1 (visible to planner: no)",
            user,
        )
        self.assertIn("do not invent unseen content", user)

    def test_unbound_prompt_writer_image_is_described_as_analysis_media(self):
        request = body(
            "Reference",
            brief="Use <Picture 1> for identity.",
            inventory=downstream_inventory(1),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [picture(1)])):
            assembled = assemble_continuum_plan_request(request)
        self.assertEqual(
            assembled["media_inputs"][0]["reference"],
            "Analysis image 1 (no downstream public reference identity)",
        )
        self.assertIn(
            "<Picture 1>: downstream reference_image conditioning via reference_image_1 (visible to planner: no)",
            assembled["messages"][-1]["content"],
        )

    def test_explicit_model_asset_binding_exposes_the_same_pixels_as_downstream_picture(self):
        inventory = downstream_inventory(1)
        inventory["items"][0].update({
            "visible_to_model": True,
            "model_asset_id": "picture-1",
        })
        request = body(
            "Reference",
            brief="Use <Picture 1> for identity.",
            inventory=inventory,
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [picture(1)])):
            assembled = assemble_continuum_plan_request(request)
        self.assertEqual(assembled["media_inputs"][0]["reference"], "<Picture 1>")
        self.assertIn(
            "<Picture 1>: downstream reference_image conditioning via reference_image_1 (visible to planner: yes)",
            assembled["messages"][-1]["content"],
        )

    def test_undeclared_reference_fails_before_plan_inference(self):
        request = body(
            "Reference",
            brief="Use <Picture 3> for the background.",
            inventory=downstream_inventory(2),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [])):
            with self.assertRaises(AssemblyError) as raised:
                assemble_continuum_plan_request(request)
        self.assertEqual(raised.exception.code, "REFERENCE_NOT_DECLARED")
        self.assertEqual(raised.exception.details["reference"], "<Picture 3>")

    def test_planner_contract_uses_semantic_chunks_and_production_preamble(self):
        with patch("backend.assembly.STORE.manifest", return_value=manifest()):
            assembled = assemble_continuum_plan_request(body())
        system = assembled["messages"][0]["content"]
        user = assembled["messages"][1]["content"]
        schema = user.split("Schema:\n", 1)[1]
        self.assertIn("global.sequence_preamble", system)
        self.assertIn("application owns chunk count, time boundaries", system)
        self.assertNotIn('"index"', schema)
        self.assertNotIn('"reference_assignments"', schema)
        self.assertIn('"sequence_preamble"', schema)

    def test_planner_receives_keyframe_video_and_audio_topology_without_invented_tags(self):
        request = body(
            "Reference",
            brief="Keep the opening and closing keyframes, use <Picture 1> for identity, follow the Video Reference motion, and preserve Driving Audio.",
            inventory=downstream_inventory(
                1,
                first_frame=True,
                last_frame=True,
                video_reference=True,
                driving_audio=True,
            ),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [])):
            assembled = assemble_continuum_plan_request(request)
        user = assembled["messages"][-1]["content"]
        self.assertIn("<Picture 1>: downstream reference_image conditioning", user)
        self.assertIn("First Frame keyframe: downstream first_frame conditioning", user)
        self.assertIn("Last Frame keyframe: downstream last_frame conditioning", user)
        self.assertIn("<Video 1>: downstream video_reference conditioning", user)
        self.assertIn("Driving Audio: downstream driving_audio conditioning", user)
        self.assertIn("Every inventory entry with an explicit public tag owns that exact H3 prompt identity", user)
        self.assertIn("tagged First Frame is opening-chunk-only", user)

    def test_plan_repair_audits_the_complete_contract_and_keeps_application_owned_fields_out(self):
        error = ContinuumError("INVALID_CONTINUUM_PLAN", "Bad shape.", {"field": "chunks"})
        with patch("backend.assembly.STORE.manifest", return_value=manifest()):
            assembled = assemble_continuum_plan_repair_request(body(), "{bad", error)
        system = assembled["messages"][0]["content"]
        self.assertIn("global.sequence_preamble is the common Continuum prompt text", system)
        self.assertIn("Driving Audio is persistent conditioning", system)
        self.assertIn("first validation failure", system)
        self.assertIn("repair every contract violation", system)
        self.assertIn("whole object to validate", system)
        self.assertIn("required non-empty global.sequence_preamble", system)
        self.assertIn("canonical positive numeric IDs such as <Subject 1>", system)
        self.assertIn("never alphabetic IDs such as <Subject A>", system)
        self.assertIn("Do not add application-owned chunk indexes", system)
        user = assembled["messages"][1]["content"]
        self.assertIn("First validation error: Bad shape.", user)
        self.assertIn("Repair the whole object, not only that field.", user)

    def test_generated_chunk_rejects_subject_when_plan_declares_no_subjects(self):
        request = body()
        no_subject_plan = plan_v2()
        no_subject_plan["global"]["subject_anchors"] = []
        normalized_plan = validate_sequence_plan(
            no_subject_plan,
            settings(),
            expected_references=set(),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest()):
            assembled = assemble_continuum_chunk_request(
                request,
                normalized_plan,
                1,
                previous_prompt=None,
            )
        with self.assertRaises(ContinuumError) as raised:
            validate_generated_chunk("<Subject 1> enters the room.", assembled)
        self.assertEqual(raised.exception.code, "CONTINUUM_SUBJECT_IDENTITY_DRIFT")
        self.assertEqual(raised.exception.details["unexpected"], ["<Subject 1>"])
        self.assertEqual(raised.exception.details["planned"], [])

    def test_generated_chunk_allows_declared_unseen_tags_and_rejects_undeclared_tags(self):
        request = body(
            "Reference",
            brief="Use <Picture 1>.",
            inventory=downstream_inventory(1),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [])):
            plan_request = assemble_continuum_plan_request(request)
            normalized_plan = validate_sequence_plan(
                plan_v2(),
                settings(),
                expected_references={"<Picture 1>"},
            )
            assembled = assemble_continuum_chunk_request(
                request,
                normalized_plan,
                1,
                previous_prompt=None,
            )
        self.assertEqual(validate_generated_chunk("Use <Picture 1>.", assembled), "Use <Picture 1>.")
        with self.assertRaises(ContinuumError) as raised:
            validate_generated_chunk("Use <Picture 2>.", assembled)
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_IDENTITY_DRIFT")

    def test_chunk_format_validator_rejects_repeated_preamble_and_standalone_wrappers(self):
        preamble = "Stable identity and camera language."
        bad_cases = {
            "repeated preamble": preamble + "\n\nContinue walking.",
            "base field": "integrated_multimodal_description: Continue walking.",
            "reference field": "subject_definitions: <Subject 1> is the courier.",
            "shot wrapper": "[Shot 1] Continue walking.",
            "alignment": "How the reference pictures align with the target video: Picture 1 is first.",
            "fence": "\x60\x60\x60\nContinue walking.\n\x60\x60\x60",
        }
        for label, prompt in bad_cases.items():
            with self.subTest(label=label):
                self.assertTrue(
                    continuum_chunk_format_violations(
                        prompt,
                        preamble=preamble,
                    )
                )
        self.assertEqual(
            continuum_chunk_format_violations(
                "Continue walking as the camera tracks beside the courier.",
                preamble=preamble,
            ),
            [],
        )

    def test_generated_chunk_rejects_repeated_preamble_before_serialization(self):
        normalized_plan = validate_sequence_plan(
            plan_v2(preamble="Stable identity and camera language."),
            settings(),
            expected_references=set(),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest()):
            assembled = assemble_continuum_chunk_request(
                body(),
                normalized_plan,
                1,
                previous_prompt=None,
            )
        with self.assertRaises(ContinuumError) as raised:
            validate_generated_chunk(
                "Stable identity and camera language.\n\nContinue walking.",
                assembled,
            )
        self.assertEqual(raised.exception.code, "INVALID_CONTINUUM_CHUNK_FORMAT")
        self.assertIn(
            "repeated shared sequence preamble",
            raised.exception.details["violations"],
        )

    def test_continuum_chunk_writer_uses_dedicated_contract_not_standalone_mode_wrapper(self):
        request = body(
            "FL2VA",
            brief="Start from <Picture 1> and end at <Picture 2>.",
            inventory=downstream_inventory(0, first_frame=True, last_frame=True),
        )
        normalized_plan = validate_sequence_plan(
            plan_v2(),
            settings(),
            expected_references={"<Picture 1>", "<Picture 2>"},
            persistent_references=set(),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("FL2VA", [])):
            assembled = assemble_continuum_chunk_request(
                request,
                normalized_plan,
                1,
                previous_prompt=None,
            )
        self.assertEqual(assembled["guide"]["id"], "h3-continuum-chunk-v2")
        self.assertEqual(assembled["messages"][0]["name"], "h3_continuum_chunk_writer")
        system = assembled["messages"][0]["content"]
        self.assertIn("not a standalone T2VA/I2VA/FL2VA/L2VA/Reference request", system)
        self.assertIn("do not write absolute sequence timestamps inside a chunk body", system)
        self.assertIn("stable sequence-wide IDs such as (S1), (S2)", system)
        self.assertIn("<d>[Language] ...</d>", system)
        self.assertIn("Treat every explicitly assigned reference role as exclusive", system)
        self.assertIn("Driving Audio owns no <Audio N> tag", system)
        self.assertNotIn("How the reference pictures align", assembled["messages"][-1]["content"])
        self.assertEqual(assembled["input"]["continuum_chunk_allowed_references"], ["<Picture 1>"])

    def test_fl2va_keyframe_tags_are_scoped_to_opening_and_final_chunks(self):
        request = body(
            "FL2VA",
            brief="Start from <Picture 1> and eventually reach <Picture 2>.",
            inventory=downstream_inventory(0, first_frame=True, last_frame=True),
        )
        normalized_plan = validate_sequence_plan(
            plan_v2(),
            settings(),
            expected_references={"<Picture 1>", "<Picture 2>"},
            persistent_references=set(),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("FL2VA", [])):
            chunk1 = assemble_continuum_chunk_request(request, normalized_plan, 1, previous_prompt=None)
            chunk2 = assemble_continuum_chunk_request(request, normalized_plan, 2, previous_prompt="Opening.")
            chunk3 = assemble_continuum_chunk_request(request, normalized_plan, 3, previous_prompt="Middle.")

        self.assertEqual(chunk1["input"]["continuum_chunk_allowed_references"], ["<Picture 1>"])
        self.assertEqual(chunk2["input"]["continuum_chunk_allowed_references"], [])
        self.assertEqual(chunk3["input"]["continuum_chunk_allowed_references"], ["<Picture 2>"])
        self.assertEqual(validate_generated_chunk("Open from <Picture 1>.", chunk1), "Open from <Picture 1>.")
        self.assertEqual(validate_generated_chunk("Continue the same action.", chunk2), "Continue the same action.")
        self.assertEqual(validate_generated_chunk("Land on <Picture 2>.", chunk3), "Land on <Picture 2>.")
        for bad_prompt, assembled in (
            ("Reach <Picture 2> immediately.", chunk1),
            ("Reset to <Picture 1>.", chunk2),
            ("Reset to <Picture 1>.", chunk3),
        ):
            with self.subTest(prompt=bad_prompt), self.assertRaises(ContinuumError) as raised:
                validate_generated_chunk(bad_prompt, assembled)
            self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_IDENTITY_DRIFT")

    def test_persistent_reference_image_and_video_tags_remain_available_in_middle_chunk(self):
        request = body(
            "Reference",
            brief="Keep <Picture 1> identity and <Video 1> motion language.",
            inventory=downstream_inventory(
                1,
                first_frame=True,
                last_frame=True,
                video_reference=True,
            ),
        )
        normalized_plan = validate_sequence_plan(
            plan_v2(preamble="Keep <Picture 1> identity and <Video 1> motion language consistent."),
            settings(),
            expected_references={"<Picture 1>", "<Video 1>"},
            persistent_references={"<Picture 1>", "<Video 1>"},
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [])):
            middle = assemble_continuum_chunk_request(
                request,
                normalized_plan,
                2,
                previous_prompt="Opening.",
            )
        self.assertEqual(
            middle["input"]["continuum_chunk_allowed_references"],
            ["<Picture 1>", "<Video 1>"],
        )
        self.assertEqual(
            validate_generated_chunk("Continue <Picture 1> using <Video 1> motion.", middle),
            "Continue <Picture 1> using <Video 1> motion.",
        )

    def test_hybrid_keyframes_do_not_expand_picture_inventory_but_video_reference_is_public(self):
        request = body(
            "Reference",
            brief="Use <Picture 1> and <Video 1>.",
            inventory=downstream_inventory(
                1,
                first_frame=True,
                last_frame=True,
                video_reference=True,
                driving_audio=True,
            ),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [])):
            assembled = assemble_continuum_plan_request(request)
        self.assertEqual(
            [item["tag"] for item in assembled["input"]["downstream_reference_inventory"]["items"] if item.get("tag")],
            ["<Picture 1>", "<Video 1>"],
        )

    def test_fl2va_keyframes_are_valid_public_picture_one_and_two_without_reference_images(self):
        request = body(
            "FL2VA",
            brief="Start from <Picture 1> and reach <Picture 2>.",
            inventory=downstream_inventory(0, first_frame=True, last_frame=True),
        )
        with patch("backend.assembly.STORE.manifest", return_value=manifest("FL2VA", [])):
            assembled = assemble_continuum_plan_request(request)
        self.assertEqual(
            effective_reference_tags(assembled["input"], continuum=True),
            {"<Picture 1>", "<Picture 2>"},
        )


class SequenceReferenceScopeTests(unittest.TestCase):
    def test_manual_keyframe_scope_rejects_middle_chunk_and_global_final_tag(self):
        request_input = {
            "downstream_reference_inventory": downstream_inventory(
                0,
                first_frame=True,
                last_frame=True,
                video_reference=True,
            ),
            "media_manifest": manifest("FL2VA", []),
        }
        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_reference_scope(
                request_input,
                preamble="Stable scene.",
                prompts=[
                    "Open from <Picture 1>.",
                    "Reset to <Picture 1>.",
                    "Finish on <Picture 2>.",
                ],
                chunks=3,
            )
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SCOPE_DRIFT")
        self.assertEqual(raised.exception.details["chunk_index"], 2)

        with self.assertRaises(ContinuumError) as raised:
            validate_sequence_reference_scope(
                request_input,
                preamble="Keep <Picture 2> fixed.",
                prompts=["Open.", "Continue.", "Finish."],
                chunks=3,
            )
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SCOPE_DRIFT")
        self.assertEqual(raised.exception.details["scope"], "global")

    def test_reference_audio_is_persistent_in_preamble_and_every_chunk(self):
        request_input = {
            "downstream_reference_inventory": downstream_inventory(
                0,
                reference_audio=True,
                driving_audio=True,
            ),
            "media_manifest": manifest("Reference", []),
        }
        validate_sequence_reference_scope(
            request_input,
            preamble="Keep <Audio 1> as the persistent reference-audio identity.",
            prompts=[
                "Open with <Audio 1> conditioning.",
                "Continue with <Audio 1> conditioning.",
                "Finish with <Audio 1> conditioning.",
            ],
            chunks=3,
        )

    def test_manual_hybrid_persistent_reference_and_video_are_valid_in_middle_chunk(self):
        request_input = {
            "downstream_reference_inventory": downstream_inventory(
                1,
                first_frame=True,
                last_frame=True,
                video_reference=True,
            ),
            "media_manifest": manifest("Reference", []),
        }
        validate_sequence_reference_scope(
            request_input,
            preamble="Keep <Picture 1> identity and <Video 1> motion language stable.",
            prompts=[
                "Open.",
                "Continue <Picture 1> with <Video 1>.",
                "Finish.",
            ],
            chunks=3,
        )


class ContinuumRefinementTests(unittest.TestCase):
    def test_chunk_local_refinement_keeps_preamble_and_untouched_hashes_identical(self):
        preamble = "Stable identity, wardrobe, environment, lens language, and room tone."
        prompts = ["Chunk one.", "Chunk two.", "Chunk three."]
        value = plan_v2(preamble=preamble)
        original = sequence_result(settings(), value, prompts)
        request = body()
        request.update({
            "current_prompt": original["prompt"],
            "instruction": "Slow the hand movement only in the second span.",
        })
        request["continuum"].update({"chunk_index": 2, "plan": original["plan"]})

        with patch("backend.assembly.STORE.manifest", return_value=manifest()):
            assembled, sequence_state, index, saved_plan = assemble_continuum_refinement(request)
        self.assertEqual(sequence_state, {
            "preamble": preamble,
            "prompts": prompts,
            "downstream_reference_inventory": downstream_inventory(0),
        })
        self.assertEqual(index, 2)
        self.assertIn("Current selected chunk body:\nChunk two.", assembled["messages"][-1]["content"])
        self.assertIn("Following unchanged chunk-local prompt for boundary compatibility:\nChunk three.", assembled["messages"][-1]["content"])
        self.assertIn("Return only the complete replacement body for this logical span.", assembled["messages"][-1]["content"])
        self.assertIn("Do not repeat the shared preamble.", assembled["messages"][-1]["content"])

        updated = apply_continuum_refinement(
            "Refined chunk two.",
            assembled,
            sequence_state,
            index,
            saved_plan,
        )
        self.assertEqual(updated["preamble"], preamble)
        self.assertEqual(updated["chunks"][0]["resolved_prompt"], original["chunks"][0]["resolved_prompt"])
        self.assertEqual(updated["chunks"][2]["resolved_prompt"], original["chunks"][2]["resolved_prompt"])
        self.assertEqual(updated["chunks"][0]["hash"], original["chunks"][0]["hash"])
        self.assertEqual(updated["chunks"][2]["hash"], original["chunks"][2]["hash"])
        self.assertNotEqual(updated["chunks"][1]["hash"], original["chunks"][1]["hash"])

    def test_sequence_result_snapshots_authoritative_downstream_inventory(self):
        inventory = downstream_inventory(1, first_frame=True)
        inventory["items"][0].update({
            "source_node_id": 41,
            "source_node_class": "LoadImage",
            "source_output_name": "IMAGE",
            "source_slot": 0,
        })
        result = sequence_result(
            settings(),
            plan_v2(),
            ["One.", "Two.", "Three."],
            downstream_reference_inventory=inventory,
        )
        self.assertEqual(result["downstream_reference_inventory"], inventory)

    def test_refinement_rejects_same_public_tag_rewired_to_different_source(self):
        saved_inventory = downstream_inventory(1)
        saved_inventory["items"][0].update({
            "source_node_id": 41,
            "source_node_class": "LoadImage",
            "source_output_name": "IMAGE",
            "source_slot": 0,
        })
        active_inventory = downstream_inventory(1)
        active_inventory["items"][0].update({
            "source_node_id": 99,
            "source_node_class": "LoadImage",
            "source_output_name": "IMAGE",
            "source_slot": 0,
        })
        original = sequence_result(
            settings(),
            plan_v2(),
            ["One.", "Two.", "Three."],
            downstream_reference_inventory=saved_inventory,
        )
        request = body(
            "Reference",
            brief="Keep <Picture 1> identity stable.",
            inventory=active_inventory,
        )
        request.update({
            "current_prompt": original["prompt"],
            "instruction": "Slow Chunk 2.",
        })
        request["continuum"].update({
            "chunk_index": 2,
            "plan": original["plan"],
            "downstream_reference_inventory": original["downstream_reference_inventory"],
        })
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [])):
            with self.assertRaises(ContinuumError) as raised:
                assemble_continuum_refinement(request)
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SOURCE_DRIFT")
        self.assertEqual(
            raised.exception.details["saved_inventory"]["items"][0]["source_node_id"],
            41,
        )
        self.assertEqual(
            raised.exception.details["active_inventory"]["items"][0]["source_node_id"],
            99,
        )

    def test_legacy_refinement_without_inventory_snapshot_adopts_active_inventory(self):
        inventory = downstream_inventory(1)
        inventory["items"][0].update({
            "source_node_id": 41,
            "source_node_class": "LoadImage",
            "source_output_name": "IMAGE",
            "source_slot": 0,
        })
        original = sequence_result(settings(), plan_v2(), ["One.", "Two.", "Three."])
        request = body(
            "Reference",
            brief="Keep <Picture 1> identity stable.",
            inventory=inventory,
        )
        request.update({
            "current_prompt": original["prompt"],
            "instruction": "Slow Chunk 2.",
        })
        request["continuum"].update({
            "chunk_index": 2,
            "plan": original["plan"],
        })
        with patch("backend.assembly.STORE.manifest", return_value=manifest("Reference", [])):
            assembled, state, index, saved_plan = assemble_continuum_refinement(request)
        self.assertEqual(state["downstream_reference_inventory"], inventory)
        migrated = apply_continuum_refinement(
            "Changed two.",
            assembled,
            state,
            index,
            saved_plan,
        )
        self.assertEqual(migrated["downstream_reference_inventory"], inventory)

    def test_refinement_rejects_manually_edited_middle_chunk_using_opening_keyframe_tag(self):
        inventory = downstream_inventory(0, first_frame=True, last_frame=True)
        scoped_plan = plan_v2()
        scoped_plan["chunks"][0]["start_state"] = "Opening anchored by <Picture 1>."
        scoped_plan["chunks"][2]["end_state"] = "Ending lands on <Picture 2>."
        normalized = validate_sequence_plan(
            scoped_plan,
            settings(),
            expected_references={"<Picture 1>", "<Picture 2>"},
            persistent_references=set(),
            chunk_reference_scopes=[
                {"<Picture 1>"},
                set(),
                {"<Picture 2>"},
            ],
        )
        original = sequence_result(
            settings(),
            normalized,
            ["Open from <Picture 1>.", "Continue.", "Land on <Picture 2>."],
        )
        request = body(
            "FL2VA",
            brief="Start from <Picture 1> and eventually reach <Picture 2>.",
            inventory=inventory,
        )
        request.update({
            "current_prompt": original["prompt"].replace(
                "[5-10s]\nContinue.",
                "[5-10s]\nReset to <Picture 1>.",
            ),
            "instruction": "Slow Chunk 2.",
        })
        request["continuum"].update({"chunk_index": 2, "plan": normalized})
        with patch("backend.assembly.STORE.manifest", return_value=manifest("FL2VA", [])):
            with self.assertRaises(ContinuumError) as raised:
                assemble_continuum_refinement(request)
        self.assertEqual(raised.exception.code, "CONTINUUM_REFERENCE_SCOPE_DRIFT")
        self.assertEqual(raised.exception.details["chunk_index"], 2)

    def test_editing_shared_preamble_requires_global_regeneration(self):
        value = plan_v2(preamble="Original global.")
        original = sequence_result(settings(), value, ["One.", "Two.", "Three."])
        request = body()
        request["current_prompt"] = original["prompt"].replace("Original global.", "Changed global.")
        request["instruction"] = "Change chunk two."
        request["continuum"].update({"chunk_index": 2, "plan": original["plan"]})
        with patch("backend.assembly.STORE.manifest", return_value=manifest()):
            with self.assertRaises(ContinuumError) as raised:
                assemble_continuum_refinement(request)
        self.assertIn("sequence-wide plan", raised.exception.message)

    def test_schema_v2_refinement_rejects_legacy_chunk_text_instead_of_dropping_preamble(self):
        request = body()
        request["current_prompt"] = serialize_chunk_prompts(["One.", "Two.", "Three."])
        request["instruction"] = "Change chunk two."
        request["continuum"].update({
            "schema_version": 2,
            "chunk_index": 2,
            "plan": plan_v2(preamble="Global."),
        })
        with patch("backend.assembly.STORE.manifest", return_value=manifest()):
            with self.assertRaises(ContinuumError) as raised:
                assemble_continuum_refinement(request)
        self.assertEqual(raised.exception.code, "INVALID_CONTINUUM_SEQUENCE")

    def test_legacy_saved_draft_migrates_without_reinterpreting_arbitrary_text(self):
        prompts = ["One.", "Two.", "Three."]
        request = body()
        request["current_prompt"] = serialize_chunk_prompts(prompts)
        request["instruction"] = "Change chunk two."
        request["continuum"].update({
            "schema_version": 1,
            "chunk_index": 2,
            "plan": plan_v1(),
        })
        with patch("backend.assembly.STORE.manifest", return_value=manifest()):
            assembled, state, index, saved_plan = assemble_continuum_refinement(request)
        self.assertEqual(state, {
            "preamble": "",
            "prompts": prompts,
            "downstream_reference_inventory": downstream_inventory(0),
        })
        migrated = apply_continuum_refinement("Changed two.", assembled, state, index, saved_plan)
        self.assertEqual(
            migrated["prompt"],
            "[0-5s]\nOne.\n\n[5-10s]\nChanged two.\n\n[10-15s]\nThree.",
        )


if __name__ == "__main__":
    unittest.main()
