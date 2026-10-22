import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { draftFile, draftFilename, parseDraft } from "../web/draft_files.js";
import { newSequence } from "../web/sequence_state.js";
import { buildGeneratePayload, buildRefinePayload } from "../web/studio_state.js";
import { msg } from "../web/i18n.js";

test("draft filenames identify the workspace and local save time",()=>{
  const now = new Date(2026,8,21,14,3,8);
  assert.equal(draftFilename("sequence",now),"h3-sequence-2026-09-21_14-03-08.json");
  assert.equal(draftFilename("single",now),"h3-single-2026-09-21_14-03-08.json");
});

test("Save downloads a loadable draft with a timestamp and no model configuration",async()=>{
  const source=await readFile(new URL("../web/main.js",import.meta.url),"utf8");
  const saveSource=source.slice(source.indexOf("function saveTextDraft("),source.indexOf("async function loadTextDraft("));
  for(const kind of ["single","sequence"]) {
    let blob,clicked=false;
    const link={click(){clicked=true;}};
    const state={mode:"Reference",assets:[{id:"a",mode:"Reference",reference:"<Picture 1>",filename:"portrait.png"}],
      sequence:{active:kind === "sequence",state:newSequence()},customSystemPrompts:{reference:"Custom instructions"},
      durationSeconds:8,aspectRatio:"9:16",apiKey:"not exported"};
    const save=new Function("studio","currentDraftFields","draftFile","draftFilename","Blob","URL","document","setTimeout","showToast",saveSource+";return saveTextDraft;")(
      state,()=>({brief:"Test brief",prompt:"Test prompt"}),draftFile,draftFilename,Blob,
      {createObjectURL(value){blob=value;return "blob:test";},revokeObjectURL(){}},
      {createElement(){return link;}},fn=>fn(),()=>assert.fail("Save must succeed"));
    save();
    assert.equal(clicked,true);
    assert.match(link.download,new RegExp(`^h3-${kind}-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.json$`));
    const encoded=await blob.text(), loaded=parseDraft(encoded);
    assert.equal(loaded.kind,kind);
    assert.deepEqual(loaded.media,["<Picture 1>: portrait.png"]);
    assert.ok(!encoded.includes("not exported"));
  }
});

test("portable Sequence drafts preserve text and timing but strip live media and history",()=>{
  const state=newSequence(); state.first="old-asset";state.references=["old-asset"];
  state.chunks[0].additions=["old-asset"];state.chunks[0].prompt="Use <Picture 1>";state.chunks[0].undo=["old"];
  const loaded=parseDraft(JSON.stringify(draftFile("sequence",state,["First frame: portrait.png"])));
  assert.equal(loaded.content.chunks[0].prompt,state.chunks[0].prompt);
  assert.equal(loaded.content.first,null);assert.deepEqual(loaded.content.references,[]);
  assert.deepEqual(loaded.content.chunks[0].additions,[]);assert.deepEqual(loaded.content.chunks[0].undo,[]);
  assert.notEqual(loaded.content.chunks[0].id,state.chunks[0].id);
  assert.deepEqual(loaded.media,["First frame: portrait.png"]);
});
test("Single drafts preserve instructions and validate before replacing anything",()=>{
  const content={mode:"Reference",aspectRatio:"9:16",duration:10,brief:"Hello",prompt:"Prompt",instructions:"Keep it brief",api_key:"secret"};
  const loaded=draftFile("single",content);
  assert.equal(loaded.content.instructions,"Keep it brief");assert.equal(loaded.content.api_key,undefined);
  assert.throws(()=>parseDraft('{broken'));
  assert.throws(()=>draftFile("single",{...content,duration:0}));
  assert.throws(()=>draftFile("single",{...content,mode:"bogus"}));
  assert.throws(()=>parseDraft(" ".repeat(2_000_001)));
  assert.equal(draftFile("single",{...content,instructions:"x".repeat(32000)}).content.instructions.length,32000);
});

test("a failed draft import leaves the workspace and prompts intact",async()=>{
  const source=await readFile(new URL("../web/main.js",import.meta.url),"utf8");
  const loadSource=source.slice(source.indexOf("async function loadTextDraft("),source.indexOf("function updateBriefLayout("));
  const phases=[],notices=[];
  const state={sessionId:"test",assets:[{id:"keep"}],sequence:{setActive(){assert.fail("Must not enter Sequence on failure");}}};
  const load=new Function("studio","clearMedia","setGenerationState","showToast","msg","showErrorToast",loadSource+";return loadTextDraft;")(
    state,async()=>{throw Error("Clear failed");},phase=>phases.push(phase),(...notice)=>notices.push(notice),msg,
    (title,error)=>notices.push([title,error.message]));
  await load({kind:"sequence"});
  assert.deepEqual(state.assets,[{id:"keep"}]);
  assert.deepEqual(phases,["busy","idle"]);
  assert.deepEqual(notices,[["toast.draft.load_failed.title","Clear failed"]]);
});
test("Ollama Generate and Refine carry manual output budget without Direct-only settings",()=>{
  const state={mode:"Reference",customSystemPrompts:{},selectedModel:{family:"ollama",remote_model:"test"},generationBudget:"custom",generationBudgetTokens:6000};
  for(const payload of [buildGeneratePayload(state,{creativeBrief:"x"}),buildRefinePayload(state,{currentPrompt:"y",instruction:"z"})]) {
    assert.equal(payload.generation_budget,6000);assert.equal(payload.context_tokens,undefined);assert.equal(payload.reasoning_effort,undefined);
  }
});


test("portable Single and Sequence drafts preserve long briefs",()=>{
  const brief="A quiet scene. ".repeat(3000);
  const single={mode:"T2VA",aspectRatio:"16:9",duration:10,brief,prompt:"",instructions:null};
  const sequence={...newSequence(),brief};
  for(const [kind,content] of [["single",single],["sequence",sequence]]) {
    assert.equal(parseDraft(JSON.stringify(draftFile(kind,content))).content.brief,brief);
  }
});
