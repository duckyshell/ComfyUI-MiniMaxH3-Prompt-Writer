import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {referenceTextRemapper} from "../web/reference_labels.js";
import {newSequence, effectiveMedia} from "../web/sequence_state.js";
import {msg} from "../web/i18n.js";

const picture=(id,n)=>({id,mode:"Reference",type:"image",reference:`<Picture ${n}>`});

test("Reference swaps are simultaneous and deleted labels never bind to a surviving asset",()=>{
  const before=[picture("a",1),picture("b",2),picture("c",3)];
  const swap=referenceTextRemapper(before,[picture("b",1),picture("a",2),picture("c",3)]);
  assert.equal(swap("<Picture 1> meets <Picture 2>; <Picture 3>."),"<Picture 2> meets <Picture 1>; <Picture 3>.");
  const remove=referenceTextRemapper(before,[picture("b",1),picture("c",2)]);
  assert.equal(remove("<Picture 1> meets <Picture 2>; <Picture 3>."),"<Missing Picture 1> meets <Picture 1>; <Picture 2>.");
  assert.equal(swap("<Missing Picture 1> and ordinary Picture 1"),"<Missing Picture 1> and ordinary Picture 1");
  assert.equal(referenceTextRemapper(before,before)("<Picture 1>"),"<Picture 1>");
  assert.equal(referenceTextRemapper(before,[{...picture("a",1),type:"audio",reference:"<Audio 1>"}])("<Picture 1>"),"<Missing Picture 1>");
});

test("Reference media updates remap Single text and undo baselines without rewriting Sequence",async()=>{
  const source=await readFile(new URL("../web/main.js",import.meta.url),"utf8");
  const handler=source.slice(source.indexOf("function acceptMediaAssets("),source.indexOf("function bindMediaActions("));
  const before=[picture("a",1),picture("b",2)],after=[picture("b",1)];
  const fields=new Map(["[data-video-brief]","[data-output]","[data-refine-instruction]"].map(key=>[key,{value:"<Picture 2> beside <Picture 1>"}]));
  fields.set(".h3ps-editor-meta span:last-child",{});
  const sequence=newSequence();sequence.references=["b"];sequence.brief="Use reference 1";sequence.chunks[0].prompt="<Picture 1> moves";
  const original=structuredClone(sequence),notices=[];
  const studio={mode:"Reference",assets:before,modeDrafts:{Reference:{brief:"<Picture 2>",prompt:"<Picture 1>"}},
    lastModelPrompt:"<Picture 2>",refineRestore:{prompt:"<Picture 2>",lastModelPrompt:"<Picture 1>"},
    root:{querySelector:s=>fields.get(s)},sequence:{state:sequence}};
  const accept=new Function("studio","referenceTextRemapper","promptLengthMeta","updateBriefLayout","renderPromptHighlights","syncModifiedState","saveCurrentModeDraft","saveModeDrafts","localStorage","showToast","msg",handler+";return acceptMediaAssets;")(
    studio,referenceTextRemapper,s=>String(s?.length||0),()=>{},()=>{},()=>{},()=>{},()=>{},null,(...args)=>notices.push(args),msg);
  accept(after);
  for(const key of ["[data-video-brief]","[data-output]","[data-refine-instruction]"])assert.equal(fields.get(key).value,"<Picture 1> beside <Missing Picture 1>");
  assert.equal(studio.lastModelPrompt,"<Picture 1>");assert.equal(studio.refineRestore.lastModelPrompt,"<Missing Picture 1>");
  assert.equal(studio.modeDrafts.Reference.brief,"<Picture 1>");
  assert.equal(studio.assets,after);assert.equal(notices.length,1);
  assert.deepEqual(sequence,original);
  assert.deepEqual(effectiveMedia(sequence,sequence.chunks[0].id,before).map(({asset,...binding})=>binding),effectiveMedia(sequence,sequence.chunks[0].id,after).map(({asset,...binding})=>binding));
  studio.mode="T2VA";studio.assets=[picture("b",1),picture("c",2)];studio.modeDrafts.Reference={brief:"<Picture 1>",prompt:"<Picture 2>"};
  fields.get("[data-output]").value="Base prompt";
  accept([picture("c",1),picture("b",2)]);
  assert.equal(studio.modeDrafts.Reference.brief,"<Picture 2>");assert.equal(studio.modeDrafts.Reference.prompt,"<Picture 1>");
  assert.equal(fields.get("[data-output]").value,"Base prompt");
});
