import { mediaVisualDescriptor as defaultVisualDescriptor, referenceCaption } from "./media_visual.js";

const ASPECTS = [
  ["auto", "Auto"], ["1:1", "1:1 — Square"], ["2:3", "2:3 — Portrait Photo"],
  ["3:2", "3:2 — Photo"], ["3:4", "3:4 — Portrait Standard"], ["4:3", "4:3 — Standard"],
  ["9:16", "9:16 — Portrait Widescreen"], ["16:9", "16:9 — Widescreen"], ["21:9", "21:9 — Ultrawide"],
];

const BASE_W = 1600;
const BASE_H = 900;
const CANVAS_BG = "#0b0b0d";
const CAPTION_FONT_RATIO = .042;
const CAPTION_MEASURE_SCALE = 512;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const uid = () => `ci_${Math.random().toString(36).slice(2, 9)}`;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));

function markup(icon) {
  const i = (name, size) => icon?.(name, size) ?? "";
  return `
<section class="h3ps-composer" aria-hidden="true">
  <div class="h3ps-preview-backdrop" data-close></div>
  <div class="h3ps-cmp-dialog" role="dialog" aria-labelledby="h3ps-cmp-title" tabindex="-1">
    <header>
      <span><small>Media Composer</small><strong id="h3ps-cmp-title">Compose a new Picture</strong></span>
      <div class="h3ps-cmp-shell-controls" data-shell-controls><button class="h3ps-icon-button" type="button" data-close aria-label="Close composer" title="Close (Esc)">${i("close", 18)}</button></div>
    </header>
    <div class="h3ps-cmp-body">
      <aside class="h3ps-cmp-side">
        <section class="h3ps-cmp-block">
          <div class="h3ps-cmp-block-head"><small>Sources</small><em data-source-count></em></div>
          <p class="h3ps-cmp-hint">Click or drag onto canvas. Pictures keep their full frame; Videos use the prepared analysis sheet.</p>
          <div class="h3ps-cmp-sources" data-sources role="group" aria-label="Available media"></div>
        </section>
        <section class="h3ps-cmp-block">
          <div class="h3ps-cmp-block-head"><small>On canvas</small><button class="h3ps-cmp-text-action" type="button" data-clear>Clear</button></div>
          <div class="h3ps-cmp-strip" data-strip></div>
        </section>
        <section class="h3ps-cmp-block">
          <div class="h3ps-cmp-block-head"><small>Arrange &amp; Canvas</small><button class="h3ps-cmp-text-action" type="button" data-reset title="Restore arrangement and media sizes; keep sources and captions">Reset layout</button></div>
          <div class="h3ps-cmp-control"><span>Arrange</span><div class="h3ps-cmp-segment" data-layout role="group" aria-label="Auto arrange"><button type="button" data-value="auto">Auto</button><button type="button" data-value="2">2 cols</button><button type="button" data-value="3">3 cols</button><button type="button" data-value="grid">Grid</button></div></div>
          <div class="h3ps-cmp-control h3ps-cmp-aspect-control"><label for="h3ps-cmp-aspect">Canvas</label><select class="h3ps-cmp-select" id="h3ps-cmp-aspect" data-aspect>${ASPECTS.map(([v,l]) => `<option value="${v}">${v === "auto" ? l : v}</option>`).join("")}</select></div>
          <div class="h3ps-cmp-control h3ps-cmp-output-control"><span>Output</span><div class="h3ps-cmp-output">
            <div class="h3ps-cmp-segment" data-output-mode><button type="button" data-value="auto">Auto</button><button type="button" data-value="custom">Custom</button></div>
            <span class="h3ps-cmp-output-readout" data-output-readout></span>
            <div class="h3ps-cmp-output-custom" data-output-custom hidden>
              <div class="h3ps-cmp-segment" data-output-input><button type="button" data-value="mp">MP</button><button type="button" data-value="dimensions">Dimensions</button></div>
              <div class="h3ps-cmp-output-editor" data-mp-editor><input class="h3ps-cmp-number h3ps-cmp-mp" type="number" min="0.01" step="0.01" inputmode="decimal" data-mp aria-label="Output megapixels"><span>MP</span><small data-mp-calc></small></div>
              <div class="h3ps-cmp-output-editor" data-dims-editor hidden><div class="h3ps-cmp-dimensions"><input class="h3ps-cmp-number" type="number" min="1" step="1" inputmode="numeric" data-width aria-label="Output width"><i>×</i><input class="h3ps-cmp-number" type="number" min="1" step="1" inputmode="numeric" data-height aria-label="Output height"></div><small data-dims-calc></small></div>
            </div>
          </div></div>
          <div class="h3ps-cmp-control"><label for="h3ps-cmp-gap">Gap</label><div class="h3ps-cmp-range"><input id="h3ps-cmp-gap" type="range" min="0" max="64" step="2" data-gap><output data-gap-out></output></div></div>
          <div class="h3ps-cmp-control"><span>Placement</span><label class="h3ps-cmp-check"><input type="checkbox" data-snap checked>Snap to edges &amp; center</label></div>
        </section>
      </aside>
      <div class="h3ps-cmp-stage">
        <div class="h3ps-cmp-stage-canvas" data-stage>
          <canvas data-canvas width="1600" height="900" aria-label="Collage preview" hidden></canvas>
          <div class="h3ps-cmp-empty" data-empty><span>${i("grid", 18)}</span><strong>Canvas is empty</strong>Click or drag Pictures or Video sheets from the left.</div>
          <button class="h3ps-cmp-caption-add" type="button" data-caption-add hidden>${i("plus", 11)}Add caption</button>
          <div class="h3ps-cmp-caption-inline" data-caption-inline hidden>
            <textarea data-caption-input rows="1" placeholder="Add a caption…" aria-label="Caption" spellcheck="true"></textarea>
            <i class="h3ps-cmp-caption-handle" data-caption-handle="left"></i><i class="h3ps-cmp-caption-handle" data-caption-handle="right"></i><i class="h3ps-cmp-caption-handle" data-caption-handle="scale"></i>
            <button class="h3ps-cmp-caption-remove" type="button" data-caption-remove title="Remove caption" aria-label="Remove caption">${i("close", 11)}</button>
          </div>
        </div>
        <div class="h3ps-cmp-meta"><span data-meta-left></span><button class="h3ps-cmp-text-action" type="button" data-view-fit title="Reset zoom to fit; wheel to zoom, middle-drag to pan">Fit</button><span data-meta-right></span></div>
      </div>
    </div>
    <footer>
      <span data-footer-note></span>
      <button class="h3ps-icon-button h3ps-cmp-copy-button" type="button" data-copy title="Copy PNG" aria-label="Copy PNG">${i("copy", 14)}</button>
      <button class="h3ps-secondary-button" type="button" data-download>${i("download", 13)}Download</button>
      <button class="h3ps-primary-button" type="button" data-add>${i("plus", 13)}Add as Picture</button>
    </footer>
  </div>
</section>`;
}

