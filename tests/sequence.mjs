import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { DEFAULT_SEQUENCE_INSTRUCTIONS, LEGACY_SEQUENCE_INSTRUCTIONS, newSequence, addChunk, deleteChunk, timeline, effectiveMedia, aggregate, saveSequence, loadSequence, duration, replacePrompt, revisePrompt, assignReference, removeReference, reconcileMedia, sequenceInputs } from "../web/sequence_state.js";
import { createSequenceController } from "../web/sequence_controller.js";
import { createSequenceWorkspace, displaySeparator, parseSeparator } from "../web/sequence_workspace.js";
import { configureI18n, setLanguagePreference } from "../web/i18n.js";
import { writeToastContent } from "../web/toast.js";
import { t } from "../web/i18n.js";

const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
const main=await readFile(new URL("../web/main.js",import.meta.url),"utf8");
const transport=await readFile(new URL("../web/api/sequence.js",import.meta.url),"utf8");
const transportContext=vm.createContext({TextDecoder,Uint8Array,readApiResponse:()=>{throw Error("HTTP failure");}});
vm.runInContext(transport.match(/^export async function readSequenceStream\([^]*?^}/m)[0].replace("export ",""),transportContext);

test("stream only delivers whole chunk messages, requires terminal completion",async()=>{
  for(const end of ["",'{"type":"chunk","prompt":"partial', '{"type":"done"}\n']) {
    const events=[];
    const text='{"type":"chunk","chunk_id":"c0","prompt":"completed"}\n'+end;
    const response=new Response(new ReadableStream({start(controller){
      for(const piece of [text.slice(0,15),text.slice(15)])controller.enqueue(new TextEncoder().encode(piece));controller.close();
    }}));
    const result=transportContext.readSequenceStream(response,event=>events.push(event));
    if(end.includes('"done"')) await result; else await assert.rejects(result,/before completion/);
    assert.deepEqual(events.filter(e=>e.type==="chunk").map(e=>e.prompt),["completed"]);
  }
});

test("early cancellation is re-sent on lease acquisition and commits only owned chunks",async()=>{
  const state=newSequence();addChunk(state);let emit,payload;const done=deferred();const cancelled=[];
  const controller=createSequenceController({state,snapshot:()=>({}),prepare:async()=>true,
    run:(p,cb)=>{payload=p;emit=cb;return done.promise;},cancel:id=>cancelled.push(id)});
  const operation=controller.start("generate",state.chunks[1].id);await Promise.resolve();
  emit({type:"chunk",operation_id:payload.operation_id,chunk_id:state.chunks[0].id,prompt:"wrong chunk"});
  assert.equal(state.chunks[0].prompt,"");
  controller.cancel();emit({type:"started",operation_id:payload.operation_id});done.resolve();await operation;
  assert.deepEqual(cancelled,[payload.operation_id,payload.operation_id]);
});

