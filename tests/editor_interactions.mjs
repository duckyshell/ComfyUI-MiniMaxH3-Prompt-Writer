import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaEditor} from '../web/media_editor.js';

// A small DOM boundary double: exercise handlers, state and API calls without a browser.
function fixture(t, options={}){
  const globals=['document','window','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'];
  const originals=Object.fromEntries(globals.map(k=>[k,globalThis[k]]));
  t.after(()=>{for(const k of globals)globalThis[k]=originals[k];});
  const camel=s=>s.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
  class Element {
    constructor(tag='',attrs=''){
      this.tagName=tag.toUpperCase();this.dataset={};this.attrs={};this.style={};this.handlers={};
      for(const [,name,value] of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)){
        this.attrs[name]=value??'';
        if(name.startsWith('data-'))this.dataset[camel(name.slice(5))]=value??'';
      }
      const classes=new Set((this.attrs.class||'').split(' '));
      this.classList={contains:k=>classes.has(k),add:(...ks)=>ks.forEach(k=>classes.add(k)),remove:(...ks)=>ks.forEach(k=>classes.delete(k)),toggle:(k,on=!classes.has(k))=>{on?classes.add(k):classes.delete(k);return on;}};
      this.hidden='hidden' in this.attrs;this.disabled=false;this.value=this.attrs.value||'';
      this.currentTime=0;this.clientWidth=800;this.clientHeight=600;
    }
    querySelectorAll(selector){
      return (this.nodes||[]).filter(n=>selector.split(',').some(s=>{
        s=s.trim();
        if(s.startsWith('[')){const [,attr,value]=s.match(/^\[([\w-]+)(?:="([^"]*)")?\]/)||[];return attr in n.attrs&&(value===undefined||value===n.attrs[attr]);}
        if(s.startsWith('.'))return n.classList.contains(s.slice(1));
        if(s.startsWith('#'))return n.attrs.id===s.slice(1);
        return n.tagName===s.toUpperCase();
      }));
    }
    querySelector(s){return this.querySelectorAll(s)[0]||null;}
    set innerHTML(html){
      this.html=html;
      this.firstElementChild=new Element('section');
      this.firstElementChild.nodes=[...html.matchAll(/<([a-z]+)\b([^>]*)>/g)].map(([,tag,attrs])=>new Element(tag,attrs));
      const playback=this.firstElementChild.querySelector('[data-ed-play]');
      if(playback)playback.html=html.match(/<button[^>]*data-ed-play\b[^>]*>([\s\S]*?)<\/button>/)?.[1]||'';
    }
    get innerHTML(){return this.html||'';}
    addEventListener(k,fn){this.handlers[k]=fn;}
    removeEventListener(){}
    setAttribute(k,v){this.attrs[k]=v;}
    removeAttribute(k){delete this.attrs[k];}
    closest(s){return s==='[data-ed-bound]' && this.attrs['data-ed-bound']!==undefined ? this : null;}
    append(el){(this.children||=[]).push(el);}
    replaceChildren(){this.children=[];}
    setPointerCapture(){}
    getBoundingClientRect(){return {left:0,top:0,width:1000,height:58};}
    click(){if(this.tagName==='A')downloads.push({name:this.download,url:this.href});}
    focus(){document.activeElement=this;}
    pause(){this.paused=true;}
    load(){}
    remove(){}
  }
  const root=new Element();
  root.append=el=>{root.el=el;};
  globalThis.document={createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){},activeElement:null};
  globalThis.window={confirm:()=>false};
  globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  globalThis.requestAnimationFrame=fn=>{if(options.frames)options.frames.push(fn);else fn();return 1;};
  globalThis.cancelAnimationFrame=()=>{};
  const asset={id:'v',type:'video',mode:'Reference',filename:'clip.mp4',width:544,height:960,duration:8,
    source:{width:544,height:960,duration:8},source_url:'source',contact_sheet_url:'applied-0',frames:Array(6),frame_count_mode:'auto'};
  Object.assign(asset, options.asset);
  const calls=[],saved=[],errors=[],opened=[],pictures=[],audio=[],downloads=[];
  const editor=createMediaEditor({root,icon:name=>`<svg data-icon="${name}"></svg>`,notify:m=>errors.push(m),onOpenChange:v=>opened.push(v),onSaved:r=>saved.push(r),
    onAddFrame:async(blob,name)=>pictures.push({blob,name}),
    onAddAudio:async(blob,name)=>audio.push({blob,name}),
    request:async(id,body)=>{
      calls.push(body);
      if(options.wait)await options.wait;
      if(body.action==='audio')return new Blob(['audio'],{type:'audio/wav'});
      if(body.action==='frame')return {image:'data:image/png;base64,aGVsbG8='};
      if(body.action==='save')return {assets:[{...asset,content_revision:1,edit:{...body,crop:{...body.crop}},contact_sheet_url:'applied-1'}]};
      throw new Error('Unexpected request');
    }});
  const $=s=>root.el.querySelector(s);
  editor.open(asset);
  $('[data-ed-video]').onloadeddata();
  return {editor,$,calls,saved,errors,opened,root,pictures,audio,downloads};
}

