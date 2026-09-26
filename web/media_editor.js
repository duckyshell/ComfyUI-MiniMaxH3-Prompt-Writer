const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const timecode = seconds => {
  const tenths=Math.round(Math.max(0,seconds||0)*10);
  return String(Math.floor(tenths/600)).padStart(2,'0')+':'+String(Math.floor(tenths/10)%60).padStart(2,'0')+'.'+tenths%10;
};
const ratios = ['free','original','1:1','2:3','3:2','3:4','4:3','9:16','16:9','21:9'];

export function cropRect(rect, width, height, snap=false) {
  const step = snap && width>=32 && height>=32 ? 32 : 1;
  const w=clamp(Math.round(rect.w/step)*step,step,Math.floor(width/step)*step);
  const h=clamp(Math.round(rect.h/step)*step,step,Math.floor(height/step)*step);
  return {x:clamp(Math.round(rect.x),0,width-w),y:clamp(Math.round(rect.y),0,height-h),w,h};
}

export function resizeCrop(initial, direction, dx, dy, width, height, ratio=null) {
  if(direction==='move')return {...initial,x:clamp(initial.x+dx,0,width-initial.w),y:clamp(initial.y+dy,0,height-initial.h)};
  const west=direction.includes('w'),north=direction.includes('n');
  const anchorX=west?initial.x+initial.w:initial.x,anchorY=north?initial.y+initial.h:initial.y;
  let w=direction.match(/[we]/)?Math.max(1,initial.w+(west?-dx:dx)):initial.w;
  let h=direction.match(/[ns]/)?Math.max(1,initial.h+(north?-dy:dy)):initial.h;
  if(ratio){if(direction.match(/[we]/))h=w/ratio;else w=h*ratio;}
  const maxW=west?anchorX:width-anchorX,maxH=north?anchorY:height-anchorY;
  if(ratio){const k=Math.min(1,maxW/w,maxH/h);w*=k;h*=k;}else{w=Math.min(w,maxW);h=Math.min(h,maxH);}
  return {x:west?anchorX-w:anchorX,y:north?anchorY-h:anchorY,w,h};
}

export function trimRange(start,end,duration) {
  start=clamp(Number(start)||0,0,Math.max(0,duration-.001));
  end=clamp(Number(end)||0,start+.001,duration);
  return {start,end};
}