test("Sequence timeline, minimum one chunk, persistence and request-local media",()=>{
  const s=newSequence(); assert.equal(s.chunks.length,1);
  s.defaultDuration=14; addChunk(s); addChunk(s); s.chunks[1].duration=8;
  assert.deepEqual(timeline(s).map(c=>[c.start,c.end]),[[0,10],[10,18],[18,32]]);
  s.first="f"; s.last="l"; s.references=["a","b"];
  s.chunks[1].exclusions=["a"]; s.chunks[1].additions=["c"];
  const assets=["f","l","a","b","c"].map(id=>({id,type:"image"}));
  assert.deepEqual(effectiveMedia(s,s.chunks[1].id,assets).map(m=>[m.assetId,m.tag]),[["b","<Picture 1>"],["c","<Picture 2>"]]);
  assert.equal(effectiveMedia(s,s.chunks[0].id,assets)[0].role,"First frame");
  assert.equal(effectiveMedia(s,s.chunks[2].id,assets).at(-1).role,"Last frame");
  s.chunks[1].instruction="At 15s stand"; s.chunks[1].prompt="manual";
  const storage=new Map(); const io={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
  saveSequence(io,s); assert.deepEqual(loadSequence(io),s);
  assert.equal(aggregate(s),"manual");
  assert.equal(aggregate(s,{format:"headings"}),"Chunk 2 · 10–18s\nmanual");
  deleteChunk(s,s.chunks[0].id); assert.equal(s.chunks[0].prompt,"manual");
  deleteChunk(s,s.chunks[0].id); deleteChunk(s,s.chunks[0].id); assert.equal(s.chunks.length,1);
  assert.equal(duration(99),15);
});

test("late callbacks, cancel, workspace leave, replacement and config snapshots",async()=>{
  const state=newSequence(); addChunk(state);
  let config={model_id:"A"}, calls=[], busy=[], errors=[];
  const controller=createSequenceController({state,snapshot:()=>config,prepare:async()=>true,
    run:(payload,emit)=>{const pending=deferred();calls.push({payload,emit,pending});return pending.promise;},
    cancel:async()=>{},busyChanged:b=>busy.push(b),error:e=>errors.push(e)});
  const first=controller.start(); await Promise.resolve();
  config.model_id="B"; assert.equal(calls[0].payload.model_id,"A");
  const send=(call,index,text)=>call.emit({type:"chunk",operation_id:call.payload.operation_id,chunk_id:state.chunks[index].id,prompt:text});
  send(calls[0],0,"completed"); controller.cancel(); send(calls[0],1,"late");
  calls[0].pending.resolve(); await first; assert.equal(state.chunks[0].prompt,"completed"); assert.equal(state.chunks[1].prompt,"");
  const second=controller.start("generate",state.chunks[0].id); await Promise.resolve();
  send(calls[1],0,"new"); calls[1].pending.resolve(); await second;
  send(calls[0],0,"old"); assert.equal(state.chunks[0].prompt,"new");
  const third=controller.start(); await Promise.resolve(); controller.leave(); send(calls[2],1,"stale view");calls[2].pending.resolve();await third;
  assert.equal(state.chunks[1].prompt,"");assert.deepEqual(busy,[true,false,true,false,true,false]);assert.deepEqual(errors,[]);
});

test("snapshot failure and cancelled preparation release ownership",async()=>{
  let fail=true, errors=[]; const ready=deferred(); let runs=0;
  const c=createSequenceController({state:newSequence(),snapshot:()=>{if(fail)throw Error("no model");return{};},prepare:()=>ready.promise,run:()=>runs++,cancel:()=>{},error:e=>errors.push(e)});
  await c.start();assert.equal(c.busy,false);assert.equal(errors.length,1);
  fail=false;const pending=c.start();c.cancel();ready.resolve(true);await pending;assert.equal(runs,0);assert.equal(c.busy,false);
});

test("real DOM Add/Delete, shell sync and repeated workspace switches preserve DOM owners",async()=>{
  const window=new Window(); globalThis.document=window.document;
  const root=document.createElement("div");document.body.append(root);
  root.innerHTML=`<div data-workspace="video"></div><div data-video-modes></div><div data-music-inputs></div><span data-output-label></span><span data-output-mobile-label></span><textarea data-output>Single prompt</textarea><span data-copy-label></span><span data-refine-media-note></span><span data-refine-title></span><span data-refine-helper></span><textarea data-refine-instruction></textarea><div class="h3ps-workspace"><div data-video-inputs><div class="h3ps-section-actions"></div><div data-h3ps-media><div tabindex="0" data-asset-id="a"></div><div tabindex="0" data-asset-id="b"></div></div></div></div><button data-generate><span data-generate-label>Generate prompt</span></button>`;
  const studio={root,mode:"T2VA"};
  const context=vm.createContext({studio,t,rememberReferenceInsertTarget(){},toggleLyricsRefine(){},setMusicSystemPromptExpanded(){},syncModeAvailability(){},msg:(key,params)=>({key,params})});
  vm.runInContext(main.match(/^function syncGenerateLabel\(\)[^]*?^}/m)[0],context);
  vm.runInContext(main.match(/^function syncWorkspace\([^]*?^}/m)[0],context);
  const errors=[]; let busy=false, copied="";
  const assets=[{id:"a",filename:"portrait.png",type:"image",reference:"<Picture 7>"},{id:"b",filename:"room.png",type:"image",reference:"<Picture 8>"}];
  const pending=deferred();let callback,payload;
  const workspace=createSequenceWorkspace({root,icon:()=>"",storage:window.localStorage,assets:()=>assets,snapshot:()=>({model_id:"A"}),
    prepare:async()=>true,run:(p,cb)=>{payload=p;callback=cb;return pending.promise;},cancel:()=>{},isBusy:()=>busy,
    busy:b=>{busy=b;context.syncWorkspace();},refresh:()=>context.syncWorkspace(),copy:async text=>{copied=text;},error:e=>errors.push(e)});
  const label=root.querySelector("[data-generate-label]");
  const click=selector=>root.querySelector(selector).click();
  click('[data-seq-action="sequence"]');
  for(let i=0;i<3;i++){click('[data-seq-action="add"]');workspace.refresh();context.syncWorkspace();}
  assert.equal(workspace.state.chunks.length,4);
  click('[data-seq-action="delete"]');assert.equal(workspace.state.chunks.length,3);
  for(let i=0;i<3;i++){click('[data-seq-action="single"]');click('[data-seq-action="sequence"]');}
  assert.equal(workspace.active,true); assert.equal(root.querySelector("[data-generate-label]"),label);
  assert.equal(root.querySelector("[data-output]").value,"Single prompt");
  assert.equal(workspace.insert("a"),true); assert.match(errors.pop().message,/cursor/); assert.equal(workspace.state.brief,newSequence().brief);
  assert.equal(root.querySelector('[data-seq-action="copy-all"]').disabled,true);
  const input=(selector,value)=>{const el=root.querySelector(selector);el.value=value;el.dispatchEvent(new window.Event("input",{bubbles:true}));return el;};
  input('[data-seq-default]',"15");
  click('[data-seq-action="add"]');assert.equal(workspace.state.chunks.at(-1).duration,15);assert.equal(workspace.state.chunks[0].duration,10);
  for(let i=0;i<8;i++) click('[data-seq-action="increase"]');
  assert.equal(workspace.state.chunks[0].duration,15);
  click('[data-seq-global-media] [data-key="references"] [data-seq-action="select-media"]'); click('[data-asset-id="a"]');
  assert.deepEqual(workspace.state.references,["a"]);
  click('.h3ps-sequence-conditioning [data-seq-action="remove-media"]');assert.deepEqual(workspace.state.chunks[0].exclusions,["a"]);
  click('.h3ps-sequence-conditioning [data-seq-action="select-media"]'); click('[data-asset-id="a"]');
  assert.deepEqual(workspace.state.chunks[0].exclusions,[]);
  const drop=new window.Event("drop",{bubbles:true});drop.dataTransfer={getData:()=>"b"};
  root.querySelector('.h3ps-sequence-conditioning [data-asset="a"]').dispatchEvent(drop);
  assert.deepEqual(effectiveMedia(workspace.state,workspace.state.chunks[0].id,assets).map(m=>m.assetId),["b"]);
  assert.deepEqual(workspace.state.references,["a"]);
  const oldEditor=input('[data-seq-prompt]',"manual current text");workspace.refresh();
  assert.equal(root.querySelector("[data-seq-prompt]"),oldEditor);
  oldEditor.focus();oldEditor.selectionStart=4;workspace.refresh();assert.equal(document.activeElement,oldEditor);assert.equal(oldEditor.selectionStart,4);
  click('[data-seq-action="copy"]');await Promise.resolve();assert.equal(copied,"manual current text");
  click('[data-seq-action="reader"]');assert.equal(workspace.reader,true);assert.equal(root.querySelector("[data-seq-reader-text]").textContent,workspace.state.chunks[0].prompt);
  assert.equal(root.querySelector("dialog"),null);assert.equal(root.querySelector("[data-seq-prompt]"),oldEditor);
  const escapeKey=new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});oldEditor.dispatchEvent(escapeKey);assert.equal(workspace.reader,false);assert.equal(escapeKey.defaultPrevented,true);

  click('[data-seq-action="refine-open"]');input('[data-seq-refine-instruction]',"Slow down");workspace.refresh();
  assert.equal(root.querySelector('[data-seq-refine-instruction]').value,"Slow down");assert.equal(root.querySelector('[data-seq-refine]').hidden,false);
  click('[data-seq-action="instructions"]');assert.equal(root.querySelector('[data-seq-instructions-panel]').hidden,false);
  click('[data-seq-action="instructions"]');assert.equal(root.querySelector('[data-seq-instructions-panel]').hidden,true);
  const promptNode=root.querySelector("[data-seq-prompt]");
  const operation=workspace.controller.start();await Promise.resolve();
  assert.equal(root.querySelector("[data-seq-prompt]"),promptNode);
  const shortcut=new window.KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true});promptNode.dispatchEvent(shortcut);assert.equal(shortcut.defaultPrevented,true);
  const nativeUndo=new window.KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true});promptNode.dispatchEvent(nativeUndo);assert.equal(nativeUndo.defaultPrevented,false);
  click('[data-seq-action="single"]');callback({type:"chunk",operation_id:payload.operation_id,chunk_id:workspace.state.chunks[0].id,prompt:"late"});
  pending.resolve();await operation;click('[data-seq-action="sequence"]');
  assert.equal(workspace.state.chunks[0].prompt,"manual current text");assert.equal(workspace.active,true);assert.deepEqual(errors,[]);
  await window.happyDOM.close();
});