test('playback control follows native play, pause and ended events',t=>{
  const f=fixture(t);
  const video=f.$('[data-ed-video]');
  const control=f.$('[data-ed-play]');
  const assertState=(name,pressed)=>{
    assert.match(control.innerHTML,new RegExp(`data-icon="${name}"`));
    assert.equal(control.attrs['aria-pressed'],String(pressed));
    assert.equal(control.attrs['aria-label'],pressed?'Pause':'Play');
  };
  assert.match(control.innerHTML,/data-icon="play"/);
  assert.equal(typeof video.onplay,'function','native play must update the control');
  video.paused=false;
  video.onplay();
  assertState('pause',true);
  video.paused=true;
  video.onpause();
  assertState('play',false);
  video.paused=false;
  video.onplay();
  video.ended=true;
  video.onended();
  assertState('play',false);
});

test('editor changes stay local; Apply updates model view and keeps the editor open',async t=>{
  const f=fixture(t);
  assert.equal(f.calls.length,0);assert.equal(f.$('[data-ed-sheet]').src,'applied-0');
  f.$('[data-ed-ratio="1:1"]').onclick();
  f.$('[data-ed-custom]').onclick();
  const count=f.$('[data-ed-custom-count]');count.value='24';count.valueAsNumber=24;count.oninput({target:count});
  assert.equal(f.calls.length,0);assert.equal(f.$('[data-ed-sheet]').src,'applied-0');
  assert.equal(f.$('[data-ed-save]').disabled,false);
  await f.$('[data-ed-save]').onclick();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'save');assert.equal(f.calls[0].frame_count_mode,'24');
  assert.equal(f.calls[0].crop.w,f.calls[0].crop.h);
  assert.equal(f.$('[data-ed-sheet]').src,'applied-1');assert.deepEqual(f.opened,[true]);assert.deepEqual(f.errors,[]);
  assert.equal(f.editor.close(),true);assert.equal(f.editor.close(),true);
});

test('discard decline preserves draft and model view; Reset still uses original dimensions',t=>{
  const f=fixture(t);
  f.$('[data-ed-ratio="1:1"]').onclick();
  assert.equal(f.editor.close(),false);assert.deepEqual(f.opened,[true]);
  f.$('[data-ed-reset]').onclick();
  assert.match(f.$('[data-ed-dimensions]').textContent,/544 × 960/);
  assert.equal(f.calls.length,0);assert.equal(f.$('[data-ed-sheet]').src,'applied-0');
  assert.equal(f.editor.close(),true);
});

test('slider change-only events enable Apply, Preparing locks repeat clicks, and success restores Apply',async t=>{
  let resolve;const wait=new Promise(r=>{resolve=r;});
  const f=fixture(t,{wait});
  f.$('[data-ed-custom]').onclick();
  const count=f.$('[data-ed-custom-count]');count.value='16';count.onchange();
  assert.equal(f.$('[data-ed-save]').disabled,false);
  const first=f.$('[data-ed-save]').onclick();
  assert.equal(f.$('[data-ed-save]').textContent,'Preparing…');
  assert.equal(f.$('[data-ed-save]').disabled,true);
  await f.$('[data-ed-save]').onclick();
  resolve();await first;
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].frame_count_mode,'16');
  assert.equal(f.$('[data-ed-save]').textContent,'Apply');
});
test('staged preview is honest; close confirmation is contextual and reset includes sampling',t=>{
  const f=fixture(t,{asset:{status:'needs_edit',reference:null}});
  assert.equal(f.$('[data-ed-view-title]').textContent,'Source preview');
  assert.equal(f.$('[data-ed-view-subtitle]').textContent,'Not a Reference');
  f.$('[data-ed-custom]').onclick();
  assert.equal(f.editor.close(),false);
  assert.equal(f.$('[data-ed-close-popover]').hidden,false);
  f.$('[data-ed-keep]').onclick();assert.equal(f.$('[data-ed-close-popover]').hidden,true);
  f.$('[data-ed-reset]').onclick();
  assert.equal(f.$('[data-ed-custom-row]').hidden,true);
  f.$('[data-ed-ratio="1:1"]').onclick();
  f.editor.close();f.$('[data-ed-discard]').onclick();
  assert.deepEqual(f.opened,[true,false]);
});
test('Resample changes the draft only; current-frame Picture uses crop without applying the video',async t=>{
  const f=fixture(t);
  f.$('[data-ed-resample]').onclick();assert.equal(f.calls.length,0);
  f.$('[data-ed-ratio="1:1"]').onclick();
  f.$('[data-ed-video]').currentTime=2.4;
  await f.$('[data-ed-frame-add]').onclick();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'frame');
  assert.equal(f.calls[0].time,2.4);assert.equal(f.calls[0].crop.w,f.calls[0].crop.h);
  assert.equal(f.saved.length,0);assert.equal(f.pictures.length,1);
  assert.equal(f.$('[data-ed-sheet]').src,'applied-0');
});

