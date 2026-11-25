import asyncio
import copy
import unittest
import threading
import json
from types import SimpleNamespace
from unittest.mock import patch, Mock

from backend.sequence import validate_sequence, snapshot_media, assemble_chunk, conditioning, plain_chunk_prompt, normalize_local_timestamps
from backend.sequence_routes import run_sequence, ACTIVE_OPERATIONS, register_sequence_routes
from backend.assembly import AssemblyError
from backend.h3_pipeline import run_h3_pipeline, validate_media_capabilities
from backend.models.contract import ModelError
from backend.sequence_plan import assemble_plan, parse_plan, interval_context


def draft(count=3):
    return dict(version=1, brief="At 15 seconds she stands; at 25 seconds she reaches the window.",
                instructions="Write only the current chunk. Preserve continuity.", aspectRatio="16:9",
                first=None, last=None, references=[], chunks=[dict(id=f"c{i}",duration=10,instruction="",prompt="",additions=[],exclusions=[]) for i in range(count)])


def body(state=None, **values):
    return dict(sequence=state or draft(), action="missing", session_id="00000000-0000-0000-0000-000000000001", operation_id="op", **values)


class SequenceAssemblyTests(unittest.TestCase):
    def test_chunk_context_error_reports_the_actual_shortfall(self):
        item = assemble_chunk(draft(1), 0, body(), {})
        plan = {"context_tokens": 4096, "max_output_tokens": 1024}
        complete = Mock()
        with self.assertRaises(ModelError) as failure:
            run_h3_pipeline({"family": "external", "capabilities": {}}, item, "session", plan,
                            complete=complete, count_text_tokens=lambda _: 3000,
                            is_cancelled=lambda: False, thinking=False, seed=None)
        details = failure.exception.details
        self.assertEqual(failure.exception.code, "CONTEXT_BUDGET_EXCEEDED")
        self.assertEqual(details["excess_tokens"], details["estimated_input_tokens"] + details["reserved_output_tokens"] - 4096)
        self.assertTrue(str(failure.exception).startswith(f'This request needs about {details["excess_tokens"]:,} more context tokens.'))
        self.assertNotIn("references", details["suggestion"])
        self.assertIn("server", details["suggestion"])
        complete.assert_not_called()

    def test_context_advice_depends_on_actual_visual_inputs_and_reply_budget(self):
        item = assemble_chunk(draft(1), 0, body(), {})
        item["media_inputs"] = [{"type": "image", "asset_id": "picture", "reference": "<Picture 1>",
                                "requires_capability": "images", "snapshot_asset": {"id": "picture"},
                                "snapshot_uri": "data:image/png;base64,AA=="}]
        for text_tokens, can_reduce_budget in [(2400, True), (6000, False)]:
            with self.subTest(text_tokens=text_tokens), self.assertRaises(ModelError) as failure:
                run_h3_pipeline({"family": "ollama", "capabilities": {"images": True}}, item, "session",
                                {"context_tokens": 4096, "max_output_tokens": 2048, "generation_budget_manual": True},
                                complete=Mock(), count_text_tokens=lambda _: text_tokens,
                                is_cancelled=lambda: False, thinking=False, seed=None)
            suggestion = failure.exception.details["suggestion"]
            self.assertIn("visual references", suggestion)
            self.assertEqual("lower the Generation budget" in suggestion, can_reduce_budget)

    def test_chunk_suggests_a_sufficient_context_only_where_it_can_be_set(self):
        item = assemble_chunk(draft(1), 0, body(), {})
        plan = {"context_tokens": 4096, "max_output_tokens": 1024}
        cases = [
            ({"family": "ollama", "supports_custom_context": True, "model_context_limit": 8192}, {}, "Context (tokens)"),
            ({"family": "ollama", "model_context_limit": 8192}, {}, "Shorten the brief"),
            ({"family": "gguf", "native_context_tokens": 8192}, {}, "Context → Custom"),
            ({"family": "gguf", "native_context_tokens": 4096}, {}, "model's context limit"),
            ({"family": "external"}, {"supports_custom_context": True, "native_context_tokens": 8192}, "Context → Custom"),
            ({"family": "external"}, {}, "llama.cpp server"),
            ({"family": "api"}, {}, "Shorten the brief"),
        ]
        for model, overrides, expected in cases:
            with self.subTest(model=model, overrides=overrides), self.assertRaises(ModelError) as failure:
                run_h3_pipeline({**model, "capabilities": {}}, item, "session", {**plan, **overrides},
                                complete=Mock(), count_text_tokens=lambda _: 3000,
                                is_cancelled=lambda: False, thinking=False, seed=None)
            details = failure.exception.details
            self.assertIn(expected, details["suggestion"])
            self.assertEqual(details["required_context_tokens"], 4096 + details["excess_tokens"])
            if expected.startswith("Context") or expected == "llama.cpp server":
                self.assertIn(f'{details["required_context_tokens"]:,}', details["suggestion"])
                self.assertNotIn("Shorten", details["suggestion"])
            else:
                self.assertNotIn("In Settings", details["suggestion"])

    def test_long_brief_survives_sequence_validation(self):
        state = draft()
        state["brief"] = "Keep the same scene throughout. " * 1000
        self.assertEqual(validate_sequence(body(state))["brief"], state["brief"])

    def test_only_whole_response_fence_is_removed_without_rewriting_prompt(self):
        prompt="integrated_multimodal_description: [Shot 1] Literal {text}.\n\noverall_soundscape: Room.\n\nnon_diegetic_music: N/A"
        for wrapper in ["```text\n{}\n```", "```\n{}\n```"]:
            self.assertEqual(plain_chunk_prompt(wrapper.format(prompt),"T2VA",10),prompt)
        self.assertEqual(plain_chunk_prompt(prompt,"T2VA",10),prompt)
        commentary="Here is the prompt:\n```text\n"+prompt+"\n```"
        for invalid in [commentary, "```text\nmissing H3 content\n```", prompt.replace("overall_soundscape: Room.",""), prompt.replace("non_diegetic_music: N/A", "non_diegetic_music:")]:
            with self.assertRaises(ModelError):plain_chunk_prompt(invalid,"T2VA",10)
        with self.assertRaises(ModelError):plain_chunk_prompt(prompt,"I2VA",10)

    def test_local_timestamp_cleanup_never_changes_content_or_guesses_time(self):
        text='At 05:000 she turns. By 10:000 she sits. "At 05:000" stays visible. <d>At 05:000</d>'
        expected='At 00:05.000 she turns. By 00:10.000 she sits. "At 05:000" stays visible. <d>At 05:000</d>'
        self.assertEqual(normalize_local_timestamps(text,10),expected)
        self.assertEqual(normalize_local_timestamps(expected,10),expected)
        self.assertEqual(normalize_local_timestamps("Between 00:500 and 01:250",10),"Between 00:00.500 and 00:01.250")
        for raw in ["At 25:000", "At 05:25", "At 00:25.000", "At 00:60.000", "At 10:001"]:
            with self.subTest(raw=raw),self.assertRaises(ModelError):normalize_local_timestamps(raw,10)
        self.assertEqual(normalize_local_timestamps("Display code 05:000",10),"Display code 05:000")
        for quote in ['“At 05:000”', '‘At 05:000’', "'At 05:000'"]:
            self.assertEqual(normalize_local_timestamps(quote,10),quote)

    def test_two_part_local_timestamp_requires_one_in_range_interpretation(self):
        for raw, expected in [("At 05:00", "At 00:05.000"), ("By 10:00", "By 00:10.000"),
                              ("From 00:00 to 05:00", "From 00:00.000 to 00:05.000")]:
            self.assertEqual(normalize_local_timestamps(raw, 10), expected)
        for raw, duration in [("At 05:00", 4), ("At 05:00", 300), ("At 05:50", 10), ("At 00:05", 10)]:
            with self.subTest(raw=raw, duration=duration), self.assertRaises(ModelError):
                normalize_local_timestamps(raw, duration)
        literal = 'The clock reads "At 05:00". <d>At 05:00</d>'
        self.assertEqual(normalize_local_timestamps(literal, 10), literal)

    def test_context_and_explicit_edit_sources(self):
        state=draft(); state["chunks"][0]["prompt"]="manual predecessor";state["chunks"][2]["prompt"]="manual successor"
        request=body(state); assembled=assemble_chunk(state,1,request,{})
        text=assembled["messages"][-1]["content"]
        self.assertIn("C3 · 20–30s",text);self.assertIn("manual predecessor",text);self.assertIn("manual successor",text)
        request.update(action="refine",chunk_id="c1",instruction="Slow down")
        state["chunks"][1]["prompt"]="edited current prompt"
        text=assemble_chunk(state,1,request,{})["messages"][-1]["content"]
        for phrase in ("manual predecessor","manual successor","edited current prompt","Slow down"):self.assertIn(phrase,text)
        self.assertEqual(state["chunks"][0]["prompt"],"manual predecessor")

    def test_local_horizon_preserves_actual_predecessor_evidence(self):
        state=draft(4)
        state["chunks"][0]["prompt"]="subject_definitions: Person in cream.\ndetailed_description: She reaches the window. She turns. She steps toward the chair."
        text=assemble_chunk(state,2,body(state),{})["messages"][-1]["content"]
        for phrase in ["3 of 4 (middle)","Global range: 20–30s", "output timeline: 0–10s", "t - 20", "Remaining after this clip: 10s", "Gap before current clip: 10s"]:
            self.assertIn(phrase,text)
        self.assertLess(text.index("Person in cream."),text.index("CURRENT TARGET"))
        self.assertIn(state["instructions"],text)
        state["brief"]="PRECEDING CLIP CONTEXT is literal user prose."
        single=draft(1); single["brief"]=state["brief"]
        text=assemble_chunk(single,0,body(single),{})["messages"][-1]["content"]
        self.assertIn("CREATIVE BRIEF (whole sequence)\n"+single["brief"],text)
        self.assertNotIn("match the supplied last frame",text)

    def test_temporal_intent_stays_raw_with_only_objective_interval_boundaries(self):
        from backend.sequence import timeline
        state = draft()
        state["brief"] = "At 6 seconds she stops; halfway through the second interval she turns."
        state["chunks"][1]["instruction"] = "Pause near the end of this interval."
        request = body(state)
        payload = json.loads(assemble_plan(state, request, [0, 1, 2], timeline(state))["messages"][-1]["content"])
        self.assertEqual(payload["brief"], state["brief"])
        self.assertEqual([row["global_seconds"] for row in payload["intervals"]], [[0, 10], [10, 20], [20, 30]])
        self.assertEqual(payload["intervals"][1]["direction"], state["chunks"][1]["instruction"])
        self.assertTrue(all("timing" not in row for row in payload["intervals"]))
        text = assemble_chunk(state, 1, request, {})["messages"][-1]["content"]
        self.assertIn(state["brief"], text)
        self.assertNotIn("EXPLICIT EVENT TIMING", text)

    def test_limits_and_profiles(self):
        state=draft(1)
        state["chunks"][0]["duration"]=16
        with self.assertRaises(AssemblyError):validate_sequence(body(state))
        state["chunks"][0]["duration"]=15
        self.assertEqual(validate_sequence(body(state))["chunks"][0]["duration"],15)
        for first,last,refs,mode in [(None,None,[],"T2VA"),("a",None,[],"I2VA"),(None,"a",[],"L2VA"),("a","b",[],"FL2VA"),("a","b",["r"],"Reference")]:
            state.update(first=first,last=last,references=refs);self.assertEqual(conditioning(state,0)[0],mode)
            media={id:{"asset":{},"public":{"id":id,"filename":id+".png","type":"image","content_url":"/media/"+id},"uri":"frozen"} for id in ["a","b","r"]}
            result=assemble_chunk(state,0,body(state),media)
            self.assertEqual(result["guide"]["id"],"reference" if refs else "base")
            if not refs:self.assertEqual([a["reference"] for a in result["input"]["media_manifest"]["assets"]],[f"<Picture {i+1}>" for i,_ in enumerate(conditioning(state,0)[1])])
            else:self.assertEqual([(a["id"],a["reference"]) for a in result["input"]["media_manifest"]["assets"]],[("a","<Picture 1>"),("r","<Picture 2>"),("b","<Picture 3>")])

    def test_local_time_instruction_and_warning_explain_minutes_and_seconds(self):
        from backend.sequence_repair import attention_message
        state = draft(1)
        item = assemble_chunk(state, 0, body(state), {})
        text = item["messages"][-1]["content"]
        self.assertIn("Five seconds is 00:05.000", text)
        self.assertIn("05:00.000 means five minutes", text)
        with self.assertRaises(ModelError) as failure:
            normalize_local_timestamps("At 05:00.000 she laughs.", 10)
        warning = attention_message(failure.exception, item)
        self.assertIn("00:05.000", warning)
        self.assertIn("five minutes", warning)
        self.assertNotIn("check the required H3 form", warning)

    def test_conditioning_mapping_and_revision_bytes(self):
        state=draft();state.update(first="f",last="l",references=["a","b"])
        state["chunks"][1].update(exclusions=["a"],additions=["c"])
        assets={key:dict(id=key,type="image",filename=key+".png",content_url="/media/"+key,content_revision=1,prepared_width=512,prepared_height=512) for key in ["a","b","c","f","l"]}
        with patch("backend.sequence.STORE") as store, patch("backend.sequence._asset_data_uri",side_effect=lambda *args:"bytes-v1-"+args[1]):
            store.get.side_effect=lambda session,key:assets[key];store.public.side_effect=lambda a:copy.deepcopy(a)
            snapshot=snapshot_media(state,"sequence-test")
        assets["b"]["content_revision"]=2
        middle=assemble_chunk(state,1,body(state),snapshot)
        self.assertEqual([a["id"] for a in middle["input"]["media_manifest"]["assets"]],["b","c"])
        self.assertEqual([a["reference"] for a in middle["input"]["media_manifest"]["assets"]],["<Picture 1>","<Picture 2>"])
        self.assertEqual(middle["media_inputs"][0]["snapshot_uri"],"bytes-v1-b")
        self.assertEqual(middle["media_inputs"][0]["snapshot_asset"]["content_revision"],1)
        first=assemble_chunk(state,0,body(state),snapshot);last=assemble_chunk(state,2,body(state),snapshot)
        self.assertEqual(first["input"]["media_manifest"]["assets"][0]["conditioning"],"First frame")
        self.assertEqual(last["input"]["media_manifest"]["assets"][-1]["conditioning"],"Last frame")
        self.assertEqual(first["input"]["media_manifest"]["assets"][0]["reference"],"<Picture 1>")
        self.assertEqual([(a["id"],a["reference"]) for a in first["input"]["media_manifest"]["assets"]],[("f","<Picture 1>"),("a","<Picture 2>"),("b","<Picture 3>")])
        self.assertEqual([(a["id"],a["reference"]) for a in last["input"]["media_manifest"]["assets"]],[("a","<Picture 1>"),("b","<Picture 2>"),("l","<Picture 3>")])
        with self.assertRaises(ModelError):validate_media_capabilities({"family":"api","capabilities":{"images":False}},middle)

    def test_refine_uses_current_local_media_direction_and_manual_prompt(self):
        state=draft();request=body(state)
        before=assemble_chunk(state,1,request,{})
        self.assertEqual(before["input"]["mode"],"T2VA")
        state["chunks"][1].update(additions=["new"],instruction="Persistent direction now",prompt="MANUAL CURRENT VERSION")
        request.update(action="refine",chunk_id="c1",instruction="One-time refinement")
        media={"new":{"asset":{"type":"image"},"public":{"id":"new","filename":"new.png","type":"image","content_url":"/new"},"uri":"new-media-bytes"}}
        result=assemble_chunk(state,1,request,media)
        text=result["messages"][-1]["content"]
        for value in ["Persistent direction now","MANUAL CURRENT VERSION","One-time refinement",state["brief"]]:self.assertIn(value,text)
        self.assertEqual(result["media_inputs"][0]["snapshot_uri"],"new-media-bytes")
        self.assertEqual(result["input"]["mode"],"Reference")
        request["action"]="generate"
        regenerated=assemble_chunk(state,1,request,media)["messages"][-1]["content"]
        self.assertIn("Persistent direction now",regenerated)
        self.assertNotIn("MANUAL CURRENT VERSION",regenerated)
        self.assertNotIn("One-time refinement",regenerated)

    def test_plain_completed_output_no_audit_or_reroll(self):
        assembled=assemble_chunk(draft(),0,body(),{})
        plan={"context_tokens":100000,"max_output_tokens":2048}
        model={"family":"gguf","capabilities":{"images":False}}
        for finish in ["stop","length",None]:
            complete=Mock(return_value={"choices":[{"finish_reason":finish,"message":{"content":"Unusual but completed plain text"}}]})
            with patch("backend.h3_pipeline._audit",side_effect=AssertionError("no semantic validation")):
                if finish=="stop":
                    result=run_h3_pipeline(model,assembled,"sequence-test",plan,complete=complete,count_text_tokens=lambda s:len(s)//4,is_cancelled=lambda:False,thinking=False,seed=None)
                    self.assertEqual(result["prompt"],"Unusual but completed plain text")
                else:
                    with self.assertRaises(ModelError):run_h3_pipeline(model,assembled,"sequence-test",plan,complete=complete,count_text_tokens=lambda s:len(s)//4,is_cancelled=lambda:False,thinking=True,seed=None)
            self.assertEqual(complete.call_count,1)


class SequencePlanTests(unittest.TestCase):
    def plan(self):
        return dict(steps=[
            dict(progression="reach window", ending="standing at window"),
            dict(progression="look outside", ending="still standing at window"),
            dict(progression="walk to chair and sit", ending="seated")])

    def test_plan_is_text_only_and_preserves_fixed_edits_without_stale_all_outputs(self):
        state=draft();state.update(first="first-id",last="last-id",references=["face-id"])
        for i,c in enumerate(state["chunks"]):c["prompt"]=f"manual {i}"
        request=body(state);request.update(action="refine",chunk_id="c1",instruction="Turn slowly")
        from backend.sequence import timeline
        assembled=assemble_plan(state,request,[1],timeline(state))
        self.assertEqual(assembled["media_inputs"],[])
        self.assertEqual(assembled["completion_policy"],"single_call")
        payload=json.loads(assembled["messages"][-1]["content"])
        self.assertEqual(payload["intervals"][0]["KEEP existing prompt"],"manual 0")
        self.assertEqual(payload["intervals"][1]["refinement"],"Turn slowly")
        self.assertEqual(payload["intervals"][2]["KEEP existing prompt"],"manual 2")
        request["action"]="all"
        text=assemble_plan(state,request,[0,1,2],timeline(state))["messages"][-1]["content"]
        for i in range(3):self.assertNotIn(f"manual {i}",text)

    def test_boundary_is_derived_and_schedule_never_changes_guide_or_media(self):
        plan=self.plan();self.assertEqual(parse_plan(json.dumps(plan),3),plan["steps"])
        self.assertEqual(parse_plan("```json\n"+json.dumps(plan)+"\n```",3),plan["steps"])
        plan=dict(enumerate(plan["steps"]));text=interval_context(plan,1)
        self.assertNotIn("reach window",text)
        self.assertIn("Intended ending: still standing at window",text)
        state=draft();request=body(state)
        original=assemble_chunk(state,1,request,{})
        planned=assemble_chunk(state,1,request,{},plan)
        for key in ["guide","input","media_inputs","completion_policy"]:self.assertEqual(planned[key],original[key])
        self.assertIn(text,planned["messages"][-1]["content"])
        self.assertNotIn("action_plan",state)

    def test_planner_errors_identify_the_actual_contract_problem(self):
        for raw, count, reason, wording in [
            ('{"steps":[{"progression":"walk","ending":"window"}]}', 2, "step_count", "1 of 2"),
            ('{"steps":[{"progression":"walk"}]}', 1, "missing_field", "ending for planning step 1"),
            ('{"steps":[', 1, "invalid_json", "unreadable planning format"),
            ('{"steps":[],"steps":[]}', 1, "duplicate_field", "ambiguous"),
        ]:
            with self.subTest(reason=reason), self.assertRaises(ModelError) as error:
                parse_plan(raw, count)
            self.assertEqual(error.exception.details["reason"], reason)
            self.assertIn(wording, error.exception.message)
            self.assertIn("Run Generate Sequence again", error.exception.message)

    def test_unsupported_fields_report_only_the_unexpected_keys(self):
        raw = {"steps": [{"progression": "wait", "ending": "waiting"},
                         {"progression": "turn", "ending": "facing window", "interval": 2, "timing": "middle"}]}
        with self.assertRaises(ModelError) as error:
            parse_plan(json.dumps(raw), 2)
        self.assertEqual(error.exception.details, {"stage": "planning", "reason": "extra_fields",
                         "expected_steps": 2, "step": 2, "fields": ["timing"]})
        self.assertIn("The model added unsupported fields", error.exception.message)
        self.assertIn("Run Generate Sequence again", error.exception.message)

    def test_redundant_interval_is_only_removed_when_it_matches_the_requested_target(self):
        raw = '{"steps":[{"progression":"wait","ending":"still waiting","interval":3}]}'
        self.assertEqual(parse_plan(raw, 1, [3]), [{"progression":"wait", "ending":"still waiting"}])
        for value in [2, True, "3"]:
            malformed = json.loads(raw); malformed["steps"][0]["interval"] = value
            with self.assertRaises(ModelError) as error: parse_plan(json.dumps(malformed), 1, [3])
            self.assertEqual(error.exception.details["reason"], "interval_mismatch")

    def test_invalid_plans_fail_without_semantic_recovery(self):
        invalid=["not JSON", "{}", "[]", json.dumps({**self.plan(),"steps":[]}), json.dumps({**self.plan(),"extra":1}),
                 json.dumps(self.plan()).replace('"steps":', '"steps":[],"steps":')]
        for key,value in [("progression",""),("ending",None),("ending","x"*4001)]:
            plan=self.plan();plan["steps"][0][key]=value;invalid.append(json.dumps(plan))
        for raw in invalid:
            with self.subTest(raw=raw[:60]),self.assertRaises(ModelError) as error:parse_plan(raw,3)
            self.assertEqual(error.exception.code,"INVALID_SEQUENCE_PLAN")


class SequenceBatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_sequence_shares_writer_lease_without_touching_single_generation_cache(self):
        from backend import routes
        services, calls, _, _ = self.services()
        services._claim_generation_request = routes._claim_generation_request
        services._release_generation_request = routes._release_generation_request
        cached = {("single-session", "T2VA"): {"prompt": "manual Single prompt"}}
        with patch.dict(routes.STATE, active_request_id=None, media_mutation_active=False), patch.dict(routes.GENERATION_CACHE, cached, clear=True):
            other = routes._claim_generation_request()
            async def emit(event):
                if event["type"] == "started":
                    self.assertIsNone(routes._claim_generation_request())
                    self.assertFalse(routes._claim_media_mutation())
            with self.assertRaises(ModelError) as error:
                await run_sequence(body(), services, emit)
            self.assertEqual(error.exception.code, "GENERATION_BUSY")
            self.assertEqual(routes.STATE["active_request_id"], other)
            self.assertEqual(calls, [])
            routes._release_generation_request(other)
            await run_sequence(body(draft(1)), services, emit)
            self.assertIsNone(routes.STATE["active_request_id"])
            self.assertEqual(routes.GENERATION_CACHE, cached)
            self.assertTrue(routes._claim_media_mutation())
            routes._release_media_mutation()

    async def test_regenerate_all_uses_new_predecessors_and_one_runtime(self):
        services,calls,unloads,_=self.services();state=draft();events=[]
        for c in state["chunks"]:c["prompt"]="old "+c["id"]
        request=body(state);request.update(action="all")
        async def emit(event):events.append(event)
        await run_sequence(request,services,emit)
        self.assertEqual(self.prepare_count,1);self.assertEqual(len(self.plan_calls),1);self.assertEqual(len(calls),3)
        self.assertEqual(unloads,["batch"])
        self.assertEqual([e["chunk_id"] for e in events if e["type"]=="chunk"],["c0","c1","c2"])
        self.assertIn("prompt 1",calls[1][1]["messages"][-1]["content"])
        self.assertNotIn("old c0",calls[1][1]["messages"][-1]["content"])
        self.assertIn("prompt 2",calls[2][1]["messages"][-1]["content"])
        self.assertEqual(state["chunks"][0]["prompt"],"old c0")

    async def test_planning_failure_or_cancellation_writes_no_chunks_and_releases_lease(self):
        for cancel in (False,True):
            services,calls,unloads,_=self.services();events=[]
            original=services._run_thread_worker
            async def worker(function,*args,**kwargs):
                if len(args)>1 and isinstance(args[1],dict) and args[1].get("sequence_stage")=="plan":
                    self.cancelled=cancel
                    return {"prompt":"invalid JSON"},None
                return await original(function,*args,**kwargs)
            services._run_thread_worker=worker
            async def emit(event):events.append(event)
            with self.assertRaises(ModelError) as error:await run_sequence(body(),services,emit)
            self.assertEqual(error.exception.code,"GENERATION_CANCELLED" if cancel else "INVALID_SEQUENCE_PLAN")
            self.assertEqual(calls,[]);self.assertEqual(unloads,["batch"]);self.assertEqual(self.releases,["lease"])
            self.assertFalse(any(e["type"]=="chunk" for e in events));self.assertFalse(ACTIVE_OPERATIONS)

    async def test_cleanup_precedes_validation_and_unrepairable_output_is_kept_with_attention(self):
        services,calls,unloads,_=self.services();events=[]
        original=services._run_thread_worker
        async def worker(function,*args,**kwargs):
            result,cancel=await original(function,*args,**kwargs)
            if len(args)>1 and isinstance(args[1],dict) and args[1].get("sequence_stage")!="plan":
                result["prompt"]="```text\n"+result["prompt"].replace("prompt 1", "She walks. At 05:000 she turns")+"\n```" if len(calls)==1 else "missing H3 fields"
            return result,cancel
        services._run_thread_worker=worker
        async def emit(event):events.append(event)
        await run_sequence(body(),services,emit)
        output=[e for e in events if e["type"]=="chunk"]
        self.assertEqual(output[-1]["prompt"],"missing H3 fields")
        self.assertIn("model",output[-1]["attention"])
        accepted=[e for e in output if not e.get("attention")]
        self.assertEqual(len(accepted),1);self.assertIn("At 00:05.000",accepted[0]["prompt"])
        self.assertNotIn("```",accepted[0]["prompt"])
        self.assertIn(accepted[0]["prompt"],calls[1][1]["messages"][-1]["content"])
        self.assertEqual(len(calls),2);self.assertEqual(len(self.plan_calls),1)
        self.assertEqual(unloads,["batch"]);self.assertEqual(self.releases,["lease"])

    async def test_single_chunk_and_completed_sequence_need_no_planning_call(self):
        services,calls,_,_=self.services();events=[]
        async def emit(event):events.append(event)
        state=draft(1)
        await run_sequence(body(state),services,emit)
        self.assertEqual(self.plan_calls,[]);self.assertEqual(len(calls),1)
        state["chunks"][0]["prompt"]="already done"
        await run_sequence(body(state),services,emit)
        self.assertEqual(self.prepare_count,1);self.assertEqual(len(calls),1)

    async def test_reference_contract_repair_is_one_owned_call_and_preserves_content(self):
        from tests.test_sequence_output import reference, ASSETS
        good = reference()
        broken = good.replace("<Subject 1> is the person", "The person").replace("<Picture 1> is the first frame of [Shot 1].", "").replace("keyframe completion + reference generation", "video continuation")
        for outcome in ("valid", "repaired", "invalid", "changed", "runtime"):
            with self.subTest(outcome=outcome):
                services, calls, unloads, model = self.services()
                model["capabilities"]["images"] = True
                item = assemble_chunk(draft(1), 0, body(draft(1)), {})
                item["input"]["mode"] = "Reference"
                item["input"]["media_manifest"]["assets"] = ASSETS
                original = services._run_thread_worker
                async def worker(function, *args, **kwargs):
                    result, cancel = await original(function, *args, **kwargs)
                    if len(args) > 1 and isinstance(args[1], dict):
                        repair = args[1].get("sequence_stage") == "repair"
                        if repair and outcome == "runtime":
                            raise ModelError("CONNECTION_FAILED", "Provider disconnected")
                        result["prompt"] = (good if outcome == "valid" or repair and outcome == "repaired" else
                                            good.replace("then turns away", "then dances") if repair and outcome == "changed" else broken)
                    return result, cancel
                services._run_thread_worker = worker
                events = []
                async def emit(event): events.append(event)
                with patch("backend.sequence_routes.assemble_chunk", return_value=item):
                    if outcome == "runtime":
                        with self.assertRaisesRegex(ModelError, "Chunk 1 failed"):
                            await run_sequence(body(draft(1)), services, emit)
                    else:
                        await run_sequence(body(draft(1)), services, emit)
                chunks = [e for e in events if e["type"] == "chunk"]
                self.assertEqual(len(chunks), 1)
                self.assertEqual(len(calls), 1 if outcome == "valid" else 2)
                self.assertEqual(self.plan_calls, [])
                self.assertEqual(unloads, ["batch"])
                self.assertEqual(self.releases, ["lease"])
                self.assertTrue(all(not call[2]["unload_after"] for call in calls))
                if outcome in {"valid", "repaired"}:
                    self.assertEqual(chunks[0]["prompt"], good)
                    self.assertNotIn("attention", chunks[0])
                else:
                    self.assertIn("model", chunks[0]["attention"])
                    self.assertTrue(chunks[0]["prompt"])
                if outcome != "valid":
                    repair = calls[-1][1]
                    self.assertEqual(repair["input"], item["input"])
                    self.assertEqual(repair["media_inputs"], item["media_inputs"])
                    self.assertEqual(repair["completion_policy"], "single_call")
                    content = repair["messages"][-1]["content"]
                    for term in ["original_prompt", "First frame", "<Picture 2>", "standalone frame definition", "Subject is used without its own definition", "Preserve scene facts"]:
                        self.assertIn(term, content)
                    self.assertNotIn("SEQUENCE HORIZON", content)
                    self.assertTrue(any(e.get("phase") == "repairing" for e in events))

    async def test_cancel_before_repair_prevents_the_extra_call_and_unloads_once(self):
        from tests.test_sequence_output import reference, ASSETS
        services, calls, unloads, model = self.services()
        model["capabilities"]["images"] = True
        item = assemble_chunk(draft(1), 0, body(draft(1)), {})
        item["input"]["mode"] = "Reference"
        item["input"]["media_manifest"]["assets"] = ASSETS
        original = services._run_thread_worker
        async def worker(function, *args, **kwargs):
            result, cancel = await original(function, *args, **kwargs)
            if len(args) > 1: result["prompt"] = reference().replace("<Picture 1> is the first frame of [Shot 1].", "")
            return result, cancel
        services._run_thread_worker = worker
        async def emit(event):
            if event.get("phase") == "repairing": self.cancelled = True
        with patch("backend.sequence_routes.assemble_chunk", return_value=item), self.assertRaises(ModelError) as error:
            await run_sequence(body(draft(1)), services, emit)
        self.assertEqual(error.exception.code, "GENERATION_CANCELLED")
        self.assertEqual(len(calls), 1)
        self.assertEqual(unloads, ["batch"])
        self.assertEqual(self.releases, ["lease"])

    async def test_warning_chunk_is_a_missing_generation_target(self):
        services, calls, _, _ = self.services()
        state = draft(1)
        state["chunks"][0].update(prompt="model output", attention="needs a binding")
        async def emit(event): pass
        await run_sequence(body(state), services, emit)
        self.assertEqual(len(calls), 1)

    async def test_targeted_cancel_cannot_cancel_a_later_operation(self):
        handlers={}
        class Registry:
            def post(self,path):
                def register(handler):handlers[path]=handler;return handler
                return register
        backend=SimpleNamespace(cancel=Mock())
        state={"active_request_id":"lease-2","selected_model_family":"gguf","cancel_requested":False}
        async def json_body(request):return request
        services=SimpleNamespace(ROUTE_PREFIX="/writer",STATE_LOCK=threading.RLock(),STATE=state,BACKENDS={"gguf":backend},_json_body=json_body)
        register_sequence_routes(Registry(),services)
        ACTIVE_OPERATIONS["operation-2"]=("lease-2","session")
        try:
            handler=handlers["/writer/sequence/cancel"]
            for request in [{"operation_id":"operation-1","session_id":"session"},{"operation_id":"operation-2","session_id":"other"}]:
                response=await handler(request);self.assertFalse(json.loads(response.text)["cancelled"])
            backend.cancel.assert_not_called();self.assertFalse(state["cancel_requested"])
            response=await handler({"operation_id":"operation-2","session_id":"session"})
            self.assertTrue(json.loads(response.text)["cancelled"]);backend.cancel.assert_called_once()
        finally:ACTIVE_OPERATIONS.clear()

    def services(self, failure=None):
        calls=[];unloads=[];self.cancelled=False;self.prepare_count=0;self.releases=[];self.plan_calls=[]
        model={"id":"model-A","family":"gguf","capabilities":{"images":False}}
        def generate(model,item,session,**kwargs):
            if item.get("sequence_stage") == "plan":
                self.plan_calls.append((copy.deepcopy(model),item,kwargs))
                count=sum(i["generate"] for i in json.loads(item["messages"][-1]["content"])["intervals"])
                return {"prompt":json.dumps(dict(steps=[dict(progression=f"move {i}",ending=f"place {i}") for i in range(count)]))}
            calls.append((copy.deepcopy(model),item,kwargs))
            try:
                if failure and len(calls) == 2:
                    raise failure
                return {"prompt":f"integrated_multimodal_description: [Shot 1] prompt {len(calls)}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A"}
            finally:
                if kwargs["unload_after"]:unloads.append("provider")
        backend=SimpleNamespace(generate=generate,cancel=lambda:None,unload=lambda:unloads.append("batch"))
        async def prepare(*args):self.prepare_count+=1;return model,backend,{"context_tokens":65536,"max_output_tokens":2048}
        async def worker(function,*args,**kwargs):kwargs.pop("on_cancel",None);return function(*args,**kwargs),None
        services=SimpleNamespace(_claim_generation_request=lambda:"lease",_prepare_generation_runtime=prepare,_run_thread_worker=worker,
            _request_cancelled=lambda identity:self.cancelled,_propagate_worker_cancellation=lambda c:None,_set_request_phase=lambda *a:None,
            _release_generation_request=lambda identity:self.releases.append(identity))
        return services,calls,unloads,model

    async def test_missing_order_completed_preserved_one_prepare_and_cleanup(self):
        services,calls,unloads,model=self.services();state=draft();state["chunks"][0]["prompt"]="manual first";events=[]
        async def emit(event):
            events.append(event)
            if event["type"]=="chunk":model["id"]="late discovery model B"
        await run_sequence(body(state),services,emit)
        self.assertEqual(self.prepare_count,1);self.assertEqual(len(calls),2);self.assertEqual(unloads,["batch"])
        self.assertTrue(all(call[0]["id"]=="model-A" for call in calls))
        self.assertIn("manual first",calls[0][1]["messages"][-1]["content"])
        self.assertIn("prompt 1",calls[1][1]["messages"][-1]["content"])
        self.assertEqual([e["chunk_id"] for e in events if e["type"]=="chunk"],["c1","c2"])
        self.assertEqual(self.releases,["lease"]);self.assertFalse(ACTIVE_OPERATIONS)

    async def test_cancel_keeps_completed_and_stops_before_next(self):
        services,calls,unloads,_=self.services();events=[]
        async def emit(event):
            events.append(event)
            if event["type"]=="chunk":self.cancelled=True
        with self.assertRaises(ModelError):await run_sequence(body(),services,emit)
        self.assertEqual(len(calls),1);self.assertEqual(unloads,["batch"])
        self.assertEqual(len([e for e in events if e["type"]=="chunk"]),1)

    async def test_failure_preserves_earlier_chunk_and_cleans_once(self):
        failure = ModelError("CONTEXT_BUDGET_EXCEEDED", "Request exceeds context by 512 tokens.",
                             {"context_tokens": 8192, "excess_tokens": 512})
        services,calls,unloads,_=self.services(failure=failure);events=[]
        async def emit(event):events.append(event)
        with self.assertRaisesRegex(ModelError, "Chunk 2 failed") as raised:
            await run_sequence(body(),services,emit)
        self.assertEqual(raised.exception.code, failure.code)
        self.assertEqual(raised.exception.details, {**failure.details, "chunk_id": "c1", "chunk_index": 2})
        self.assertEqual(len(calls),2);self.assertEqual(unloads,["batch"])
        self.assertEqual([e["chunk_id"] for e in events if e["type"]=="chunk"],["c0"])

    async def test_refine_selected_only_and_keep_loaded(self):
        services,calls,unloads,_=self.services();state=draft()
        for c in state["chunks"]:c["prompt"]="manual "+c["id"]
        request=body(state,unload_after=False);request.update(action="refine",chunk_id="c1",instruction="Slower camera")
        events=[]
        async def emit(e):events.append(e)
        await run_sequence(request,services,emit)
        self.assertEqual(len(calls),1);self.assertEqual(unloads,[])
        self.assertEqual([e["chunk_id"] for e in events if e["type"]=="chunk"],["c1"])
        for text in ["manual c0","manual c1","manual c2","Slower camera"]:self.assertIn(text,calls[0][1]["messages"][-1]["content"])

if __name__=="__main__":unittest.main()