function markup(icon) {
  return `<section class="h3ps-media-editor" aria-hidden="true">
    <div class="h3ps-preview-backdrop" data-ed-close></div>
    <div class="h3ps-cmp-dialog h3ps-ed-dialog" role="dialog" aria-labelledby="h3ps-ed-title" tabindex="-1">
      <header><span><small>Media Editor</small><strong id="h3ps-ed-title"></strong></span><div class="h3ps-cmp-shell-controls" data-ed-shell><button type="button" class="h3ps-icon-button" data-ed-close title="Close (Esc)" aria-label="Close editor">${icon('close',18)}</button><div class="h3ps-ed-close-popover" data-ed-close-popover hidden role="group" aria-label="Unapplied changes"><strong>Unapplied changes</strong><span><button type="button" class="h3ps-secondary-button" data-ed-keep>Keep</button><button type="button" class="h3ps-secondary-button" data-ed-discard>Discard</button></span></div></div></header>
      <div class="h3ps-ed-body">
        <div class="h3ps-ed-workspace">
          <div class="h3ps-ed-viewport" data-ed-stage>
            <div class="h3ps-ed-frame" data-ed-frame>
              <img data-ed-image alt="Source media" draggable="false">
              <video data-ed-video playsinline preload="auto"></video>
              <img class="h3ps-ed-decoded" data-ed-decoded alt="Decoded source frame" draggable="false" hidden>
              <div class="h3ps-ed-crop" data-ed-crop tabindex="0" aria-label="Crop rectangle. Drag to move or use arrow keys.">
                ${['nw','n','ne','e','se','s','sw','w'].map(dir=>`<i data-ed-handle="${dir}" class="h3ps-ed-handle is-${dir}"></i>`).join('')}
              </div>
            </div>
          </div>
          <section class="h3ps-ed-crop-tools">
            <div class="h3ps-frame-count h3ps-ed-ratios" role="group" aria-label="Crop aspect ratio">${ratios.map(r=>`<button type="button" data-ed-ratio="${r}">${r==='free'?'Free':r==='original'?'Original':r}</button>`).join('')}</div>
            <div class="h3ps-ed-crop-summary"><output data-ed-dimensions></output><span class="h3ps-ed-utilities"><label class="h3ps-ed-check"><input type="checkbox" data-ed-snap>Snap ×32</label><label class="h3ps-ed-check" data-ed-loop-control><input type="checkbox" data-ed-loop>Loop</label></span></div>
          </section>
          <section class="h3ps-ed-timeline" data-ed-temporal>
            <div class="h3ps-ed-playback"><button type="button" class="h3ps-icon-button" data-ed-play aria-label="Play or pause">${icon('play',20)}</button><button type="button" class="h3ps-icon-button" data-ed-step="-1" title="Previous frame" aria-label="Previous frame">${icon('chevron',20)}</button><button type="button" class="h3ps-icon-button" data-ed-step="1" title="Next frame" aria-label="Next frame">${icon('chevron',20)}</button><output data-ed-time>00:00.0 / 00:00.0</output><button type="button" class="h3ps-icon-button" data-ed-frame-download title="Download current frame with draft crop" aria-label="Download current frame">${icon('download',20)}</button><button type="button" class="h3ps-icon-button" data-ed-frame-add title="Add current frame with draft crop as Picture" aria-label="Add current frame as Picture">${icon('image',20)}${icon('plus',12)}</button><button type="button" class="h3ps-icon-button" data-ed-audio hidden title="Download audio and add to workspace (2-15 seconds). Writer does not analyze sound. Connect the WAV separately in H3 and describe its role in the Brief." aria-label="Download audio and add to workspace">${icon('audio',20)}</button><button class="h3ps-cmp-text-action" type="button" data-ed-in>Set Start</button><button class="h3ps-cmp-text-action" type="button" data-ed-out>Set End</button></div>
            <div class="h3ps-ed-track" data-ed-track tabindex="0" role="slider" aria-label="Source playhead" aria-valuemin="0">
              <div class="h3ps-ed-filmstrip" data-ed-filmstrip aria-hidden="true"></div><span class="h3ps-ed-dim" data-ed-dim-left></span><span class="h3ps-ed-dim" data-ed-dim-right></span><div class="h3ps-ed-trim" data-ed-trim></div><i class="h3ps-ed-playhead" data-ed-playhead></i><button type="button" data-ed-bound="start" aria-label="Drag trim start"></button><button type="button" data-ed-bound="end" aria-label="Drag trim end"></button></div>

            <div class="h3ps-ed-ticks" data-ed-ticks aria-hidden="true"></div>
            <output class="h3ps-ed-selection" data-ed-selection></output>
          </section>
        </div>
        <aside class="h3ps-ed-side">
          <section class="h3ps-ed-analysis">
            <div class="h3ps-section-heading"><span><small data-ed-view-title>What the model sees</small><strong data-ed-view-subtitle>Applied media</strong></span></div>
            <div data-ed-sampling>
              <div class="h3ps-sample-controls"><div class="h3ps-frame-count">${['auto','4','6','8'].map(n=>`<button type="button" data-ed-count="${n}">${n==='auto'?'Auto':n}</button>`).join('')}<button type="button" data-ed-custom>Custom</button></div><label class="h3ps-endpoints"><input type="checkbox" data-ed-endpoints>First + last frame</label><button type="button" class="h3ps-secondary-button" data-ed-resample title="Choose a new sampled frame set; Apply to prepare it">Resample</button></div>
              <label class="h3ps-ed-custom" data-ed-custom-row hidden>Frames <input type="range" min="2" max="24" step="1" data-ed-custom-count aria-label="Custom frame count"><output data-ed-count-value></output></label>
            </div>
            <p class="h3ps-ed-note" data-ed-analysis-state role="status"></p>
            <div class="h3ps-ed-model-view"><img data-ed-sheet alt="Media representation" hidden></div>
          </section>
        </aside>
      </div>
      <footer><span data-ed-status role="status"></span><button type="button" class="h3ps-secondary-button" data-ed-reset>Reset edits</button><button type="button" class="h3ps-secondary-button" data-ed-download>${icon('download',14)}Download</button><button type="button" class="h3ps-primary-button" data-ed-save>Apply</button></footer>
    </div>
  </section>`;
}