test('long staged Apply and realtime timeline feedback remain independent of Reference eligibility',async t=>{
  const f=fixture(t,{asset:{status:'needs_edit',reference:null,duration:30,source:{width:544,height:960,duration:30}}});
  f.$('[data-ed-custom]').onclick();
  const count=f.$('[data-ed-custom-count]');count.value='24';count.oninput();
  assert.equal(f.$('[data-ed-save]').disabled,false);
  await f.$('[data-ed-save]').onclick();
  assert.equal(f.calls[0].end,30);assert.equal(f.calls[0].frame_count_mode,'24');
  const track=f.$('[data-ed-track]'),handle=f.$('[data-ed-bound="start"]');
  track.onpointerdown({button:0,target:handle,clientX:100,pointerId:1,preventDefault(){}});
  track.onpointermove({clientX:200});
  assert.match(f.$('[data-ed-selection]').textContent,/00:06.0 → 00:30.0 · 24.0 s/);
  assert.equal(handle.style.left,'20%');
  assert.equal(f.$('[data-ed-dim-left]').style.width,'20%');
  assert.equal(f.calls.length,1);
  track.onpointerup();
  await f.$('[data-ed-save]').onclick();
  assert.equal(f.calls[1].start,6);assert.equal(f.calls[1].end,30);
});


test('audio extraction explains invalid selection, downloads and adds a trimmed reference without applying the video',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t,{asset:{duration:30,source:{width:544,height:960,duration:30,has_audio:true}}});
  const button=f.$('[data-ed-audio]');
  assert.equal(button.hidden,false);
  assert.equal(button.disabled,false);
  await button.onclick();
  assert.deepEqual(f.errors,['Select 2-15 seconds on the timeline to extract an audio reference.']);
  assert.equal(f.calls.length,0);
  f.$('[data-ed-video]').currentTime=8;
  f.$('[data-ed-out]').onclick();
  await button.onclick();
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].action,'audio');
  assert.equal(f.calls[0].start,0);
  assert.equal(f.calls[0].end,8);
  assert.equal(f.audio[0].name,'clip-audio.wav');
  assert.equal(f.downloads[0].name,'clip-audio.wav');
  assert.equal(await (await fetch(f.downloads[0].url)).text(),'audio');
  t.mock.timers.tick(60000);
  assert.equal(f.saved.length,0);
});


test("closed editor releases modality and cannot receive delayed opening focus", (t) => {
  const frames = [],
    f = fixture(t, { frames });
  const dialog = f.$(".h3ps-ed-dialog");
  assert.equal(dialog.attrs["aria-modal"], "true");
  assert.equal(f.editor.close(), true);
  assert.equal(dialog.attrs["aria-modal"], undefined);
  document.activeElement = null;
  frames.splice(0).forEach((fn) => fn());
  assert.equal(document.activeElement, null);
});

test("discard confirmation keeps the editor modal until closing is accepted", (t) => {
  const f = fixture(t),
    dialog = f.$(".h3ps-ed-dialog");
  f.$('[data-ed-ratio="1:1"]').onclick();
  assert.equal(f.editor.close(), false);
  assert.equal(dialog.attrs["aria-modal"], "true");
  f.$("[data-ed-discard]").onclick();
  assert.equal(dialog.attrs["aria-modal"], undefined);
});