test("AI revisions retain exact manual versions and fork redo only on a successful replacement",()=>{
  const s=newSequence(), c=s.chunks[0]; c.prompt="manual before\n  spacing";
  replacePrompt(c,"AI one");c.prompt="manual after AI";
  revisePrompt(c,"undo");assert.equal(c.prompt,"manual before\n  spacing");
  assert.deepEqual(c.redo,["manual after AI"]);
  c.prompt="manual after undo";revisePrompt(c,"redo");assert.equal(c.prompt,"manual after AI");
  revisePrompt(c,"undo");assert.equal(c.prompt,"manual after undo");
  replacePrompt(c,"AI new branch");assert.deepEqual(c.redo,[]);
  revisePrompt(c,"undo");assert.equal(c.prompt,"manual after undo");
  const storage=new Map(),io={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
  saveSequence(io,s);assert.deepEqual(loadSequence(io),s);
});

test("serializer is prompts-only by default and export/history never enter inference",()=>{
  const s=newSequence();addChunk(s);s.chunks[0].prompt="  exact first\nline  ";s.chunks[1].prompt="second";
  assert.equal(aggregate(s),"  exact first\nline  \n\nsecond");
  assert.equal(aggregate(s,{format:"custom",template:"--- {index} {start}-{end}s ({duration}) ---\n{prompt}"}),"--- 1 0-10s (10) ---\n  exact first\nline  \n\n--- 2 10-20s (10) ---\nsecond");
  s.exportFormat="custom";s.exportTemplate="SECRET EXPORT";s.chunks[0].undo=["SECRET HISTORY"];
  assert.doesNotMatch(JSON.stringify(sequenceInputs(s)),/SECRET|export|undo|redo/);
  assert.equal(s.chunks[1].prompt,"second");
});

test("media reconciliation clears dangling assignments, ordinary Add restores shared references",()=>{
  const s=newSequence(),c=s.chunks[0];s.references=["a","missing"];s.first="gone";s.last="b";
  c.additions=["lost"];removeReference(s,c,"a");assert.deepEqual(c.exclusions,["a"]);
  assignReference(s,c,"a");assert.deepEqual(c.exclusions,[]);assert.deepEqual(c.additions,["lost"]);
  assignReference(s,c,"b","a");assert.deepEqual(c.exclusions,["a"]);
  assert.deepEqual(c.additions,["lost","b"]);
  assert.equal(reconcileMedia(s,[{id:"a"},{id:"b"}]),true);
  assert.equal(s.first,null);assert.equal(s.last,"b");assert.deepEqual(s.references,["a"]);assert.deepEqual(c.additions,["b"]);
  assert.equal(reconcileMedia(s,[{id:"a"},{id:"b"}]),false);
});

test("Generate preserves existing prompts; all and refine commit revisions only for completed owned results",async()=>{
  const state=newSequence();addChunk(state);state.chunks[0].prompt="manual first";
  let request,deliver; const controller=createSequenceController({state,snapshot:()=>({}),prepare:async()=>true,cancel:()=>{},
    run:async(payload,emit)=>{request=payload;deliver=emit;for(const c of payload.sequence.chunks) emit({type:"chunk",operation_id:payload.operation_id,chunk_id:c.id,prompt:"new "+c.id});}});
  await controller.start();assert.equal(state.chunks[0].prompt,"manual first");assert.deepEqual(state.chunks[0].undo,[]);
  const originals=state.chunks.map(c=>c.prompt);await controller.start("all");
  assert.deepEqual(state.chunks.map(c=>c.undo),originals.map(x=>[x]));
  const c=state.chunks[0];c.prompt="manual to refine";await controller.start("refine",c.id,"Slow down");
  assert.equal(request.sequence.chunks[0].prompt,"manual to refine");assert.equal(c.undo.at(-1),"manual to refine");
  deliver({type:"chunk",operation_id:request.operation_id,chunk_id:c.id,prompt:"late"});assert.notEqual(c.prompt,"late");
});

test("completed work survives transport failure, missing output, cancellation and manual edits",async()=>{
  for (const failure of ["transport", "missing", "cancel", "edit"]) {
    const state=newSequence();addChunk(state);state.chunks.forEach((c,i)=>{c.prompt=`manual ${i}`;c.undo=[`older ${i}`];});
    const before=structuredClone(state);const errors=[];let changes=0;
    const controller=createSequenceController({state,snapshot:()=>({}),prepare:async()=>true,cancel:async()=>{},changed:()=>changes++,error:e=>errors.push(e),
      run:async(payload,emit)=>{
        const send=c=>emit({type:"chunk",operation_id:payload.operation_id,chunk_id:c.id,prompt:"replacement"});
        send(state.chunks[0]);
        assert.equal(state.chunks[0].prompt,"replacement");
        assert.equal(state.chunks[1].prompt,"");
        if(failure==="transport") throw Error("connection lost");
        if(failure==="missing") return;
        if(failure==="cancel") controller.cancel();
        if(failure==="edit") state.chunks[1].prompt="late manual edit";
        send(state.chunks[1]);
      }});
    await controller.start("all");
    assert.equal(state.chunks[0].prompt,"replacement");
    assert.equal(state.chunks[1].prompt,failure==="edit"?"late manual edit":"");
    assert.deepEqual(state.chunks.map(c=>c.undo.at(-1)),before.chunks.map(c=>c.prompt));
    assert.equal(changes,2);assert.equal(controller.busy,false);
    assert.equal(errors.length,failure==="cancel"?0:1);
  }
});

test("shared Aspect and split controls keep independent values and keyboard-facing state",async()=>{
  const {aspectRatioMarkup,bindAspectRatio,splitMenuMarkup,setSplitMenuOpen}=await import("../web/writer_controls.js");
  const w=new Window(),root=w.document.createElement("div");root.className="h3ps-root";w.document.body.append(root);
  root.innerHTML=aspectRatioMarkup(()=>"")+aspectRatioMarkup(()=>"","sequence-aspect")+'<div class="h3ps-clear-control">'+splitMenuMarkup(()=>"",{label:"Actions",primary:"data-primary",toggle:"data-toggle",menu:"data-menu",contents:"",ariaLabel:"Actions"})+'</div>';
  const [single,sequence]=root.querySelectorAll(".h3ps-choice"),values=[];
  bindAspectRatio(single,"16:9",v=>values.push(["single",v]));bindAspectRatio(sequence,"9:16",v=>values.push(["sequence",v]));
  sequence.querySelector("[data-choice-toggle]").click();assert.equal(sequence.querySelector("[data-choice-menu]").hidden,false);
  sequence.querySelector('[data-aspect="1:1"]').click();assert.equal(single.querySelector("[data-aspect-label]").textContent,"16:9");
  assert.equal(sequence.querySelector("[data-aspect-description]").dataset.i18n,"aspect.square");
  assert.equal(single.querySelector("[data-aspect-description]").dataset.i18n,"aspect.widescreen");
  assert.equal(sequence.querySelector("[data-choice-toggle]").getAttribute("aria-expanded"),"false");assert.deepEqual(values,[["sequence","1:1"]]);
  const split=root.querySelector(".h3ps-clear-control");setSplitMenuOpen(split,true);
  assert.equal(split.querySelector("[data-menu]").hidden,false);assert.ok([...split.querySelectorAll("button")].every(b=>b.getAttribute("aria-expanded")==="true"));
  setSplitMenuOpen(split,false);assert.equal(split.querySelector("[data-menu]").hidden,true);
  await w.happyDOM.close();
});

async function sequenceFixture(overrides = {}) {
  const window=new Window();globalThis.document=window.document;
  const root=document.createElement("div");root.className="h3ps-root";document.body.append(root);
  const assets=[{id:"a",type:"image",reference:"<Picture 7>"},{id:"b",type:"image",reference:"<Picture 8>"},{id:"v",type:"video",reference:"<Video 9>"},{id:"n",type:"image",status:"needs_edit",reference:null}];
  root.innerHTML=`<div class="h3ps-workspace"><div class="h3ps-input-panel"><div data-video-inputs><div class="h3ps-section-actions"></div><div data-h3ps-media>${assets.map(a=>`<div tabindex="0" data-asset-id="${a.id}"><button data-media-tag="${a.reference || ''}">${a.reference || ''}</button></div>`).join("")}</div></div></div><div class="h3ps-output-panel"><textarea data-output>Single unchanged</textarea></div></div><footer class="h3ps-footer"><button data-generate><span data-generate-label></span></button></footer>`;
  const errors=[],requests=[],copies=[];
  const {insertReferenceAtCaret:sharedInsert}=await import("../web/compat.js");
  const insertReferenceAtCaret=(...args)=>{
    const prior=globalThis.Event;globalThis.Event=window.Event;
    try{return sharedInsert(...args);}finally{globalThis.Event=prior;}
  };
  const workspace=createSequenceWorkspace({root,storage:window.localStorage,assets:()=>assets,icon:()=>"",isBusy:()=>false,
    snapshot:()=>({model_id:"current-model"}),prepare:async()=>true,busy(){},refresh(){},cancel(){},
    run:async(p,emit)=>{requests.push(p);for(const c of p.sequence.chunks.filter(c=>p.action==="all" || (p.action==="missing"?!c.prompt.trim():c.id===p.chunk_id)))emit({type:"chunk",operation_id:p.operation_id,chunk_id:c.id,prompt:"AI "+c.id});},
    error:e=>errors.push(e.message),copy:async t=>copies.push(t),insert:insertReferenceAtCaret,...overrides});
  const context=vm.createContext({studio:{root,sequence:workspace},insertReferenceAtCaret,referenceInsertTarget:null,rememberReferenceInsertTarget(){}});
  vm.runInContext(main.match(/^function insertSelectedReference\([^]*?^}/m)[0],context);
  root.querySelectorAll("[data-media-tag]").forEach(b=>b.addEventListener("click",()=>context.insertSelectedReference(b.dataset.mediaTag,b.closest("[data-asset-id]").dataset.assetId)));
  const click=selector=>root.querySelector(selector).click();
  const input=(selector,value)=>{const el=typeof selector==="string"?root.querySelector(selector):selector;el.value=value;el.dispatchEvent(new window.Event("input",{bubbles:true}));return el;};
  const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));};
  click('[data-seq-action="sequence"]');
  return {window,root,workspace,assets,errors,requests,copies,click,input,flush};
}

