import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fitTextarea} from '../web/writer_controls.js';
import {cropRect,resizeCrop,trimRange} from '../web/media_editor.js';

test('editor crop remains source-bound at all handles, ratios and snap settings',()=>{
  for(const direction of ['n','s','e','w','nw','ne','sw','se','move'])for(const ratio of [null,1,16/9,9/16])for(const delta of [-1000,-20,0,20,1000])for(const snap of [false,true]){
    const c=cropRect(resizeCrop({x:30,y:20,w:80,h:60},direction,delta,delta,160,96,ratio),160,96,snap);
    assert.ok(c.x>=0&&c.y>=0&&c.w>0&&c.h>0&&c.x+c.w<=160&&c.y+c.h<=96);
    if(snap){assert.equal(c.w%32,0);assert.equal(c.h%32,0);}
  }
  assert.deepEqual(cropRect({x:0,y:0,w:9,h:7},9,7,true),{x:0,y:0,w:9,h:7});
});
test('editor trim is source-relative and maintains a nonempty interval',()=>{
  for(const a of [-10,0,2,90])for(const b of [-10,0,3,100]){const t=trimRange(a,b,60);assert.ok(t.start>=0&&t.end>t.start&&t.end<=60);}
});
test('editor keeps draft and source separate and requests actual frame timestamps',()=>{
  const js=readFileSync(new URL('../web/media_editor.js',import.meta.url),'utf8');
  assert.match(js,/current.source_url\s*\|\|\s*current.content_url/);
  assert.match(js,/serial\('frame',\{time:t,direction:step\}\)/);
  assert.doesNotMatch(js,/1\s*\/\s*30|toDataURL|drawImage\(video/);
  assert.match(js,/data-ed-sheet alt="Media representation"/);
});
test('editor uses explicit Apply, local draft controls and independent cropped frame actions',()=>{
  const js=readFileSync(new URL('../web/media_editor.js',import.meta.url),'utf8');
  assert.doesNotMatch(js,/schedulePreview|serial\('preview'|setTimeout\(async/);
  assert.match(js,/data-ed-save>Apply/);
  assert.match(js,/type="range" min="2" max="24"/);
  assert.match(js,/data-ed-custom-row hidden/);
  assert.doesNotMatch(js,/data-ed-dimension=|<select data-ed-ratio/);
  assert.doesNotMatch(js,/window.confirm|data-ed-enlarge|data-ed-seek/);
  assert.match(js,/data-ed-discard/);
  assert.match(js,/format:'png'/);
  assert.match(js,/if\(add\)await onAddFrame\(blob,name\)/);
});


test('textarea autosizing preserves ancestor scroll offsets after temporary layout collapse',()=>{
  const workspace={scrollTop:640,parentElement:null};
  const panel={scrollTop:1200,parentElement:workspace};
  const editor={parentElement:panel,style:{height:'2000px'},get scrollHeight(){
    assert.equal(this.style.height,'auto');
    // A layout read clamps both desktop panel and narrow-layout workspace scrolling.
    panel.scrollTop=0;workspace.scrollTop=0;
    return 2020;
  }};
  fitTextarea(editor,105,2);
  assert.equal(editor.style.height,'2022px');
  assert.equal(panel.scrollTop,1200);
  assert.equal(workspace.scrollTop,640);
  fitTextarea(editor,2100);
  assert.equal(editor.style.height,'2100px');
  assert.equal(panel.scrollTop,1200);
  assert.equal(workspace.scrollTop,640);
});