export function createMediaEditor({root,icon,request,onSaved,onAddFrame,onAddAudio,notify,onOpenChange}) {
  const wrapper=document.createElement('div');wrapper.innerHTML=markup(icon);
  const el=wrapper.firstElementChild;root.append(el);
  const $=s=>el.querySelector(s),$$=s=>[...el.querySelectorAll(s)];
  const video=$('[data-ed-video]'),image=$('[data-ed-image]'),decoded=$('[data-ed-decoded]');
  const stage=$('[data-ed-stage]'),frame=$('[data-ed-frame]'),box=$('[data-ed-crop]');
  let asset=null,source=null,edit=null,ratio=null,snap=false,trigger=null,homes=[];
  let applied='', customMode=false, ratioName='free', confirming=false, saving=false, loop=false;
  let version=0,epoch=0,queue=Promise.resolve(),busy=false,drag=null,trimDrag=null,loading=false,raf=0,mediaReady=false;
  const isVideo=()=>asset?.type==='video';
  const payload=()=>({...edit,crop:{...edit.crop},revision:asset.content_revision||0});
  function serial(action,body={}) {
    const id=asset.id,e=epoch;
    const next=queue.catch(()=>{}).then(()=>{
      if(e!==epoch)return null;
      return request(id,{action,...body});
    });queue=next;return next;
  }
  function setBusy(value){busy=value;el.classList.toggle('is-busy',value);$$('button,input,select').forEach(c=>{if(!c.closest('[data-ed-shell]'))c.disabled=value});sync();}
  function syncPlaybackControl() {
    const playing = !video.paused && !video.ended;
    const control = $('[data-ed-play]');
    control.innerHTML = icon(playing ? 'pause' : 'play', 20);
    control.setAttribute('aria-pressed', String(playing));
    control.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    control.title = playing ? 'Pause' : 'Play';
  }
  function stop() {
    video.pause();
    cancelAnimationFrame(raf);
    syncPlaybackControl();
  }
  function position(){
    if(!source)return;
    const k=Math.min(Math.max(1,stage.clientWidth-16)/source.width,Math.max(1,stage.clientHeight-16)/source.height);
    frame.style.width=source.width*k+'px';frame.style.height=source.height*k+'px';
    const c=edit.crop;Object.assign(box.style,{left:c.x/source.width*100+'%',top:c.y/source.height*100+'%',width:c.w/source.width*100+'%',height:c.h/source.height*100+'%'});
  }
  function syncTime(){
    const t=video.currentTime||0,D=source?.duration||1;
    $('[data-ed-time]').textContent=timecode(t)+' / '+timecode(source?.duration);
    $('[data-ed-track]').setAttribute('aria-valuenow',String(t));
    $('[data-ed-track]').setAttribute('aria-valuemax',String(source?.duration||0));
    $('[data-ed-playhead]').style.left=t/D*100+'%';
  }
  function sync(){
    if(!asset)return;
    position();
    $('[data-ed-dimensions]').textContent=`${edit.crop.w} × ${edit.crop.h} · ${(edit.crop.w*edit.crop.h/1e6).toFixed(2)} MP`;
    $$('[data-ed-ratio]').forEach(b=>{const active=b.dataset.edRatio===ratioName;b.classList.toggle('is-active',active);b.setAttribute('aria-pressed',String(active));});
    $('[data-ed-snap]').checked=snap;
    const duration=edit.end-edit.start;
    $('[data-ed-selection]').textContent='Selected '+timecode(edit.start)+' → '+timecode(edit.end)+' · '+duration.toFixed(1)+' s';
    $('[data-ed-dim-left]').style.width=edit.start/(source.duration||1)*100+'%';
    $('[data-ed-dim-right]').style.left=edit.end/(source.duration||1)*100+'%';
    $('[data-ed-trim]').style.left=edit.start/(source.duration||1)*100+'%';$('[data-ed-trim]').style.width=duration/(source.duration||1)*100+'%';
    $$('[data-ed-bound]').forEach(b=>b.style.left=edit[b.dataset.edBound]/(source.duration||1)*100+'%');
    const invalid=isVideo()&&asset.mode==='Reference'&&(duration<2||duration>15.1);
    $('[data-ed-save]').textContent=saving?'Preparing…':'Apply';
    $('[data-ed-close-popover]').hidden=!confirming;
    $('[data-ed-view-title]').textContent=asset.status==='needs_edit'?'Source preview':'What the model sees';
    $('[data-ed-view-subtitle]').textContent=asset.status==='needs_edit'?'Not a Reference':'Applied media';
    $('[data-ed-save]').disabled=busy||loading||!mediaReady||!dirty();
    $('[data-ed-download]').disabled=busy||loading||!mediaReady;
    $('[data-ed-audio]').hidden=!isVideo() || !source.has_audio;
    $('[data-ed-audio]').disabled=busy||loading||!mediaReady;
    $('[data-ed-status]').textContent=busy?'Processing media…':loading?'Loading source…':invalid?'H3 Reference requires 2–15 s. Edits can still be applied.':dirty()?'Unapplied changes':'Edits saved';
    $$('[data-ed-count]').forEach(b=>{const active=!customMode&&b.dataset.edCount===edit.frame_count_mode;b.classList.toggle('is-active',active);b.setAttribute('aria-pressed',String(active));});
    $('[data-ed-custom-row]').hidden=!customMode;
    $('[data-ed-custom]').classList.toggle('is-active',customMode);$('[data-ed-custom]').setAttribute('aria-pressed',String(customMode));
    if(customMode){$('[data-ed-custom-count]').value=edit.frame_count_mode;$('[data-ed-count-value]').textContent=edit.frame_count_mode;}
    $('[data-ed-analysis-state]').textContent=dirty()?'Unapplied changes · saved preview unchanged':asset.status==='needs_edit'?'H3 Reference requires 2–15 s':isVideo()?`${asset.frames?.length||asset.frame_count||0} applied frames`:'Applied Picture';
    $('[data-ed-endpoints]').checked=edit.include_endpoints;
    syncTime();
  }
  const dirty=()=>!!asset&&JSON.stringify(edit)!==applied;
  function changed(){version++;confirming=false;sync();}
  function timelineView(){
    const strip=$('[data-ed-filmstrip]');strip.replaceChildren();
    const samples=(asset.frames||[]).filter(f=>f?.url),start=asset.edit?.start||0,end=asset.edit?.end||source.duration;
    for(let i=0;i<samples.length&&source.duration;i++){
      const f=samples[i],left=i?start+(samples[i-1].timestamp+f.timestamp)/2:start;
      const right=i+1<samples.length?start+(f.timestamp+samples[i+1].timestamp)/2:end;
      const img=document.createElement('img');img.src=f.url;img.alt='';img.draggable=false;
      // Existing samples are relative to the saved selection, not the draft trim.
      img.style.left=clamp(left/source.duration*100,0,100)+'%';
      img.style.width=clamp((right-left)/source.duration*100,0,100)+'%';
      strip.append(img);
    }
    $('[data-ed-ticks]').textContent='';
    for(const fraction of [0,.25,.5,.75,1]){
      const tick=document.createElement('span');tick.textContent=timecode(fraction*(source.duration||0));
      $('[data-ed-ticks]').append(tick);
    }
  }
  function appliedView(){
    const sheet=$('[data-ed-sheet]');
    const url=isVideo()?asset.contact_sheet_url:asset.prepared_url;
    sheet.hidden=!url;if(url)sheet.src=url;else sheet.removeAttribute('src');
  }
  async function seek(t,step=null){
    if(!isVideo()||busy)return;
    stop();const e=epoch; t=clamp(t,0,source.duration);
    decoded.hidden=true;video.currentTime=t;syncTime();
    if(step===null)return;
    try{const result=await serial('frame',{time:t,direction:step});if(!asset||e!==epoch)return;
      video.currentTime=result.timestamp;decoded.src=result.image;decoded.hidden=false;syncTime();
    }catch(error){notify(error.message);}
  }
  function play(){
    if(busy||loading||!mediaReady)return;
    if(!video.paused){stop();return;}
    decoded.hidden=true;if(video.currentTime<edit.start||video.currentTime>=edit.end)video.currentTime=edit.start;
    video.play().then(()=>{tick();}).catch(error=>notify(error.message));
  }
  function tick(){if(!asset||video.paused)return;if(video.currentTime>=edit.end){if(loop)video.currentTime=edit.start;else{stop();video.currentTime=edit.end;syncTime();return;}}syncTime();raf=requestAnimationFrame(tick);}
  function ended(){if(loop&&asset){video.currentTime=edit.start;play();}else stop();}
  function setTrim(start,end){Object.assign(edit,trimRange(start,end,source.duration));changed();}
  function setRatio(value){
    ratioName=value;
    ratio=value==='free'?null:value==='original'?source.width/source.height:value.split(':').map(Number).reduce((a,b)=>a/b);
    if(ratio){const c=edit.crop,w=Math.sqrt(c.w*c.h*ratio),h=w/ratio,k=Math.min(1,source.width/w,source.height/h);
      edit.crop=cropRect({x:c.x+(c.w-w*k)/2,y:c.y+(c.h-h*k)/2,w:w*k,h:h*k},source.width,source.height,snap);}
    changed();
  }
  function reset(){stop();ratio=null;ratioName='free';snap=false;customMode=false;edit.frame_count_mode='auto';edit.include_endpoints=true;edit.sample_index=0;edit.crop={x:0,y:0,w:source.width,h:source.height};edit.start=0;edit.end=source.duration||0;decoded.hidden=true;if(isVideo())video.currentTime=0;changed();}
  function download(blob,name){
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  async function currentFrame(add){
    if(busy||loading||!mediaReady||!isVideo())return;
    stop();setBusy(true);
    try{
      const result=await serial('frame',{time:video.currentTime,direction:0,crop:{...edit.crop},format:'png'});
      const blob=await (await fetch(result.image)).blob(),name=(asset.filename.replace(/\.[^.]+$/,'')||'video')+'-frame.png';
      if(add)await onAddFrame(blob,name);else download(blob,name);
    }catch(error){notify(error.message);}finally{setBusy(false);}
  }
  async function run(action){
    if(busy||loading||!mediaReady||!asset)return;
    if(action==='audio'&&(edit.end-edit.start<2||edit.end-edit.start>15)){
      notify('Select 2-15 seconds on the timeline to extract an audio reference.');return;
    }
    if(action==='save'){readSampling();if($('[data-ed-save]').disabled)return;}
    stop();saving=action==='save';setBusy(true);
    try{
      const result=await serial(action,payload());
      if(action==='save'){
        const updated=result.assets.find(a=>a.id===asset.id);
        if(!updated)throw new Error('Applied media is no longer available.');
        asset=updated;
        edit={...edit,...asset.edit,crop:{...(asset.edit?.crop||edit.crop)}};
        applied=JSON.stringify(edit);appliedView();timelineView();await onSaved(result);
      }else if(action==='audio'){
        const name=(asset.filename.replace(/\.[^.]+$/,'')||'video')+'-audio.wav';
        download(result,name);await onAddAudio(result,name);
      }
      else download(result,(asset.filename.replace(/\.[^.]+$/,'')||'media')+'-edited'+(isVideo()?'.mp4':'.png'));
    }catch(error){notify(error.message);}finally{saving=false;setBusy(false);}
  }
  $$('[data-ed-close]').forEach(b=>b.addEventListener('click',()=>close()));
  $('[data-ed-audio]').onclick=()=>run('audio');
  $('[data-ed-reset]').onclick=reset;$('[data-ed-download]').onclick=()=>run('download');$('[data-ed-save]').onclick=()=>run('save');
  $$('[data-ed-ratio]').forEach(b=>b.onclick=()=>setRatio(b.dataset.edRatio));
  $('[data-ed-frame-download]').onclick=()=>currentFrame(false);$('[data-ed-frame-add]').onclick=()=>currentFrame(true);
  $('[data-ed-keep]').onclick=()=>{confirming=false;sync();};
  $('[data-ed-discard]').onclick=()=>close(true);
  $('[data-ed-snap]').onchange=e=>{snap=e.target.checked;edit.crop=cropRect(edit.crop,source.width,source.height,snap);changed();};
  box.onpointerdown=e=>{if(busy||loading||e.button!==0)return;stop();box.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,rect:{...edit.crop},direction:e.target.dataset.edHandle||'move'};e.preventDefault();};
  box.onpointermove=e=>{if(!drag)return;const k=frame.clientWidth/source.width;edit.crop=cropRect(resizeCrop(drag.rect,drag.direction,(e.clientX-drag.x)/k,(e.clientY-drag.y)/k,source.width,source.height,ratio),source.width,source.height,snap);changed();};
  box.onpointerup=box.onpointercancel=()=>{drag=null;};
  box.onkeydown=e=>{if(busy||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const step=e.shiftKey?10:1;edit.crop=cropRect({...edit.crop,x:edit.crop.x+(e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0),y:edit.crop.y+(e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0)},source.width,source.height,snap);changed();};
  $('[data-ed-play]').onclick=play;video.ontimeupdate=syncTime;video.onended=ended;
  video.onplay = syncPlaybackControl;
  video.onpause = syncPlaybackControl;
  $('[data-ed-loop]').onchange=e=>{loop=e.target.checked;};
  $$('[data-ed-step]').forEach(b=>b.onclick=()=>seek(video.currentTime,Number(b.dataset.edStep)));
  $('[data-ed-in]').onclick=()=>setTrim(Math.min(video.currentTime,edit.end-.001),edit.end);
  $('[data-ed-out]').onclick=()=>setTrim(edit.start,Math.max(video.currentTime,edit.start+.001));
  const track=$('[data-ed-track]');
  const trackMove=e=>{const r=track.getBoundingClientRect(),t=clamp((e.clientX-r.left)/r.width*source.duration,0,source.duration);if(trimDrag==='start'){setTrim(Math.min(t,edit.end-.001),edit.end);seek(edit.start);}else if(trimDrag==='end'){setTrim(edit.start,Math.max(t,edit.start+.001));seek(edit.end);}else seek(t);};
  track.onpointerdown=e=>{if(busy||loading||!mediaReady||e.button!==0)return;trimDrag=e.target.closest('[data-ed-bound]')?.dataset.edBound||'seek';track.setPointerCapture(e.pointerId);stop();trackMove(e);e.preventDefault();};track.onpointermove=e=>{if(trimDrag)trackMove(e);};track.onpointerup=track.onpointercancel=()=>{trimDrag=null;};
  $$('[data-ed-count]').forEach(b=>b.onclick=()=>{customMode=false;edit.frame_count_mode=b.dataset.edCount;edit.sample_index=0;changed();});
  $('[data-ed-custom]').onclick=()=>{customMode=true;edit.frame_count_mode=edit.frame_count_mode==='auto'?'6':edit.frame_count_mode;changed();$('[data-ed-custom-count]').focus();};
  function readSampling(){
    if(!customMode)return;
    const control=$('[data-ed-custom-count]'),n=Number(control.value);
    if(!Number.isInteger(n)||n<2||n>24)return;
    if(edit.frame_count_mode!==String(n)){edit.frame_count_mode=String(n);edit.sample_index=0;changed();}
  }
  $('[data-ed-custom-count]').oninput=$('[data-ed-custom-count]').onchange=readSampling;
  $('[data-ed-resample]').onclick=()=>{edit.sample_index=(edit.sample_index||0)+1;changed();};
  $('[data-ed-endpoints]').onchange=e=>{edit.include_endpoints=e.target.checked;edit.sample_index=0;changed();};
  track.onkeydown=e=>{if(!isVideo()||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();seek(e.key==='Home'?0:e.key==='End'?source.duration:video.currentTime+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?1:.1));};
  el.addEventListener('pointerdown',e=>{if(confirming&&!e.target.closest('[data-ed-close-popover], [data-ed-close]')){confirming=false;sync();}});
  const observer=new ResizeObserver(position);observer.observe(stage);
  const onKey=e=>{if(!asset)return;if(e.key==='Escape'){e.preventDefault();if(confirming){confirming=false;sync();return;}const menu=root.querySelector('[data-interface-size-menu]');if(menu&&!menu.hidden){root.querySelector('[data-interface-size-toggle]').click();return;}close();}else if(e.code==='Space'&&isVideo()&&!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName)){e.preventDefault();play();}};
  document.addEventListener('keydown',onKey);
  function open(current, opener) {
    if (asset) return;
    asset = current;
    source = { ...(current.source || current) };
    epoch++;
    version = 0;
    trigger = opener || document.activeElement;
    mediaReady = false;
    loading = true;
    edit = {
      crop: { x: 0, y: 0, w: source.width, h: source.height },
      start: 0,
      end: source.duration || 0,
      ...current.edit,
      frame_count_mode: current.frame_count_mode || "auto",
      include_endpoints: current.include_endpoints !== false,
      sample_index: current.sample_index || 0,
    };
    edit.crop = { ...edit.crop };
    applied = JSON.stringify(edit);
    customMode = !["auto", "4", "6", "8"].includes(edit.frame_count_mode);
    ratio = null;
    ratioName = "free";
    snap = false;
    confirming = false;
    saving = false;
    loop = false;
    $("[data-ed-loop]").checked = false;
    $("#h3ps-ed-title").textContent = current.filename;
    $("[data-ed-temporal]").hidden =
      $("[data-ed-sampling]").hidden =
      $("[data-ed-loop-control]").hidden =
        !isVideo();
    image.hidden = isVideo();
    video.hidden = !isVideo();
    decoded.hidden = true;
    const e = epoch,
      ready = () => {
        if (!asset || e !== epoch) return;
        loading = false;
        mediaReady = true;
        sync();
      };
    let fallback = false;
    const failed = async () => {
      if (!asset || e !== epoch) return;
      if (fallback) {
        loading = false;
        sync();
        notify("The browser could not play the prepared source.");
        return;
      }
      fallback = true;
      loading = true;
      sync();
      $("[data-ed-status]").textContent =
        "Preparing browser-compatible source…";
      try {
        const result = await serial("source");
        if (!asset || e !== epoch) return;
        if (isVideo()) {
          video.src = result.url;
          video.load();
        } else image.src = result.url;
      } catch (error) {
        if (asset && e === epoch) {
          loading = false;
          sync();
          notify(error.message);
        }
      }
    };
    image.onload = ready;
    image.onerror = failed;
    video.onloadeddata = ready;
    video.onerror = failed;
    if (isVideo()) {
      video.src = current.source_url || current.content_url;
      video.load();
      video.onloadedmetadata = () => {
        if (asset && e === epoch) video.currentTime = edit.start;
      };
    } else image.src = current.source_url || current.content_url;
    for (const selector of [
      "[data-theme-toggle]",
      "[data-interface-size-picker]",
      "[data-fullscreen-toggle]",
    ]) {
      const control = root.querySelector(selector);
      if (!control) continue;
      const home = document.createComment("Media editor control position");
      control.before(home);
      homes.push({ control, home });
      $("[data-ed-shell]").insertBefore(
        control,
        $("[data-ed-shell] [data-ed-close]"),
      );
    }
    el.classList.add("is-open");
    el.setAttribute("aria-hidden", "false");
    $(".h3ps-ed-dialog").setAttribute("aria-modal", "true");
    onOpenChange(true);
    appliedView();
    timelineView();
    sync();
    requestAnimationFrame(() => {
      if (asset && e === epoch) $(".h3ps-ed-dialog").focus();
    });
  }
  function close(force = false) {
    if (!asset) return true;
    if (busy && !force) return false;
    if (!force && confirming) {
      confirming = false;
      sync();
      return false;
    }
    if (!force && dirty()) {
      confirming = true;
      sync();
      $("[data-ed-keep]").focus();
      return false;
    }
    stop();
    epoch++;
    const returnTo = trigger?.isConnected
      ? trigger
      : root.querySelector(`[data-asset-id="${asset.id}"]`);
    asset = null;
    source = null;
    video.removeAttribute("src");
    video.load();
    image.removeAttribute("src");
    decoded.removeAttribute("src");
    for (const { home, control } of homes.splice(0)) home.replaceWith(control);
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
    $(".h3ps-ed-dialog").removeAttribute("aria-modal");
    onOpenChange(false);
    returnTo?.focus?.({ preventScroll: true });
    return true;
  }
  return {open,close,destroy(){close(true);observer.disconnect();document.removeEventListener('keydown',onKey);el.remove();}};
}