test("selection ends on choose, same assignment, Cancel, Escape and outside click without replacing filled-slot clicks",async()=>{
  const {window,root,workspace,click}=await sequenceFixture();
  const add='[data-seq-global-media] [data-key="references"] [data-seq-action="select-media"]';
  click(add);assert.ok(root.querySelector('[data-seq-slot].is-selecting'));
  assert.ok(root.querySelector('[data-asset-id="a"]').classList.contains("is-sequence-selectable"));
  assert.equal(root.querySelector('[data-asset-id="n"]').classList.contains("is-sequence-selectable"),false);
  click('[data-asset-id="a"]');assert.deepEqual(workspace.state.references,["a"]);assert.equal(root.classList.contains("is-sequence-selecting"),false);
  click(add);click('[data-asset-id="a"]');assert.deepEqual(workspace.state.references,["a"]);assert.equal(root.classList.contains("is-sequence-selecting"),false);
  click('[data-seq-global-media] [data-asset="a"] .h3ps-add-asset');assert.equal(root.classList.contains("is-sequence-selecting"),false);
  click(add);click('.is-selecting [data-seq-action="selection-cancel"]');assert.equal(root.classList.contains("is-sequence-selecting"),false);
  click(add);root.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));assert.equal(root.classList.contains("is-sequence-selecting"),false);
  click(add);click('[data-seq-brief]');assert.equal(root.classList.contains("is-sequence-selecting"),false);
  assert.equal(root.querySelector('[data-seq-selection]'),null);
  await window.happyDOM.close();
});

test("contextual insertion uses the active chunk's First-reference-Last mapping and rejects stale/unassigned targets",async()=>{
  const {window,root,workspace,assets,click,input,errors}=await sequenceFixture(),state=workspace.state;
  addChunk(state);addChunk(state);state.first="a";state.last="b";state.references=["b","v"];
  workspace.refresh();
  const [first,middle,last]=root.querySelectorAll("[data-seq-prompt]");
  assert.deepEqual(effectiveMedia(state,state.chunks[0].id,assets).map(m=>[m.assetId,m.tag]),[["a","<Picture 1>"],["b","<Picture 2>"],["v","<Video 1>"]]);
  assert.deepEqual(effectiveMedia(state,state.chunks[2].id,assets).map(m=>m.tag),["<Picture 1>","<Video 1>","<Picture 2>"]);
  assert.match(root.querySelector('[data-seq-anchor]').textContent,/First frame · <Picture 1>/);
  assert.equal(root.querySelector('[data-seq-anchor] [data-seq-action="remove-media"]'),null);
  assert.doesNotMatch(root.querySelector('[data-seq-global-media]').textContent,/<Picture/);
  input(first,"left right");first.focus();first.setSelectionRange(5,5);workspace.refresh();click('[data-asset-id="b"] [data-media-tag]');
  assert.equal(first.value,"left <Picture 2>right");assert.equal(state.chunks[0].prompt,first.value);
  middle.focus();click('[data-asset-id="b"] [data-media-tag]');assert.equal(middle.value,"<Picture 1>");
  click('[data-asset-id="a"] [data-media-tag]');assert.equal(middle.value,"<Picture 1>");assert.match(errors.pop(),/Add this media/);
  last.focus();click('[data-asset-id="v"] [data-media-tag]');assert.equal(last.value,"<Video 1>");
  state.references=[];workspace.refresh();first.focus();first.setSelectionRange(0,0);click('[data-asset-id="a"] [data-media-tag]');assert.ok(first.value.startsWith("<Picture 1>"));
  const old=state.chunks[0].prompt;deleteChunk(state,state.chunks[0].id);workspace.refresh();click('[data-asset-id="a"] [data-media-tag]');assert.match(errors.pop(),/cursor/);assert.equal(first.value,old);
  const brief=root.querySelector('[data-seq-brief]');input(brief,"");brief.focus();click('[data-asset-id="b"] [data-media-tag]');assert.equal(brief.value,"last frame");
  brief.focus();click('[data-asset-id="v"] [data-media-tag]');assert.match(errors.pop(),/Sequence Media/);
  assert.equal(root.querySelector('[data-output]').value,"Single unchanged");
  await window.happyDOM.close();
});