function imageFrom(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load media visual: ${src}`));
    img.src = src;
  });
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode composed Picture.")), "image/png"));
}

/**
 * Creates an isolated Media Composer UI. Integration supplies current assets and
 * persists the returned PNG through onAddPicture().
 */
export function createMediaComposer({
  root,
  icon,
  onAddPicture,
  notify = () => {},
  getAddState = () => ({ allowed:true }),
  describeVisual = defaultVisualDescriptor,
  autoLongEdge = 1536,
  onOpenChange = () => {},
} = {}) {
  if (!(root instanceof Element)) throw new TypeError("Media Composer requires a root Element.");
  if (typeof onAddPicture !== "function") throw new TypeError("Media Composer requires onAddPicture(payload).");

  const wrapper = document.createElement("div");
  wrapper.innerHTML = markup(icon);
  const el = wrapper.firstElementChild;
  root.append(el);

  const $ = (s, r = el) => r.querySelector(s);
  const $$ = (s, r = el) => [...r.querySelectorAll(s)];
  const dom = {
    gap: $("[data-gap]"), gapOut: $("[data-gap-out]"), snap: $("[data-snap]"), stage: $("[data-stage]"), canvas: $("[data-canvas]"), empty: $("[data-empty]"),
    dialog: $(".h3ps-cmp-dialog"), side: $(".h3ps-cmp-side"), sources: $("[data-sources]"), sourceCount: $("[data-source-count]"),
    strip: $("[data-strip]"), clear: $("[data-clear]"), reset: $("[data-reset]"), layout: $("[data-layout]"), aspect: $("[data-aspect]"),
    outputMode: $("[data-output-mode]"), outputInput: $("[data-output-input]"), outputReadout: $("[data-output-readout]"), outputCustom: $("[data-output-custom]"),
    mpEditor: $("[data-mp-editor]"), dimsEditor: $("[data-dims-editor]"), mp: $("[data-mp]"), mpCalc: $("[data-mp-calc]"), width: $("[data-width]"), height: $("[data-height]"), dimsCalc: $("[data-dims-calc]"),
    captionAdd: $("[data-caption-add]"), captionBox: $("[data-caption-inline]"), captionInput: $("[data-caption-input]"), captionRemove: $("[data-caption-remove]"),
    metaLeft: $("[data-meta-left]"), metaRight: $("[data-meta-right]"), footer: $("[data-footer-note]"), copy: $("[data-copy]"), download: $("[data-download]"), add: $("[data-add]"),
  };

  const state = {
    openGeneration: 0,
    assets: [], assetMap:new Map(), visuals:new Map(), visualPromises:new Map(), items:[], selectedUid:null,
    captionEdit:null, captionEditOrig:"", canvasW:BASE_W, canvasH:BASE_H, drag:null, open:false, returnFocus:null,
    zoom:1, panX:0, panY:0, visualRevision:0,
    layout:"auto", aspect:"auto", gap:16, snap:true, outputMode:"auto", outputInput:"mp", customPixels:1.33e6,
  };
  const shellHomes=[];
  const captionMeasure = document.createElement("canvas").getContext("2d");

  const selected = () => state.items.find((it) => it.uid === state.selectedUid) || null;
  const editing = () => state.items.find((it) => it.uid === state.captionEdit) || null;
  const itemAsset = (it) => state.assetMap.get(String(it.assetId));
  const itemWeight = (it) => clamp(Number(it.weight) || 1, .2, 5);
  const captionText = (it) => String(it?.caption || "").trim();
  const captionCustom = (it) => Number.isFinite(it?.captionWidthRatio);
  const captionWidthRatio = (it) => captionCustom(it) ? clamp(Number(it.captionWidthRatio), .35, 3) : 1;
  const captionXRatio = (it) => captionCustom(it) ? clamp(Number(it.captionXRatio) || 0, -2, 2) : 0;
  const captionFontRatio = (it) => clamp(Number(it?.captionFontRatio) || CAPTION_FONT_RATIO, .018, .12);
  const resetCaption = (it) => { delete it.captionWidthRatio; delete it.captionXRatio; it.captionFontRatio = CAPTION_FONT_RATIO; };
  const canvasSize = () => ({ W:Math.max(1, Math.round(state.canvasW || BASE_W)), H:Math.max(1, Math.round(state.canvasH || BASE_H)) });
  const canvasRatio = () => {
    if (state.aspect === "auto") return null;
    const [w, h] = state.aspect.split(":").map(Number);
    return w / h;
  };

  function descriptor(asset) {
    const d = describeVisual(asset);
    if (!d) return null;
    const w = Math.max(1, Number(d.w) || 1), h = Math.max(1, Number(d.h) || 1);
    return { ...d, w, h, ar:Number(d.ar) || w / h };
  }

  async function loadVisual(asset) {
    const d = descriptor(asset);
    if (!d) throw new Error("Unsupported media source.");
    const key=String(asset.id),revision=state.visualRevision;
    if (d.bitmap) { state.visuals.set(key, d.bitmap); return d.bitmap; }
    if (state.visuals.has(key)) return state.visuals.get(key);
    if (state.visualPromises.has(key)) return state.visualPromises.get(key);
    if (!d.src) throw new Error(`No visual source for ${asset.reference || asset.filename || asset.id}.`);
    const promise = imageFrom(d.src).then((img) => {
      if(revision!==state.visualRevision)return null;
      const ar=(img.naturalWidth||img.width)/(img.naturalHeight||img.height);
      let changed=false;
      for(const it of state.items.filter((it)=>it.assetId===key))changed=updateItemAspect(it,ar)||changed;
      if(changed)normalizeCanvas();
      state.visuals.set(key,img);state.visualPromises.delete(key);return img;
    }, (error) => { if(revision===state.visualRevision)state.visualPromises.delete(key);throw error; });
    state.visualPromises.set(key, promise);
    return promise;
  }

  function wrapLines(ctx, text, maxWidth) {
    if (!text) return [];
    const lines = [];
    for (const paragraph of String(text).split(/\n/)) {
      if (!paragraph.trim()) { lines.push(""); continue; }
      const words = paragraph.trim().split(/\s+/); let line = "";
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width <= maxWidth) { line = test; continue; }
        if (line) lines.push(line);
        if (ctx.measureText(word).width <= maxWidth) { line = word; continue; }
        let part = "";
        for (const ch of word) {
          const next = part + ch;
          if (ctx.measureText(next).width > maxWidth && part) { lines.push(part); part = ch; } else part = next;
        }
        line = part;
      }
      if (line) lines.push(line);
    }
    return lines.length ? lines : [""];
  }

  function captionLayout(it, x = it.x, y = it.y, w = it.w, h = it.h, ctx = captionMeasure) {
    const text = captionText(it);
    if (!text && state.captionEdit !== it.uid) return null;
    const width = Math.max(70, w * captionWidthRatio(it));
    const fontSize = Math.max(10, w * captionFontRatio(it));
    const lineHeight = fontSize * 1.34, padY = fontSize * .18;
    ctx.font = `500 ${fontSize}px Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif`;
    const lines = wrapLines(ctx, text || " ", Math.max(20, width));
    const gap = Math.max(7, w * .014);
    return { x:x + w/2 + w*captionXRatio(it) - width/2, y:y+h+gap, w:width, h:lines.length*lineHeight + padY*2, fontSize, lineHeight, padY, lines, text };
  }

  function itemBounds(it, x=it.x, y=it.y, w=it.w, h=it.h) {
    let minX=x, minY=y, maxX=x+w, maxY=y+h;
    const c = captionLayout(it, x, y, w, h);
    if (c) { minX=Math.min(minX,c.x); minY=Math.min(minY,c.y); maxX=Math.max(maxX,c.x+c.w); maxY=Math.max(maxY,c.y+c.h); }
    return { minX, minY, maxX, maxY, w:maxX-minX, h:maxY-minY };
  }

  function contentBounds(items=state.items) {
    if (!items.length) return {minX:0,minY:0,maxX:0,maxY:0,w:0,h:0};
    const boxes=items.map((it)=>itemBounds(it));
    const minX=Math.min(...boxes.map((b)=>b.minX)), minY=Math.min(...boxes.map((b)=>b.minY));
    const maxX=Math.max(...boxes.map((b)=>b.maxX)), maxY=Math.max(...boxes.map((b)=>b.maxY));
    return {minX,minY,maxX,maxY,w:maxX-minX,h:maxY-minY};
  }

  function normalizeCanvas() {
    if (!state.items.length) {
      const r=canvasRatio(); state.canvasW=BASE_W; state.canvasH=r ? Math.round(BASE_W/r) : BASE_H; return;
    }
    const b=contentBounds(), g=state.gap, reqW=Math.max(1,b.w+2*g), reqH=Math.max(1,b.h+2*g), r=canvasRatio();
    let W=reqW, H=reqH;
    if (r) { W=Math.max(reqW, reqH*r); H=W/r; if (H<reqH) { H=reqH; W=H*r; } }
    W=Math.max(64,Math.ceil(W)); H=Math.max(64,Math.ceil(H));
    const dx=(W-b.w)/2-b.minX, dy=(H-b.h)/2-b.minY;
    state.items.forEach((it)=>{it.x+=dx;it.y+=dy});
    state.canvasW=W; state.canvasH=H;
  }

  function resolutionFromPixels(pixels) {
    const {W,H}=canvasSize(), ar=Math.max(.05,W/H), px=Math.max(1,pixels);
    const w=Math.sqrt(px*ar), h=w/ar;
    return {W:Math.max(1,Math.round(w)),H:Math.max(1,Math.round(h))};
  }

  function autoResolution() {
    const {W,H}=canvasSize(), ar=Math.max(.05,W/H), edge=Math.max(64,Number(autoLongEdge)||1536);
    return ar>=1 ? {W:Math.round(edge),H:Math.max(1,Math.round(edge/ar))} : {W:Math.max(1,Math.round(edge*ar)),H:Math.round(edge)};
  }

  const outputResolution = () => state.outputMode === "custom" ? resolutionFromPixels(state.customPixels) : autoResolution();
  const setPixelsFromWidth = (w) => { const ar=canvasSize().W/canvasSize().H; state.customPixels=Math.max(1,w)*Math.max(1,w)/Math.max(.05,ar); };
  const setPixelsFromHeight = (h) => { const ar=canvasSize().W/canvasSize().H; state.customPixels=Math.max(1,h)*Math.max(1,h)*Math.max(.05,ar); };

  function outputTransform(pixelW,pixelH) {
    const {W,H}=canvasSize(), scale=Math.min(pixelW/W,pixelH/H);
    return {scale,ox:(pixelW-W*scale)/2,oy:(pixelH-H*scale)/2,logicalW:W,logicalH:H};
  }

  function updateItemAspect(it,ar) {
    if(!Number.isFinite(ar)||ar<=0||Math.abs(it.ar-ar)<.0001)return false;
    const area=it.w*it.h,cx=it.x+it.w/2,cy=it.y+it.h/2;
    it.ar=ar;it.w=Math.sqrt(area*ar);it.h=it.w/ar;it.x=cx-it.w/2;it.y=cy-it.h/2;
    return true;
  }

  function zoomAt(zoom,nextZoom,point,rect,stage,offsetY=0) {
    const ratio=nextZoom/zoom,w=rect.width*ratio,h=rect.height*ratio;
    return {
      panX:point.x-stage.left-(point.x-rect.left)*ratio-(stage.width-w)/2,
      panY:point.y-stage.top-(point.y-rect.top)*ratio-(stage.height-h)/2-offsetY,
    };
  }

  function sourceWeight(it) {
    const asset=itemAsset(it);
    const frames=asset?.type==="video" ? Number(asset.frames?.length || asset.frame_count || 1) : 1;
    return Math.min(2,Math.sqrt(Math.max(1,frames)));
  }

  function resizedWidth(orig,handle,dx,dy,ar) {
    const horizontal=handle.includes("w")?-dx:dx,vertical=handle.includes("n")?-dy:dy;
    const delta=(horizontal+vertical/ar)/(1+1/(ar*ar));
    return Math.max(90,40*ar,orig.w+delta);
  }

  function preferredRect(it) {
    const area=Math.max(.05,itemWeight(it)*sourceWeight(it)), pw=Math.sqrt(area*it.ar), ph=Math.sqrt(area/it.ar);
    const oy=0;
    if (!captionText(it)) return {pw,ph,gw:pw,gh:ph+oy,ox:0,oy};
    const s=CAPTION_MEASURE_SCALE, c=captionLayout(it,0,0,pw*s,ph*s);
    const minX=Math.min(0,c.x), maxX=Math.max(pw*s,c.x+c.w);
    return {pw,ph,gw:(maxX-minX)/s,gh:(c.y+c.h)/s+oy,ox:-minX/s,oy};
  }

  function candidateBounds(c) {
    const boxes=c.placed.map((p)=>itemBounds(p.it,p.x,p.y,p.w,p.h));
    const {minX,minY,maxX,maxY}=contentBounds(c.placed.map(p=>({...p.it,x:p.x,y:p.y,w:p.w,h:p.h})));
    return {bw:Math.max(1,maxX-minX),bh:Math.max(1,maxY-minY),area:boxes.reduce((sum,b)=>sum+b.w*b.h,0)};
  }

  function rowCandidate(groups) {
    groups=groups.filter((g)=>g.length); if(!groups.length)return null;
    const gap=state.gap, inner=BASE_W-2*gap, pref=new Map(state.items.map((it)=>[it,preferredRect(it)])); let scale=Infinity;
    for(const row of groups){const sum=row.reduce((n,it)=>n+pref.get(it).gw,0), avail=inner-gap*(row.length-1);if(sum<=0||avail<=0)return null;scale=Math.min(scale,avail/sum)}
    if(!isFinite(scale)||scale<=0)return null;
    const placed=[];let y=gap;
    for(const row of groups){const dims=row.map((it)=>{const p=pref.get(it);return{it,w:p.pw*scale,h:p.ph*scale,gw:p.gw*scale,gh:p.gh*scale,ox:p.ox*scale,oy:p.oy*scale}}), rowH=Math.max(...dims.map((d)=>d.gh)), rowW=dims.reduce((n,d)=>n+d.gw,0)+gap*(dims.length-1);let x=gap+(inner-rowW)/2;for(const d of dims){const gy=y+(rowH-d.gh)/2;placed.push({it:d.it,x:x+d.ox,y:gy+d.oy,w:d.w,h:d.h});x+=d.gw+gap}y+=rowH+gap}
    return {W:BASE_W,H:Math.max(240,y),placed};
  }

  function columnCandidate(groups) {
    groups=groups.filter((g)=>g.length); if(!groups.length)return null;
    const gap=state.gap, inner=BASE_W-2*gap, pref=new Map(state.items.map((it)=>[it,preferredRect(it)]));
    const widths=groups.map((col)=>Math.max(...col.map((it)=>pref.get(it).gw))), total=widths.reduce((a,b)=>a+b,0), avail=inner-gap*(groups.length-1);
    if(total<=0||avail<=0)return null;const scale=avail/total;if(!isFinite(scale)||scale<=0)return null;
    const placed=[];let x=gap,maxBottom=0;
    groups.forEach((col,ci)=>{const colW=widths[ci]*scale;let y=gap;for(const it of col){const p=pref.get(it),w=p.pw*scale,h=p.ph*scale,gw=p.gw*scale,gh=p.gh*scale,ox=p.ox*scale;placed.push({it,x:x+(colW-gw)/2+ox,y:y+p.oy*scale,w,h});y+=gh+gap}maxBottom=Math.max(maxBottom,y);x+=colW+gap});
    return {W:BASE_W,H:Math.max(240,maxBottom),placed};
  }

  function partitions(order) {
    if(!order.length)return[];const out=[], count=1<<(order.length-1);
    for(let mask=0;mask<count;mask++){const groups=[],cur=[order[0]];for(let i=0;i<order.length-1;i++){if((mask>>i)&1)groups.push(cur.splice(0));cur.push(order[i+1])}groups.push(cur);out.push(groups)}
    return out;
  }

  function candidateScore(c) {
    if(!c?.placed?.length)return -Infinity;
    const b=candidateBounds(c),r=canvasRatio(),reqW=b.bw+2*state.gap,reqH=b.bh+2*state.gap;
    const W=r?Math.max(reqW,reqH*r):reqW,H=r?W/r:reqH;
    const exportScale=autoLongEdge/Math.max(W,H);
    const minSide=Math.min(...c.placed.map((p)=>Math.min(p.w,p.h)*exportScale/Math.sqrt(sourceWeight(p.it))));
    const legibility=Math.min(1,minSide/190),util=Math.min(1,b.area/(W*H));
    if(r)return util*.92+legibility*.08;
    const ar=W/H,target=BASE_W/BASE_H,viewFit=Math.min(ar/target,target/ar);
    return util*.58+viewFit*.34+legibility*.08;
  }

  function applyCandidate(c) {
    const scale=Math.max(1,...c.placed.map((p)=>40/Math.min(p.w,p.h)));
    for(const p of c.placed){p.it.x=p.x*scale;p.it.y=p.y*scale;p.it.w=p.w*scale;p.it.h=p.it.w/p.it.ar}
    normalizeCanvas();
  }

  function smartArrange() {
    if(!state.items.length)return;
    if(state.items.length===1){const it=state.items[0],g=state.gap,area=(BASE_W-2*g)*Math.max(360,(BASE_W-2*g)/Math.max(.35,it.ar)),w=Math.sqrt(area*itemWeight(it)*it.ar);it.w=Math.round(w);it.h=Math.round(w/it.ar);it.x=g;it.y=g;normalizeCanvas();return}
    const orders=[],seen=new Set(),add=(o)=>{const k=o.map((x)=>x.uid).join("|");if(!seen.has(k)){seen.add(k);orders.push(o)}};
    add([...state.items]);add([...state.items].sort((a,b)=>itemWeight(b)-itemWeight(a)));add([...state.items].sort((a,b)=>b.ar-a.ar));add([...state.items].sort((a,b)=>a.ar-b.ar));add([...state.items].sort((a,b)=>Math.abs(Math.log(b.ar))-Math.abs(Math.log(a.ar))));
    if(state.items.length<=4){
      const permute=(prefix,rest)=>{if(!rest.length){add(prefix);return}rest.forEach((it,i)=>permute([...prefix,it],rest.filter((_,j)=>i!==j)))};
      permute([],state.items);
    }
    const candidates=[];for(const order of orders)for(const groups of partitions(order)){const r=rowCandidate(groups),c=columnCandidate(groups);if(r?.placed.length===state.items.length)candidates.push(r);if(c?.placed.length===state.items.length)candidates.push(c)}
    let best=null,score=-Infinity;for(const c of candidates){const s=candidateScore(c);if(s>score){score=s;best=c}}if(best)applyCandidate(best);
  }

  function layoutAvailable(mode, count = state.items.length) {
    return count >= ({auto:1, "2":2, "3":3, grid:2}[mode] ?? Infinity);
  }

  function normalizeLayoutMode() {
    if (!layoutAvailable(state.layout)) state.layout = "auto";
  }

  function arrange() {
    normalizeLayoutMode();
    if(!state.items.length)return;if(state.layout==="auto"){smartArrange();return}
    const n=state.items.length;let c=null;
    if(state.layout==="2"||state.layout==="3"){const k=Math.min(n,Number(state.layout)),groups=Array.from({length:k},()=>[]);state.items.forEach((it,i)=>groups[i%k].push(it));c=columnCandidate(groups);
      if(n<=4){
        const visit=(prefix,rest)=>{
          if(rest.length){rest.forEach((it,i)=>visit([...prefix,it],rest.filter((_,j)=>i!==j)));return}
          for(const grouped of partitions(prefix)){
            if(grouped.length!==k)continue;
            const candidate=columnCandidate(grouped);
            if(candidateScore(candidate)>candidateScore(c))c=candidate;
          }
        };
        visit([],state.items);
      }
    }
    else if(state.layout==="grid"){const cols=Math.max(1,Math.ceil(Math.sqrt(n))),groups=[];for(let i=0;i<n;i+=cols)groups.push(state.items.slice(i,i+cols));c=rowCandidate(groups)}
    if(c)applyCandidate(c);
  }

  function createItem(asset,x=null,y=null) {
    const d=descriptor(asset);if(!d)return null;
    const bitmap=state.visuals.get(String(asset.id));
    if(bitmap)d.ar=(bitmap.naturalWidth||bitmap.width)/(bitmap.naturalHeight||bitmap.height);
    const baseW=Math.min(620,Math.max(260,Math.round(BASE_W/2.5))),baseH=baseW/d.ar,size=canvasSize();
    return {uid:uid(),assetId:String(asset.id),x:Math.round(x==null?(size.W-baseW)/2:x-baseW/2),y:Math.round(y==null?(size.H-baseH)/2:y-baseH/2),w:baseW,h:baseH,ar:d.ar,weight:1,caption:"",captionFontRatio:CAPTION_FONT_RATIO};
  }

  function sourceThumb(asset) { return asset.type==="video" ? asset.contact_sheet_url : asset.preview_url || asset.content_url; }
  function sourceMeta(asset) {
    if(asset.type==="video") { const n=asset.frames?.length || asset.frame_count || ""; return {kind:n?`Sheet · ${n}`:"Sheet", detail:"analysis sheet"}; }
    return {kind:"Picture",detail:`${asset.width||"?"}×${asset.height||"?"}`};
  }

  function renderSources() {
    const list=state.assets.filter((a)=>a.type==="image"||a.type==="video"), audio=state.assets.filter((a)=>a.type==="audio").length;
    dom.sourceCount.textContent=`${state.items.length} on canvas${audio?` · ${audio} audio skipped`:""}`;
    dom.sources.innerHTML=list.map((a)=>{const selected=state.items.some((it)=>it.assetId===a.id),m=sourceMeta(a);return `<button class="h3ps-asset h3ps-cmp-source ${selected?"is-selected":""}" type="button" draggable="true" data-source-id="${esc(a.id)}" aria-pressed="${selected}"><span class="h3ps-asset-preview"><span class="h3ps-thumb-backdrop" style="background-image:url(&quot;${esc(sourceThumb(a)||"")}&quot;)"></span><img class="h3ps-real-thumb" draggable="false" src="${esc(sourceThumb(a)||"")}" alt=""></span><span class="h3ps-cmp-source-kind ${a.type==="video"?"is-sheet":""}">${esc(m.kind)}</span><span class="h3ps-asset-copy"><strong>${esc(a.reference||a.filename||"Media")}</strong><small>${esc(m.detail)}</small></span></button>`}).join("");
  }

  function renderStrip() {
    dom.clear.disabled=!state.items.length;
    if(!state.items.length){dom.strip.innerHTML=`<span class="h3ps-cmp-strip-empty">No items on canvas.</span>`;return}
    dom.strip.innerHTML=state.items.map((it)=>{const a=itemAsset(it),custom=Math.abs(itemWeight(it)-1)>.03;return `<div class="h3ps-cmp-pill ${it.uid===state.selectedUid?"is-active":""}" data-item-id="${it.uid}"><span>${esc(a?.reference||"Missing")}</span>${custom?`<button type="button" data-action="reset-size" title="Reset media size preference" aria-label="Reset media size preference">↺</button>`:""}<button type="button" data-action="remove" title="Remove" aria-label="Remove">×</button></div>`}).join("");
  }

  function setActive(host,value) { $$(`button[data-value]`,host).forEach((b)=>{const on=b.dataset.value===value;b.classList.toggle("is-active",on);b.setAttribute("aria-pressed",String(on))}); }
  function renderControls() {
    normalizeLayoutMode();const n=state.items.length;setActive(dom.layout,n?state.layout:null);$$(`button`,dom.layout).forEach((b)=>b.disabled=!layoutAvailable(b.dataset.value));dom.reset.disabled=!n;
    dom.aspect.value=state.aspect;dom.gap.value=state.gap;dom.gap.style.setProperty("--h3ps-range",`${state.gap/64*100}%`);dom.gapOut.textContent=`${state.gap} px`;dom.snap.checked=state.snap;
    const r=outputResolution(),mp=r.W*r.H/1e6;setActive(dom.outputMode,state.outputMode);dom.outputReadout.innerHTML=n?`<b>${r.W} × ${r.H}</b> · ${mp.toFixed(2)} MP`:"Add media to set output";dom.outputCustom.hidden=state.outputMode!=="custom";
    setActive(dom.outputInput,state.outputInput);dom.mpEditor.hidden=state.outputInput!=="mp";dom.dimsEditor.hidden=state.outputInput!=="dimensions";dom.mp.value=(state.customPixels/1e6).toFixed(2);dom.width.value=r.W;dom.height.value=r.H;dom.mpCalc.textContent=`${r.W} × ${r.H}`;dom.dimsCalc.textContent=n?`${mp.toFixed(2)} MP`:"";dom.mpCalc.textContent=n?`${r.W} × ${r.H}`:"";dom.width.disabled=dom.height.disabled=!n;if(!n){dom.width.value="";dom.height.value=""}
  }

  function drawCaption(ctx,c) {
    if(!c?.text)return;ctx.save();ctx.font=`500 ${c.fontSize}px Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif`;ctx.textAlign="center";ctx.textBaseline="top";ctx.fillStyle="#e8e8ec";const cx=c.x+c.w/2;c.lines.forEach((line,i)=>ctx.fillText(line,cx,c.y+c.padY+i*c.lineHeight));ctx.restore();
  }

  function drawOutput(ctx,W,H,interactive) {
    ctx.clearRect(0,0,W,H);ctx.fillStyle=CANVAS_BG;ctx.fillRect(0,0,W,H);const T=outputTransform(W,H);ctx.save();ctx.translate(T.ox,T.oy);ctx.scale(T.scale,T.scale);const line=Math.max(.7,1/T.scale);
    for(const it of state.items){const a=itemAsset(it),bitmap=state.visuals.get(it.assetId);if(!a||!bitmap)continue;ctx.drawImage(bitmap,it.x,it.y,it.w,it.h);ctx.strokeStyle="rgba(255,255,255,.08)";ctx.lineWidth=line;ctx.strokeRect(it.x+.5*line,it.y+.5*line,it.w-line,it.h-line);if(!(interactive&&state.captionEdit===it.uid))drawCaption(ctx,captionLayout(it,it.x,it.y,it.w,it.h,ctx));if(interactive&&state.selectedUid===it.uid&&!state.captionEdit){const ref=a.reference||"Reference",fs=Math.max(11,Math.min(16,T.logicalW/95));ctx.font=`600 ${fs}px Inter,system-ui`;ctx.textAlign="left";ctx.textBaseline="middle";const tw=ctx.measureText(ref).width,ph=fs*1.65,pw=tw+fs*.95,px=it.x+fs*.45,py=it.y+it.h-ph-fs*.45;ctx.fillStyle="rgba(8,9,11,.84)";ctx.beginPath();ctx.roundRect(px,py,pw,ph,Math.max(4,fs*.3));ctx.fill();ctx.strokeStyle="rgba(232,97,60,.55)";ctx.lineWidth=Math.max(.8,1/T.scale);ctx.stroke();ctx.fillStyle="#f2b09d";ctx.fillText(ref,px+fs*.45,py+ph/2)}}
    const it=selected();if(interactive&&it&&!state.captionEdit){ctx.strokeStyle="#f0734d";ctx.lineWidth=Math.max(2/T.scale,T.logicalW/600);ctx.setLineDash([8/T.scale,5/T.scale]);ctx.strokeRect(it.x-2/T.scale,it.y-2/T.scale,it.w+4/T.scale,it.h+4/T.scale);ctx.setLineDash([]);const hs=Math.max(12/T.scale,T.logicalW/110);ctx.fillStyle="#fff";ctx.strokeStyle="#e8613c";ctx.lineWidth=2/T.scale;for(const [x,y] of [[it.x,it.y],[it.x+it.w,it.y],[it.x,it.y+it.h],[it.x+it.w,it.y+it.h]]){ctx.beginPath();ctx.rect(x-hs/2,y-hs/2,hs,hs);ctx.fill();ctx.stroke()}}
    ctx.restore();
  }

  function previewResolution(r) { const edge=Math.max(r.W,r.H),max=1600;if(edge<=max)return r;const k=max/edge;return{W:Math.max(1,Math.round(r.W*k)),H:Math.max(1,Math.round(r.H*k))}; }
  function fitPreview() {
    if(dom.canvas.hidden)return;
    const aw=Math.max(1,dom.stage.clientWidth-32),ah=Math.max(1,dom.stage.clientHeight-32);
    const k=Math.min(aw/dom.canvas.width,ah/dom.canvas.height)*state.zoom,w=dom.canvas.width*k,h=dom.canvas.height*k;
    if(state.zoom===1)state.panX=state.panY=0;
    state.panX=clamp(state.panX,-Math.max(0,(w-aw)/2),Math.max(0,(w-aw)/2));
    state.panY=clamp(state.panY,-Math.max(0,(h-ah)/2),Math.max(0,(h-ah)/2));
    Object.assign(dom.canvas.style,{width:w+"px",height:h+"px",left:((dom.stage.clientWidth-w)/2+state.panX)+"px",top:((dom.stage.clientHeight-h)/2+state.panY)+"px"});

    $("[data-view-fit]").textContent=state.zoom===1?"Fit":Math.round(state.zoom*100)+"% · Fit";
  }

  function resetView(){state.zoom=1;state.panX=state.panY=0;fitPreview();positionCaptionUI();}


  function addState() {
    const current=getAddState({assets:state.assets,items:state.items.map((it)=>({item:it,asset:itemAsset(it)})),resolution:outputResolution()})||{};
    return {allowed:current.allowed!==false,reference:current.reference||null,message:current.message||null};
  }

  function renderPreview() {
    renderControls();
    dom.canvas.hidden=!state.items.length;dom.empty.hidden=!!state.items.length;
    if(!state.items.length){dom.metaLeft.textContent="—";dom.metaRight.textContent="Zero crop · source aspect locked";dom.footer.textContent="Add Pictures or Video sheets to compose.";dom.footer.classList.remove("is-warning");dom.copy.disabled=true;dom.download.disabled=true;dom.add.disabled=true;positionCaptionUI();return}
    const r=outputResolution(),pr=previewResolution(r);dom.canvas.width=pr.W;dom.canvas.height=pr.H;drawOutput(dom.canvas.getContext("2d"),pr.W,pr.H,true);fitPreview();positionCaptionUI();requestAnimationFrame(positionCaptionUI);const mp=r.W*r.H/1e6;
    dom.metaLeft.innerHTML=`<b>${r.W} × ${r.H}</b> · ${mp.toFixed(2)} MP · ${state.items.length} item${state.items.length===1?"":"s"} · ${state.aspect==="auto"?"content-fit":state.aspect}`;dom.metaRight.textContent="Zero crop · source aspect locked";
    const availability=addState();dom.footer.classList.toggle("is-warning",!availability.allowed);dom.footer.textContent=availability.message||`${availability.reference?`Becomes ${availability.reference} · `:""}snapshot PNG ${r.W}×${r.H}`;dom.copy.disabled=false;dom.download.disabled=false;dom.add.disabled=!availability.allowed;
  }

  function renderAll() { renderSources();renderStrip();renderControls();renderPreview(); }
  function renderCanvasUI() { renderStrip();renderControls();renderPreview(); }

  function stageTransform() { if(dom.canvas.hidden)return null;const cr=dom.canvas.getBoundingClientRect(),sr=dom.stage.getBoundingClientRect(),T=outputTransform(dom.canvas.width,dom.canvas.height),k=cr.width/Math.max(1,dom.canvas.width);return{k:T.scale*k,ox:cr.left-sr.left+T.ox*k,oy:cr.top-sr.top+T.oy*k,stageH:dom.stage.clientHeight}; }
  function positionCaptionUI() {
    const it=selected(),S=it?stageTransform():null,active=!!S&&state.captionEdit===it.uid,dpr=Math.max(1,window.devicePixelRatio||1),snap=(v)=>Math.round(v*dpr)/dpr;
    dom.captionAdd.hidden=!S||active||!!state.drag||!!captionText(it);dom.captionBox.hidden=!active;
    if(!dom.captionAdd.hidden){const bottom=S.oy+(it.y+it.h)*S.k;dom.captionAdd.style.left=`${snap(S.ox+(it.x+it.w/2)*S.k)}px`;dom.captionAdd.style.top=`${snap(bottom+34>S.stageH?bottom-30:bottom+6)}px`}
    if(active){const c=captionLayout(it);dom.captionBox.style.left=`${snap(S.ox+c.x*S.k)}px`;dom.captionBox.style.top=`${snap(S.oy+c.y*S.k)}px`;dom.captionBox.style.width=`${snap(c.w*S.k)}px`;dom.captionBox.style.height=`${snap(c.h*S.k)}px`;dom.captionInput.style.fontSize=`${snap(c.fontSize*S.k)}px`;dom.captionInput.style.lineHeight=`${snap(c.lineHeight*S.k)}px`;dom.captionInput.style.padding=`${snap(c.padY*S.k)}px 0`}
  }

  function startCaption(it) { if(!it)return;if(state.captionEdit&&state.captionEdit!==it.uid)endCaption();state.selectedUid=it.uid;state.captionEdit=it.uid;state.captionEditOrig=it.caption||"";if(!it.caption)it.caption=referenceCaption(itemAsset(it));dom.captionInput.value=it.caption;normalizeCanvas();renderPreview();renderStrip();requestAnimationFrame(()=>{if(state.captionEdit!==it.uid)return;dom.captionInput.focus({preventScroll:true});dom.captionInput.setSelectionRange(dom.captionInput.value.length,dom.captionInput.value.length)}) }
  function endCaption(revert=false) { const it=editing(),was=!!state.captionEdit;state.captionEdit=null;if(!was)return;if(it){if(revert)it.caption=state.captionEditOrig;if(!captionText(it)){it.caption="";resetCaption(it)}}if(document.activeElement===dom.captionInput)dom.captionInput.blur();normalizeCanvas();renderPreview();renderStrip(); }

  function toggleSource(id) {
    const existing=state.items.find((it)=>it.assetId===id);if(existing){removeItem(existing.uid);return}
    const asset=state.assetMap.get(id),it=asset&&createItem(asset);if(!it)return;state.items.push(it);state.selectedUid=it.uid;loadVisual(asset).then(renderPreview).catch((e)=>notify("error",e.message));arrange();renderAll();
  }
  function removeItem(id) { if(state.captionEdit===id)endCaption();state.items=state.items.filter((it)=>it.uid!==id);if(state.selectedUid===id)state.selectedUid=null;if(state.items.length)arrange();else{state.canvasW=BASE_W;state.canvasH=BASE_H}renderAll(); }

  function pixelToLogical(px,py,pw,ph){const T=outputTransform(pw,ph);return{x:(px-T.ox)/T.scale,y:(py-T.oy)/T.scale}}
  function canvasPoint(e){const r=dom.canvas.getBoundingClientRect(),px=(e.clientX-r.left)*dom.canvas.width/Math.max(1,r.width),py=(e.clientY-r.top)*dom.canvas.height/Math.max(1,r.height);return pixelToLogical(px,py,dom.canvas.width,dom.canvas.height)}
  function dropPoint(e){if(!dom.canvas.hidden&&dom.canvas.getBoundingClientRect().width)return canvasPoint(e);const r=dom.stage.getBoundingClientRect(),s=canvasSize();return{x:(e.clientX-r.left)/Math.max(1,r.width)*s.W,y:(e.clientY-r.top)/Math.max(1,r.height)*s.H}}
  function hitTest(p){const sel=selected(),hr=Math.max(16,state.canvasW/90);if(sel){const corners={nw:[sel.x,sel.y],ne:[sel.x+sel.w,sel.y],sw:[sel.x,sel.y+sel.h],se:[sel.x+sel.w,sel.y+sel.h]};for(const[k,[x,y]]of Object.entries(corners))if(Math.hypot(p.x-x,p.y-y)<=hr)return{it:sel,handle:k}}for(let i=state.items.length-1;i>=0;i--){const it=state.items[i],c=captionLayout(it),pad=Math.max(10,c?.fontSize*.45||0);if(c&&p.x>=c.x-pad&&p.x<=c.x+c.w+pad&&p.y>=c.y-pad&&p.y<=c.y+c.h+pad)return{it,handle:"caption"}}for(let i=state.items.length-1;i>=0;i--){const it=state.items[i];if(p.x>=it.x&&p.x<=it.x+it.w&&p.y>=it.y&&p.y<=it.y+it.h)return{it,handle:"body"}}return{it:null,handle:null}}
  function snapMove(it,x,y){if(!state.snap)return{x,y};const s=canvasSize(),t=Math.max(10,state.canvasW*.008),g=state.gap;if(Math.abs(x-g)<t)x=g;if(Math.abs(y-g)<t)y=g;if(Math.abs(x+it.w-(s.W-g))<t)x=s.W-g-it.w;if(Math.abs(y+it.h-(s.H-g))<t)y=s.H-g-it.h;if(Math.abs(x+it.w/2-s.W/2)<t)x=s.W/2-it.w/2;if(Math.abs(y+it.h/2-s.H/2)<t)y=s.H/2-it.h/2;for(const o of state.items){if(o===it)continue;if(Math.abs(x-o.x)<t)x=o.x;if(Math.abs(y-o.y)<t)y=o.y;if(Math.abs(x-(o.x+o.w+g))<t)x=o.x+o.w+g;if(Math.abs(y-(o.y+o.h+g))<t)y=o.y+o.h+g}return{x:Math.round(x),y:Math.round(y)}}

  dom.sources.addEventListener("click",(e)=>{const source=e.target.closest("[data-source-id]");if(source)toggleSource(source.dataset.sourceId)});
  let dragGhost=null;
  const clearDragGhost=()=>{dragGhost?.remove();dragGhost=null};
  dom.sources.addEventListener("dragstart",(e)=>{
    const source=e.target.closest("[data-source-id]");if(!source)return;
    e.dataTransfer.setData("text/plain",source.dataset.sourceId);e.dataTransfer.effectAllowed="copy";
    const img=source.querySelector("img.h3ps-real-thumb");
    if(img?.complete&&img.naturalWidth){
      clearDragGhost();dragGhost=img.cloneNode();dragGhost.className="h3ps-cmp-drag-preview";
      const k=Math.min(140/img.naturalWidth,140/img.naturalHeight);
      dragGhost.style.width=img.naturalWidth*k+"px";dragGhost.style.height=img.naturalHeight*k+"px";
      el.append(dragGhost);e.dataTransfer.setDragImage(dragGhost,img.naturalWidth*k/2,img.naturalHeight*k/2);
    }
  });
  dom.sources.addEventListener("dragend",clearDragGhost);
  dom.strip.addEventListener("click",(e)=>{const pill=e.target.closest("[data-item-id]");if(!pill)return;const action=e.target.closest("button")?.dataset.action,id=pill.dataset.itemId;if(action==="remove"){removeItem(id);return}if(action==="reset-size"){const it=state.items.find((x)=>x.uid===id);if(it){it.weight=1;arrange();renderAll()}return}endCaption();state.selectedUid=id;renderStrip();renderPreview()});
  dom.layout.addEventListener("click",(e)=>{const b=e.target.closest("button[data-value]");if(!b||b.disabled)return;state.layout=b.dataset.value;if(state.items.length)arrange();renderCanvasUI()});
  dom.outputMode.addEventListener("click",(e)=>{const b=e.target.closest("button[data-value]");if(!b)return;state.outputMode=b.dataset.value;renderControls();renderPreview()});
  dom.outputInput.addEventListener("click",(e)=>{const b=e.target.closest("button[data-value]");if(!b)return;state.outputInput=b.dataset.value;renderControls()});
  dom.aspect.addEventListener("change",()=>{state.aspect=dom.aspect.value;if(state.items.length)normalizeCanvas();renderCanvasUI()});
  dom.gap.addEventListener("input",()=>{state.gap=Number(dom.gap.value);if(state.items.length)normalizeCanvas();renderControls();renderPreview()});
  dom.snap.addEventListener("change",()=>{state.snap=dom.snap.checked});
  dom.mp.addEventListener("change",()=>{const v=Number(dom.mp.value);if(v>0){state.outputMode="custom";state.outputInput="mp";state.customPixels=v*1e6;renderControls();renderPreview()}});
  dom.width.addEventListener("change",()=>{const v=Number(dom.width.value);if(v>0){state.outputMode="custom";state.outputInput="dimensions";setPixelsFromWidth(v);renderControls();renderPreview()}});
  dom.height.addEventListener("change",()=>{const v=Number(dom.height.value);if(v>0){state.outputMode="custom";state.outputInput="dimensions";setPixelsFromHeight(v);renderControls();renderPreview()}});
  dom.clear.addEventListener("click",()=>{endCaption();state.items=[];state.selectedUid=null;normalizeCanvas();renderAll()});
  dom.reset.addEventListener("click",()=>{endCaption();state.layout="auto";state.items.forEach((it)=>{it.weight=1;resetCaption(it)});if(state.items.length)arrange();renderAll()});
  $$(`[data-close]`).forEach((b)=>b.addEventListener("click",()=>close()));

  $("[data-view-fit]").addEventListener("click",resetView);
  dom.dialog.addEventListener("pointerdown",(e)=>{
    if(e.button!==0||e.target.closest("button,input,select,textarea,label,a,[data-canvas],[data-caption-inline],[data-item-id]"))return;
    endCaption();state.selectedUid=null;renderStrip();renderPreview();
  });
  dom.stage.addEventListener("wheel",(e)=>{
    if(dom.canvas.hidden||state.drag)return;
    e.preventDefault();
    const r=dom.canvas.getBoundingClientRect(),s=dom.stage.getBoundingClientRect();
    const zoom=clamp(state.zoom*Math.exp(-e.deltaY*(e.deltaMode===1?.025:.0015)),1,6);
    Object.assign(state,zoomAt(state.zoom,zoom,{x:e.clientX,y:e.clientY},r,s,0));
    state.zoom=zoom;fitPreview();positionCaptionUI();
  },{passive:false});
  dom.stage.addEventListener("pointerdown",(e)=>{
    if(e.button!==1||dom.canvas.hidden)return;
    e.preventDefault();const start={x:e.clientX,y:e.clientY,panX:state.panX,panY:state.panY};
    const move=(event)=>{state.panX=start.panX+event.clientX-start.x;state.panY=start.panY+event.clientY-start.y;fitPreview();positionCaptionUI()};
    const up=()=>{dom.stage.removeEventListener("pointermove",move);dom.stage.removeEventListener("pointerup",up);dom.stage.removeEventListener("pointercancel",up)};
    dom.stage.setPointerCapture(e.pointerId);dom.stage.addEventListener("pointermove",move);dom.stage.addEventListener("pointerup",up);dom.stage.addEventListener("pointercancel",up);
  });
  dom.stage.addEventListener("dragover",(e)=>{e.preventDefault();e.dataTransfer.dropEffect="copy";dom.stage.classList.add("is-dragover")});
  dom.stage.addEventListener("dragleave",()=>dom.stage.classList.remove("is-dragover"));
  dom.stage.addEventListener("drop",(e)=>{e.preventDefault();dom.stage.classList.remove("is-dragover");const id=e.dataTransfer.getData("text/plain"),asset=state.assetMap.get(id);if(!asset)return;if(state.items.some((it)=>it.assetId===id)){notify("info",`${asset.reference||"Media"} is already on canvas.`);return}endCaption();const p=dropPoint(e),it=createItem(asset,p.x,p.y);if(!it)return;state.items.push(it);state.selectedUid=it.uid;loadVisual(asset).then(renderPreview).catch((err)=>notify("error",err.message));normalizeCanvas();renderAll()});

  dom.canvas.addEventListener("pointerdown",(e)=>{if(e.button!==0)return;const hit=hitTest(canvasPoint(e));e.preventDefault();endCaption();const p=canvasPoint(e);if(!hit.it){state.selectedUid=null;renderStrip();renderPreview();return}state.selectedUid=hit.it.uid;e.preventDefault();if(hit.handle==="caption"){startCaption(hit.it);return}state.drag={type:hit.handle==="body"?"move":"resize",handle:hit.handle,it:hit.it,start:p,initialArea:hit.it.w*hit.it.h,orig:{x:hit.it.x,y:hit.it.y,w:hit.it.w,h:hit.it.h,weight:itemWeight(hit.it)}};dom.canvas.setPointerCapture(e.pointerId);renderStrip();renderPreview()});
  dom.canvas.addEventListener("pointermove",(e)=>{if(!state.drag){const h=hitTest(canvasPoint(e)).handle;dom.canvas.style.cursor=h==="caption"?"text":h==="body"?"move":h?`${h}-resize`:"default";return}const p=canvasPoint(e),d=state.drag,it=d.it,dx=p.x-d.start.x,dy=p.y-d.start.y;if(d.type==="move"){const pos=snapMove(it,d.orig.x+dx,d.orig.y+dy);it.x=pos.x;it.y=pos.y}else{const w=resizedWidth(d.orig,d.handle,dx,dy,it.ar),h=w/it.ar;if(d.handle.includes("w"))it.x=d.orig.x+(d.orig.w-w);if(d.handle.includes("n"))it.y=d.orig.y+(d.orig.h-h);it.w=w;it.h=h}renderPreview()});
  const endDrag=(e)=>{if(!state.drag)return;const d=state.drag;try{dom.canvas.releasePointerCapture(e.pointerId)}catch{}if(d.type==="resize"){const before=Math.max(1,d.initialArea),after=Math.max(1,d.it.w*d.it.h);d.it.weight=clamp(d.orig.weight*(after/before),.2,5)}state.drag=null;normalizeCanvas();renderAll()};
  dom.canvas.addEventListener("pointerup",endDrag);dom.canvas.addEventListener("pointercancel",endDrag);dom.canvas.addEventListener("pointerleave",()=>{if(!state.drag)dom.canvas.style.cursor="default"});

  dom.captionAdd.addEventListener("click",()=>startCaption(selected()));
  dom.captionInput.addEventListener("input",()=>{const it=editing();if(!it)return;it.caption=dom.captionInput.value;normalizeCanvas();renderPreview()});
  dom.captionInput.addEventListener("blur",()=>endCaption());
  dom.captionInput.addEventListener("keydown",(e)=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();endCaption(true)}else if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();endCaption()}});
  dom.captionRemove.addEventListener("pointerdown",(e)=>e.preventDefault());dom.captionRemove.addEventListener("click",()=>{const it=editing();if(it)it.caption="";endCaption()});
  $$(`[data-caption-handle]`,dom.captionBox).forEach((handle)=>handle.addEventListener("pointerdown",(e)=>{const it=editing();if(!it||e.button!==0)return;e.preventDefault();const c=captionLayout(it),start=canvasPoint(e),kind=handle.dataset.captionHandle,orig={custom:captionCustom(it),width:captionWidthRatio(it),font:captionFontRatio(it),capX:c.x,capW:c.w};const move=(ev)=>{const dx=canvasPoint(ev).x-start.x;if(kind==="scale"){const f=clamp((orig.capW+dx)/Math.max(1,orig.capW),.45,3);it.captionFontRatio=clamp(orig.font*f,.018,.12);if(orig.custom)it.captionWidthRatio=clamp(orig.width*f,.35,3)}else{const right=orig.capX+orig.capW;let x=orig.capX,w=orig.capW;if(kind==="right")w=Math.max(70,orig.capW+dx);else{x=Math.min(right-70,orig.capX+dx);w=right-x}it.captionWidthRatio=clamp(w/Math.max(1,it.w),.35,3);it.captionXRatio=clamp((x+w/2-(it.x+it.w/2))/Math.max(1,it.w),-2,2)}renderPreview()};const up=(ev)=>{handle.removeEventListener("pointermove",move);handle.removeEventListener("pointerup",up);handle.removeEventListener("pointercancel",up);try{handle.releasePointerCapture(ev.pointerId)}catch{}normalizeCanvas();renderPreview();dom.captionInput.focus({preventScroll:true})};handle.setPointerCapture(e.pointerId);handle.addEventListener("pointermove",move);handle.addEventListener("pointerup",up);handle.addEventListener("pointercancel",up)}));

  async function exportPicture() {
    await Promise.all(state.items.map((it)=>loadVisual(itemAsset(it))));
    const r=outputResolution(),canvas=document.createElement("canvas");canvas.width=r.W;canvas.height=r.H;drawOutput(canvas.getContext("2d"),r.W,r.H,false);
    const blob=await canvasBlob(canvas),sources=[...new Map(state.items.map((it)=>{const a=itemAsset(it);return[a.id,{id:a.id,type:a.type,reference:a.reference||null}]})).values()],captions=state.items.filter((it)=>captionText(it)).map((it)=>({source:itemAsset(it)?.reference||null,text:captionText(it)}));
    return {blob,width:r.W,height:r.H,mimeType:"image/png",filename:"composed.png",sources,captions};
  }

  async function downloadPicture() {
    if(!state.items.length||dom.download.disabled)return;
    dom.download.disabled=true;
    try {
      const payload=await exportPicture(),url=URL.createObjectURL(payload.blob),link=document.createElement("a");link.href=url;link.download=payload.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
    } catch (error) { notify("error",error?.message||String(error)); }
    finally { dom.download.disabled=!state.items.length; }
  }

  async function copyPicture() {
    if(!state.items.length||dom.copy.disabled)return;
    dom.copy.disabled=true;
    try {
      if(!navigator.clipboard?.write||typeof ClipboardItem!=="function")throw new Error("Image clipboard is not available in this browser.");
      const png=exportPicture().then((payload)=>payload.blob);
      await navigator.clipboard.write([new ClipboardItem({"image/png":png})]);
      notify("info","Composition copied as PNG.");
    } catch (error) { notify("error",error?.message||String(error)); }
    finally { dom.copy.disabled=!state.items.length; }
  }

  async function addPicture() {
    if (!state.items.length || dom.add.disabled) return;
    const openGeneration = state.openGeneration;
    dom.add.disabled = true;
    try {
      const payload = await exportPicture();
      if (!state.open || state.openGeneration !== openGeneration) return;
      await onAddPicture(payload);
      if (!state.open || state.openGeneration !== openGeneration) return;
      state.items = [];
      state.selectedUid = null;
      normalizeCanvas();
      close();
    } catch (error) {
      if (!state.open || state.openGeneration !== openGeneration) return;
      notify("error", error?.message || String(error));
      renderPreview();
    }
  }
  dom.copy.addEventListener("click",copyPicture);
  dom.download.addEventListener("click",downloadPicture);
  dom.add.addEventListener("click",addPicture);

  const onKey=(e)=>{if(!state.open)return;if(e.key==="Escape"){e.preventDefault();const menu=root.querySelector("[data-interface-size-menu]");if(menu&&!menu.hidden){root.querySelector("[data-interface-size-toggle]").click();root.querySelector("[data-interface-size-toggle]").focus();return}close()}else if((e.key==="Delete"||e.key==="Backspace")&&state.selectedUid&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)){e.preventDefault();removeItem(state.selectedUid)}else if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)&&!dom.add.disabled){e.preventDefault();addPicture()}};
  const onResize=()=>{if(state.open){fitPreview();positionCaptionUI()}};
  const resizeObserver=new ResizeObserver(onResize);resizeObserver.observe(dom.stage);
  document.addEventListener("keydown",onKey);window.addEventListener("resize",onResize);

  function setAssets(assets=[]) {
    state.visualRevision++;state.assets=assets.filter(Boolean);state.assetMap=new Map(state.assets.map((a)=>[String(a.id),a]));state.visuals.clear();state.visualPromises.clear();
    state.items=state.items.filter((it)=>state.assetMap.has(String(it.assetId)));
    for(const it of state.items){const d=descriptor(itemAsset(it));if(d)updateItemAspect(it,d.ar)}
    if(state.selectedUid&&!state.items.some((it)=>it.uid===state.selectedUid))state.selectedUid=null;
  }

  function open({ assets = [], trigger = null } = {}) {
    if (state.open) return;
    const openGeneration = ++state.openGeneration;
    setAssets(assets);
    state.zoom = 1;
    state.panX = state.panY = 0;
    const controls = $("[data-shell-controls]"),
      closeButton = controls.querySelector("[data-close]");
    for (const selector of [
      "[data-theme-toggle]",
      "[data-interface-size-picker]",
      "[data-fullscreen-toggle]",
    ]) {
      const control = root.querySelector(selector);
      if (!control) continue;
      const home = document.createComment("Composer control position");
      control.before(home);
      shellHomes.push({ control, home });
      controls.insertBefore(control, closeButton);
    }
    state.returnFocus = trigger || document.activeElement;
    state.open = true;
    el.classList.add("is-open");
    el.setAttribute("aria-hidden", "false");
    dom.dialog.setAttribute("aria-modal", "true");
    onOpenChange(true);
    normalizeCanvas();
    renderAll();
    state.assets
      .filter((a) => a.type === "image" || a.type === "video")
      .forEach((a) =>
        loadVisual(a)
          .then(() => state.open && renderPreview())
          .catch(() => {}),
      );
    requestAnimationFrame(() => {
      if (state.open && state.openGeneration === openGeneration)
        ($(`[data-source-id]`) || dom.dialog).focus();
    });
  }
  function close() {
    if (!state.open) return;
    clearDragGhost();
    endCaption();
    state.open = false;
    state.drag = null;
    for (const { control, home } of shellHomes.splice(0)) {
      home.replaceWith(control);
    }
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
    dom.dialog.removeAttribute("aria-modal");
    onOpenChange(false);
    state.returnFocus?.focus?.({ preventScroll: true });
  }
  function destroy() { close();resizeObserver.disconnect();document.removeEventListener("keydown",onKey);window.removeEventListener("resize",onResize);el.remove();state.visuals.clear();state.visualPromises.clear(); }

  renderControls();
  return {open,close,destroy,setAssets};
}