test("primary CTA fills missing prompts then regenerates all current inputs while retaining manual revisions",async()=>{
  const {window,root,workspace,click,input,requests,flush}=await sequenceFixture(),state=workspace.state;
  addChunk(state);state.chunks[0].prompt="manual original";workspace.refresh();
  const editor=root.querySelector('[data-seq-prompt]'),cta=root.querySelector('[data-seq-generate]');
  assert.equal(cta.textContent,"Generate sequence");click('[data-seq-generate]');await flush();
  assert.equal(requests[0].action,"missing");assert.equal(state.chunks[0].prompt,"manual original");
  assert.equal(cta.textContent,"Regenerate sequence");assert.equal(cta.disabled,false);assert.equal(root.querySelector('[data-seq-action="all"]'),null);
  input(editor,"manual before all");state.brief="current brief";state.instructions="current instructions";state.aspectRatio="9:16";state.first="a";state.chunks[0].instruction="current direction";state.chunks[1].additions=["b"];
  const originals=state.chunks.map(c=>c.prompt);click('[data-seq-generate]');await flush();
  assert.equal(requests[1].action,"all");assert.equal(requests[1].sequence.chunks[0].prompt,"manual before all");
  assert.equal(requests[1].sequence.chunks[0].instruction,"current direction");assert.equal(requests[1].sequence.first,"a");
  assert.deepEqual(requests[1].sequence.chunks[1].additions,["b"]);assert.equal(requests[1].sequence.aspectRatio,"9:16");
  assert.deepEqual(state.chunks.map(c=>c.undo.at(-1)),originals);assert.equal(root.querySelector('[data-seq-prompt]'),editor);
  await window.happyDOM.close();
});

test("Reader copy format persists separately, renders canonical text and never enters inference",async()=>{
  const {window,root,workspace,click,input,copies,requests,flush}=await sequenceFixture(),state=workspace.state;
  addChunk(state);state.chunks[0].prompt="first {index}";state.chunks[1].prompt="second";workspace.refresh();
  const canonical=state.chunks.map(c=>c.prompt),header=root.querySelector('.h3ps-sequence-output>header'),left=root.querySelector('.h3ps-input-panel'),editor=root.querySelector('[data-seq-prompt]');
  click('[data-seq-action="copy-all"]');await flush();assert.equal(copies.at(-1),"first {index}\n\nsecond");
  click('[data-seq-action="reader"]');assert.equal(workspace.reader,true);assert.equal(left.hidden,false);
  assert.equal(root.querySelector('.h3ps-sequence-output>header'),header);assert.equal(root.querySelector('[data-seq-prompt]'),editor);
  click('[data-seq-action="copy-custom"]');input('[data-seq-copy-template]',"[{start}-{end}s] PART {index} ({duration})\n{prompt}");input('[data-seq-copy-separator]',"\\n---\\n");
  click('[data-seq-action="copy-all"]');await flush();assert.equal(copies.at(-1),"[0-10s] PART 1 (10)\nfirst {index}\n---\n[10-20s] PART 2 (10)\nsecond");
  assert.deepEqual(state.chunks.map(c=>c.prompt),canonical);assert.equal(root.querySelector('[data-seq-copy-preview]').textContent,copies.at(-1));
  assert.deepEqual(loadSequence(window.localStorage).copyFormat,state.copyFormat);
  assert.equal(sequenceInputs(state).copyFormat,undefined);
  click('[data-seq-action="reader"]');assert.equal(workspace.reader,false);click('[data-seq-action="copy-all"]');await flush();assert.ok(copies.at(-1).startsWith("[0-10s]"));
  await workspace.controller.start("refine",state.chunks[0].id,"Refine now");assert.equal(requests.at(-1).sequence.copyFormat,undefined);
  click('[data-seq-action="reader"]');click('[data-seq-action="copy-default"]');assert.equal(state.copyFormat.format,"prompts");
  root.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));assert.equal(workspace.reader,false);
  await window.happyDOM.close();
});


test("chunk chips insert at their own saved caret; Direction and Brief use their own reference scope",async()=>{
  const {window,root,workspace,click,input}=await sequenceFixture(),s=workspace.state;
  addChunk(s);s.first="a";s.last="b";s.references=["v"];workspace.refresh();
  const prompt=root.querySelector('[data-seq-prompt]');input(prompt,"left right");prompt.focus();prompt.setSelectionRange(5,5);prompt.dispatchEvent(new window.Event("select",{bubbles:true}));
  const direction=root.querySelector('[data-seq-instruction]');direction.focus();click('[data-asset-id="a"] [data-media-tag]');assert.equal(direction.value,"<Picture 1>");
  click('[data-seq-anchor] [data-seq-action="insert-media"]');assert.equal(prompt.value,"left <Picture 1>right");
  const brief=root.querySelector('[data-seq-brief]');input(brief,"");brief.focus();click('[data-asset-id="v"] [data-media-tag]');assert.equal(brief.value,"reference 1");
  click('[data-seq-action="reader"]');click('[data-seq-action="copy-custom"]');
  for(const name of ["divider","times","numbered","reset"]){click(`[data-seq-action="copy-${name}"]`);assert.equal(root.querySelector('[data-seq-copy-preview]').textContent,aggregate(s));}
  assert.equal(s.copyFormat.template,"{prompt}");assert.equal(s.copyFormat.separator,"");assert.equal(s.chunks[0].prompt,prompt.value);
  await window.happyDOM.close();
});


test("new production instructions migrate only an untouched prototype default",()=>{
  const s=newSequence();s.instructions=LEGACY_SEQUENCE_INSTRUCTIONS;
  const storage={getItem:()=>JSON.stringify(s)};
  assert.equal(loadSequence(storage).instructions,DEFAULT_SEQUENCE_INSTRUCTIONS);
  s.instructions="My exact creative instructions";assert.equal(loadSequence(storage).instructions,s.instructions);
  s.instructions="";assert.equal(loadSequence(storage).instructions,"");
});


test("copy separators expose whitespace and preserve exact copied text",async()=>{
  for(const value of ["", "\n\n---\n\n", "\\n", "\t\r\n", "a\\b"])
    assert.equal(parseSeparator(displaySeparator(value)),value);
  const {window,root,workspace,click,input}=await sequenceFixture();
  addChunk(workspace.state);workspace.state.chunks[0].prompt="first";workspace.state.chunks[1].prompt="second";workspace.refresh();
  click('[data-seq-action="reader"]');click('[data-seq-action="copy-custom"]');click('[data-seq-action="copy-divider"]');
  assert.equal(root.querySelector('[data-seq-copy-separator]').value,String.raw`\n\n---\n\n`);
  input('[data-seq-copy-separator]',String.raw`\n***\n`);assert.equal(aggregate(workspace.state),"first\n***\nsecond");
  click('[data-seq-action="copy-chapters"]');assert.equal(root.querySelector('[data-seq-copy-preview]').textContent,aggregate(workspace.state));
  assert.match(aggregate(workspace.state),/^## 1 · 0–10s/);
  const separator='-'.repeat(1500);
  input('[data-seq-copy-separator]',separator);
  assert.equal(loadSequence(window.localStorage).copyFormat.separator,separator);
  assert.equal(aggregate(loadSequence(window.localStorage)),aggregate(workspace.state));
  await window.happyDOM.close();
});

test("visible working results, warning recovery, Reader and Copy remain coherent",async()=>{
  let send,payload,done=deferred();
  const f=await sequenceFixture({run:(p,emit)=>{payload=p;send=emit;return done.promise;}});
  const {workspace:w,root,click,input,window,flush,copies,errors}=f;
  addChunk(w.state);addChunk(w.state);w.state.chunks.forEach((c,i)=>c.prompt=`old ${i}`);w.refresh();
  const op=w.controller.start("all");await flush();
  assert.ok(root.querySelector('[data-seq-generate] .h3ps-spinner'));
  assert.deepEqual([...root.querySelectorAll('[data-seq-prompt]')].map(e=>e.value),['','','']);
  assert.deepEqual(w.state.chunks.map(c=>c.undo.at(-1)),['old 0','old 1','old 2']);
  const emit=(type,index,extra={})=>send({type,chunk_id:w.state.chunks[index].id,operation_id:payload.operation_id,...extra});
  emit('phase',0,{phase:'generating'});assert.equal(root.querySelector('[data-seq-status]').textContent,'Generating…');
  emit('chunk',0,{prompt:'new first'});
  assert.equal(root.querySelector('[data-seq-prompt]').value,'new first');
  assert.equal(loadSequence(window.localStorage).chunks[0].prompt,'new first');
  emit('phase',1,{phase:'repairing'});assert.equal(root.querySelectorAll('[data-seq-status]')[1].textContent,'Repairing…');
  emit('chunk',1,{prompt:'model text to fix',attention:'The model omitted the frame definition. Suggested fix: add the supplied frame binding.',repair:'failed'});
  done.resolve();await op;
  assert.equal(root.querySelector('[data-seq-generate] .h3ps-spinner'),null);
  assert.equal(root.querySelector('[data-seq-generate]').textContent,'Generate sequence');
  assert.equal(root.querySelectorAll('[data-seq-status]')[2].textContent,'Not started');
  const second=root.querySelectorAll('[data-chunk]')[1];
  assert.equal(second.querySelector('[data-seq-attention]').hidden,false);
  assert.match(second.querySelector('[data-seq-help]').textContent,/model.*Suggested fix/);
  assert.equal(second.querySelector('[data-seq-action="generate"]').textContent,'Regenerate');
  click('[data-seq-action="reader"]');click('[data-seq-action="copy-custom"]');
  assert.equal(root.querySelector('.h3ps-sequence-chunks').hidden,false);
  assert.equal(second.querySelector('[data-seq-reader-text]').textContent,'model text to fix');
  click('[data-seq-action="copy-all"]');await flush();assert.equal(copies.length,0);assert.match(errors.at(-1),/Chunk 2 needs attention/);
  second.querySelector('[data-seq-action="copy"]').click();await flush();assert.equal(copies.at(-1),'model text to fix');
  click('[data-seq-action="reader"]');
  input(second.querySelector('[data-seq-prompt]'),'my corrected prompt');
  assert.equal(second.querySelector('[data-seq-attention]').hidden,true);
  assert.equal(w.state.chunks[1].attention,undefined);
  done=deferred();
  const next=w.controller.start('refine',w.state.chunks[1].id,'Keep this wording');await flush();
  assert.equal(payload.sequence.chunks[1].prompt,'my corrected prompt');
  assert.equal(payload.sequence.chunks[0].prompt,'new first');
  send({type:'chunk',chunk_id:w.state.chunks[1].id,operation_id:payload.operation_id,prompt:'refined'});done.resolve();await next;
  assert.equal(w.state.chunks[1].prompt,'refined');
  await window.happyDOM.close();
});

test("Generate touches only empty or warned chunks and cancel keeps completed prompts",async()=>{
  const done=deferred();let send,payload;
  const f=await sequenceFixture({run:(p,emit)=>{payload=p;send=emit;return done.promise;}});
  const {workspace:w,root,window,flush}=f;
  addChunk(w.state);addChunk(w.state);w.state.chunks[0].prompt='keep';w.state.chunks[1].prompt='needs work';w.state.chunks[1].attention='model warning';w.refresh();
  const op=w.controller.start();await flush();
  assert.deepEqual([...root.querySelectorAll('[data-seq-prompt]')].map(e=>e.value),['keep','','']);
  send({type:'chunk',operation_id:payload.operation_id,chunk_id:w.state.chunks[1].id,prompt:'fixed'});
  w.controller.cancel();send({type:'chunk',operation_id:payload.operation_id,chunk_id:w.state.chunks[2].id,prompt:'late'});done.resolve();await op;
  assert.deepEqual(w.state.chunks.map(c=>c.prompt),['keep','fixed','']);
  assert.equal(root.querySelector('[data-seq-generate] .h3ps-spinner'),null);
  assert.equal(w.state.chunks[1].attention,undefined);
  await window.happyDOM.close();
});

test("Sequence severity uses the existing persistent toast and warning timeout",async()=>{
  const {sequenceNotificationOptions}=await import('../web/writer_controls.js');
  const w=new Window(),root=w.document.createElement('div');
  root.innerHTML='<div data-h3ps-toast><strong data-toast-title></strong><span data-toast-message></span><details data-toast-details><pre></pre></details><button data-toast-action></button></div>';
  const timers=[];let hidden=0;const studio={root};
  const context=vm.createContext({studio,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{},hideToast:()=>hidden++,writeToastContent});
  vm.runInContext(main.match(/^function showToast\([^]*?^}/m)[0],context);
  context.showToast('Sequence','Runtime failed',null,null,sequenceNotificationOptions(new Error()));
  assert.deepEqual(timers.map(t=>t.ms),[0]);timers[0].fn();assert.equal(studio.toastDismissOnWorkspaceClick,true);
  assert.ok(root.querySelector('[data-h3ps-toast]').classList.contains('is-persistent'));
  timers.length=0;context.showToast('Sequence','Needs attention',null,null,sequenceNotificationOptions({severity:'warning'}));
  assert.deepEqual(timers.map(t=>t.ms),[0,8000]);timers[1].fn();assert.equal(hidden,1);
  await w.happyDOM.close();
});

test("shared prompt highlighting is lossless, escaped and preserves dialogue as one unit",async()=>{
  const {promptHighlightMarkup}=await import('../web/prompt_highlights.js');
  const w=new Window(),view=w.document.createElement('pre');
  const text='subject_definitions: <Subject 1> from <Picture 1>\nsummary: A room\ndetailed_description: [Shot 1] At 00:05.000, <Video 1> and <Audio 1>. <d>[English] Say <Picture 99> & \\"words\\".</d>\n<script>alert(1)</script>';
  view.innerHTML=promptHighlightMarkup(text);
  assert.equal(view.textContent,text);
  assert.equal(view.querySelector('script'),null);
  for(const kind of ['section','subject','image','video','audio','shot','time','dialogue'])assert.ok(view.querySelector('mark.is-'+kind),kind);
  assert.equal(view.querySelector('mark.is-dialogue mark'),null);
  assert.equal(view.querySelectorAll('mark.is-image').length,1);
  assert.equal(promptHighlightMarkup(''), '');
  await w.happyDOM.close();
});

test("Sequence highlights follow editing and Undo while Reader and Copy retain exact text",async()=>{
  const f=await sequenceFixture(),{workspace:w,root,window,input,click,copies,flush}=f;
  const prompt='integrated_multimodal_description: [Shot 1] At 00:05.000 she turns to <Picture 1>.\n\noverall_soundscape: Quiet.';
  const editor=root.querySelector('[data-seq-prompt]');input(editor,prompt);
  editor.setSelectionRange(10,30);w.refresh();
  assert.equal(editor.selectionStart,10);assert.equal(editor.selectionEnd,30);
  const layer=root.querySelector('[data-seq-highlights]');
  assert.equal(layer.getAttribute('aria-hidden'),'true');assert.equal(layer.textContent,prompt+'\n');
  assert.ok(layer.querySelector('.is-time'));assert.ok(layer.querySelector('.is-image'));
  click('[data-seq-action="reader"]');const reader=root.querySelector('[data-seq-reader-text]');
  assert.equal(reader.textContent,prompt);assert.ok(reader.querySelector('.is-section'));
  click('[data-seq-action="copy"]');await flush();assert.equal(copies.at(-1),prompt);
  click('[data-seq-action="reader"]');replacePrompt(w.state.chunks[0],'new version');w.refresh();
  click('[data-seq-action="undo"]');assert.equal(editor.value,prompt);assert.equal(layer.textContent,prompt+'\n');
  input(editor,'');assert.equal(layer.querySelector('mark'),null);
  await window.happyDOM.close();
});

test("Official/Compact selector preserves custom instructions and uses the existing copy selector style",async()=>{
  const {COMPACT_SEQUENCE_INSTRUCTIONS,sequenceInstructionDefault}=await import('../web/sequence_state.js');
  const f=await sequenceFixture(),{workspace:w,root,window,click,input}=f;
  const instructions=root.querySelector('[data-seq-instructions]');
  const selector=root.querySelector('[aria-label="Sequence output format"]');
  assert.equal(selector.className,root.querySelector('[aria-label="Copy format"][role="group"]').className);
  assert.equal(w.state.outputFormat,'official');
  click('[data-seq-action="instructions"]');click('[data-seq-action="format-compact"]');
  assert.equal(w.state.outputFormat,'compact');assert.equal(instructions.value,COMPACT_SEQUENCE_INSTRUCTIONS);
  assert.match(root.querySelector('[data-seq-contract]').textContent,/Compact.*natural-language/);
  input(instructions,'My custom instructions stay unchanged');
  click('[data-seq-action="format-official"]');assert.equal(instructions.value,'My custom instructions stay unchanged');
  click('[data-seq-action="format-compact"]');assert.equal(instructions.value,'My custom instructions stay unchanged');
  assert.equal(loadSequence(window.localStorage).outputFormat,'compact');
  assert.equal(sequenceInputs(w.state).outputFormat,'compact');
  click('[data-seq-action="reset"]');assert.equal(instructions.value,sequenceInstructionDefault('compact'));
  click('[data-seq-action="format-official"]');assert.equal(instructions.value,DEFAULT_SEQUENCE_INSTRUCTIONS);
  await window.happyDOM.close();
});

test("Sequence transport retains structured planner diagnostics",async()=>{
  const diagnostics={stage:'planning',reason:'step_count',expected_steps:4,received_steps:3};
  const wire=JSON.stringify({type:'error',code:'INVALID_SEQUENCE_PLAN',message:'The model returned 3 of 4 required planning steps.',details:diagnostics})+'\n';
  const response=new Response(wire);
  await assert.rejects(transportContext.readSequenceStream(response,()=>{}),error=>error.details.reason==='step_count' && error.details.received_steps===3);
});

test("initial Sequence brief is an example only until the user saves or clears it",async()=>{
  const {INITIAL_SEQUENCE_BRIEF}=await import('../web/sequence_state.js');
  const storage=new Map(),io={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
  const fresh=loadSequence(io);
  assert.equal(fresh.brief,INITIAL_SEQUENCE_BRIEF);
  assert.ok(fresh.chunks.every(c=>c.prompt===''));
  for(const brief of ['', 'My own scene']) {
    fresh.brief=brief;saveSequence(io,fresh);assert.equal(loadSequence(io).brief,brief);
  }
  const {workspace:w,root,window,input,click}=await sequenceFixture();
  assert.equal(root.querySelector('[data-seq-brief]').value,INITIAL_SEQUENCE_BRIEF);
  input(root.querySelector('[data-seq-brief]'),'');
  click('[data-seq-action="format-compact"]');w.refresh();
  assert.equal(loadSequence(window.localStorage).brief,'');
  assert.equal(root.querySelector('[data-seq-brief]').value,'');
  await window.happyDOM.close();
});

test("Compact highlighting follows format selection without changing text or selection",async()=>{
  const {workspace:w,root,window,input,click}=await sequenceFixture();
  const prompt='She sees <Picture 1> beside a window. [Shot 1] At 00:05.000 she turns.\n\noverall_soundscape:\nQuiet room.\n\nnon_diegetic_music:\nN/A';
  const editor=root.querySelector('[data-seq-prompt]');input(editor,prompt);
  editor.setSelectionRange(3,12);
  click('[data-seq-action="format-compact"]');
  const layer=root.querySelector('[data-seq-highlights]');
  assert.equal(layer.textContent,prompt+'\n');assert.equal(editor.value,prompt);
  assert.equal(editor.selectionStart,3);assert.equal(editor.selectionEnd,12);
  assert.deepEqual([...layer.querySelectorAll('mark')].map(m=>m.textContent),['<Picture 1>','overall_soundscape:','non_diegetic_music:']);
  click('[data-seq-action="reader"]');
  assert.equal(root.querySelector('[data-seq-reader-text]').textContent,prompt);
  assert.equal(root.querySelectorAll('[data-seq-reader-text] mark').length,3);
  click('[data-seq-action="format-official"]');
  assert.ok(layer.querySelector('.is-time'));assert.ok(layer.querySelector('.is-shot'));
  await window.happyDOM.close();
});

test("Sequence text fields disable browser spelling underlines",async()=>{
  const {workspace:w,root,window,click}=await sequenceFixture();
  click('[data-seq-action="add"]');w.refresh();
  const fields=root.querySelectorAll('.h3ps-sequence-inputs textarea,.h3ps-sequence-output textarea,[data-seq-instruction]');
  assert.ok(fields.length>4);
  for(const field of fields)assert.equal(field.getAttribute('spellcheck'),'false');
  await window.happyDOM.close();
});

test("Sequence overlay and editor share shaping at every interface scale",async()=>{
  const css=await readFile(new URL('../web/styles/sequence.css',import.meta.url),'utf8');
  const shared=css.match(/:is\(\.h3ps-sequence-prompt,\.h3ps-sequence-highlights,\.h3ps-sequence-reader-text\)\{([^}]+)\}/)[1];
  for(const rule of ['font-kerning:none','font-variant-ligatures:none','letter-spacing:0','word-spacing:0','font-weight:400','text-rendering:geometricPrecision'])assert.ok(shared.includes(rule),rule);
  assert.match(css,/\.h3ps-sequence-chunk\{position:relative;z-index:0;/);
});

test("native highlight ranges keep one mirror text run and release obsolete ranges",async()=>{
  const {createPromptMirrorHighlighter,promptHighlightMarkup}=await import('../web/prompt_highlights.js');
  const w=new Window(),doc=w.document;
  Object.defineProperty(w,'CSS',{value:{highlights:new Map()},configurable:true});
  w.Highlight=class extends Set {};
  const painter=createPromptMirrorHighlighter(doc),a=doc.createElement('div'),b=doc.createElement('div');
  const text='[Shot 1] From <Picture 1>, <Subject 1> speaks. At 00:05.000 she sings.\n';
  painter.paint(a,promptHighlightMarkup(text));
  painter.paint(b,promptHighlightMarkup(text));
  assert.equal(a.childNodes.length,1);assert.equal(a.textContent,text);
  assert.equal(a.querySelector('mark'),null);
  const times=w.CSS.highlights.get('h3ps-sequence-time');
  assert.equal(times.size,2);
  for(const range of times) assert.equal(range.toString(),'00:05.000');
  painter.clear();assert.equal(w.CSS.highlights.size,0);
  painter.paint(a,promptHighlightMarkup(text,'compact'));
  assert.deepEqual([...w.CSS.highlights.keys()],['h3ps-sequence-image']);
  assert.equal(a.childNodes.length,1);assert.equal(a.textContent,text);
  painter.clear();
  painter.paint(a,promptHighlightMarkup(''));
  assert.equal(w.CSS.highlights.size,0);assert.equal(a.textContent,'');
  await w.happyDOM.close();
});


test("long Sequence brief has an informational count and survives storage",async()=>{
  const {window,root,input}=await sequenceFixture();
  const brief="A quiet scene. ".repeat(3000),editor=root.querySelector('[data-seq-brief]');
  assert.equal(editor.hasAttribute('maxlength'),false);
  input(editor,brief);
  assert.equal(root.querySelector('[data-seq-brief-count]').textContent,`${brief.length.toLocaleString()} characters`);
  assert.equal(loadSequence(window.localStorage).brief,brief);
  await window.happyDOM.close();
});

test("sequence workspace and controller follow locale switches without rebuilding editors", async () => {
  const { window, root, workspace, errors, requests } = await sequenceFixture();
  const state = workspace.state;
  addChunk(state);
  state.chunks[0].prompt = "kept";
  state.chunks[0].instruction = "direction";
  workspace.refresh();
  const editor = root.querySelectorAll("[data-seq-prompt]")[0];
  configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  try {
    setLanguagePreference("zh-CN");
    workspace.refresh();
    assert.equal(root.querySelector("[data-seq-selector]").textContent, "序列");
    assert.equal(root.querySelector('[data-seq-action="add"]').textContent.trim(), "添加片段");
    assert.equal(root.querySelector("[data-seq-brief]").placeholder, "大约 15 秒时她站起身…");
    assert.equal(root.querySelectorAll('[data-seq-action="generate"]')[0].textContent, "重新生成");
    assert.equal(root.querySelector('[data-seq-action="refine-open"]').textContent, "改写");
    assert.equal(root.querySelector("[data-seq-copy-format]").getAttribute("aria-label"), "复制格式");
    assert.equal(root.querySelectorAll("[data-seq-prompt]")[0], editor);
    assert.equal(editor.value, "kept");
    const newlineHint = root.querySelector('[data-i18n="sequence.copy.newline_hint"]');
    assert.match(newlineHint.textContent, /\\n/);
    assert.equal(newlineHint.textContent.includes("\n"), false);
    const mediaHint = root.querySelector('[data-i18n-title="sequence.media_hint"]');
    assert.match(mediaHint.getAttribute("title"), /<Picture N>/);
    workspace.controller.progress.set(state.chunks[0].id, "repairing");
    workspace.refresh();
    assert.equal(root.querySelectorAll("[data-seq-status]")[0].textContent, "正在修复…");
    workspace.insert("a");
    assert.match(errors.at(-1), /请先将光标放入片段字段或创意描述/);

    const pending = deferred();
    const controller = createSequenceController({
      state: newSequence(), snapshot: () => ({}), prepare: () => pending.promise, run: () => {}, cancel: () => {},
    });
    const operation = controller.start();
    await Promise.resolve();
    assert.equal(controller.phase, "准备中…");
    pending.resolve(false);
    await operation;

    setLanguagePreference("en");
    workspace.refresh();
    assert.equal(root.querySelector("[data-seq-selector]").textContent, "Sequence");
    assert.equal(root.querySelector("[data-seq-brief]").placeholder, "At around 15 seconds she stands up…");
    assert.equal(requests.length, 0);
  } finally {
    setLanguagePreference("en");
    await window.happyDOM.close();
  }
});
