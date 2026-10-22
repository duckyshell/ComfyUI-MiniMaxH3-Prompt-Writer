import { promptHighlightMarkup, createPromptMirrorHighlighter } from "./prompt_highlights.js";
import { loadSequence, saveSequence, addChunk, deleteChunk, timeline, effectiveMedia, aggregate, duration, MAX_CHUNK_DURATION, sequenceInstructionDefault, setSequenceFormat, revisePrompt, assignReference, removeReference, reconcileMedia } from "./sequence_state.js";
import { createSequenceController } from "./sequence_controller.js";
import { mediaVisualDescriptor } from "./media_visual.js";
import { fitTextarea, formatChoiceMarkup, generationButtonMarkup, aspectRatioMarkup, bindAspectRatio, splitMenuMarkup, setSplitMenuOpen, copyButtonMarkup } from "./writer_controls.js";
import { msg, t } from "./i18n.js";

export const displaySeparator = value => value.replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/\r/g,"\\r").replace(/\t/g,"\\t");
export const parseSeparator = value => value.replace(/\\([\\nrt])/g,(_, char)=>({n:"\n",r:"\r",t:"\t","\\":"\\"}[char]));

const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const button = (action, label, extra = "") => `<button type="button" class="h3ps-text-button" data-seq-action="${action}" ${extra}>${label}</button>`;
const paths = { undo:'<path d="M9 5 4 10l5 5M4 10h9a6 6 0 0 1 6 6v3"/>', redo:'<path d="m15 5 5 5-5 5m5-5h-9a6 6 0 0 0-6 6v3"/>', reader:'<path d="M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3zM12 6v15"/>', minus:'<path d="M5 12h14"/>', plus:'<path d="M5 12h14M12 5v14"/>' };
const ROLE_LABEL_KEYS = { first: "sequence.role.first", last: "sequence.role.last", references: "sequence.role.references" };
const MEDIA_ROLE_KEYS = { "First frame": "sequence.role.first", "Last frame": "sequence.role.last", "Reference": "sequence.role.reference" };
const STATUS_KEYS = {
  queued: "sequence.status.queued", generating: "sequence.status.generating",
  checking: "sequence.status.checking", repairing: "sequence.status.repairing",
  failed: "sequence.status.failed", not_started: "sequence.status.not_started",
  cancelled: "sequence.status.cancelled", stopped: "sequence.status.stopped",
};

export function createSequenceWorkspace(host) {
  const { root } = host, state = loadSequence(host.storage);
  const highlights = createPromptMirrorHighlighter(root.ownerDocument);
  let enabled = false, reader = false, selection = null, activeTarget = null;
  const chunks = new Map(), refineDrafts = new Map(), promptCarets = new Map();
  const svg = name => paths[name] ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>` : host.icon(name,15);
  const iconButton = (action, label, name, extra = "", labelKey = "") => {
    const locale = labelKey ? ` data-i18n-title="${labelKey}" data-i18n-aria-label="${labelKey}"` : "";
    return `<button type="button" class="h3ps-icon-button" data-seq-action="${action}" title="${label}" aria-label="${label}"${locale} ${extra}>${svg(name)}</button>`;
  };
  const generateButton = document.createElement("button");
  generateButton.type = "button"; generateButton.className = "h3ps-primary-button"; generateButton.dataset.seqGenerate = "";
  root.querySelector("[data-generate]").after(generateButton);
  const selector = document.createElement("div");
  selector.className = "h3ps-clear-control h3ps-sequence-selector";
  selector.innerHTML = splitMenuMarkup(host.icon, {label:t("sequence.mode.single"), primary:"data-seq-selector", toggle:"data-seq-selector-caret", menu:"data-seq-menu", ariaLabel:"Writer workspace", ariaLabelKey:"sequence.workspace_aria", contents:`${button("single",`<strong data-i18n="sequence.mode.single">${t("sequence.mode.single")}</strong><small data-i18n="sequence.default_h3">${t("sequence.default_h3")}</small>`)}${button("sequence",`<strong data-i18n="sequence.mode.sequence">${t("sequence.mode.sequence")}</strong><small data-i18n="sequence.chunked_prompts">${t("sequence.chunked_prompts")}</small>`)}`});
  root.querySelector(".h3ps-section-actions").prepend(selector);
  const left = document.createElement("div"); left.className = "h3ps-sequence-inputs";
  left.innerHTML = `<div class="h3ps-control-grid"><label class="h3ps-field h3ps-duration-field" title="${t("sequence.duration_hint")}" data-i18n-title="sequence.duration_hint"><span><span data-i18n="sequence.new_duration">${t("sequence.new_duration")}</span> <b data-seq-default-label></b></span><div><input type="range" min="1" max="${MAX_CHUNK_DURATION}" step="1" data-seq-default><i></i></div></label>${aspectRatioMarkup(host.icon,"sequence-aspect")}</div>
    <section class="h3ps-sequence-media"><strong title="${t("sequence.media_hint")}" data-i18n-title="sequence.media_hint" data-i18n="sequence.media">${t("sequence.media")}</strong><div data-seq-global-media></div></section>
    <label class="h3ps-brief"><span><strong data-i18n="sequence.brief">${t("sequence.brief")}</strong><small data-i18n="sequence.brief_hint">${t("sequence.brief_hint")}</small></span><textarea spellcheck="false" data-seq-brief placeholder="${t("sequence.brief_placeholder")}" data-i18n-placeholder="sequence.brief_placeholder"></textarea><small class="h3ps-char-count" data-seq-brief-count></small></label>
    <section class="h3ps-music-system-prompt"><button type="button" class="h3ps-music-system-prompt-toggle" data-seq-action="instructions" aria-expanded="false"><strong data-i18n="sequence.instructions">${t("sequence.instructions")}</strong><span>${host.icon("chevron",12)}</span></button><div data-seq-instructions-panel hidden><div class="h3ps-system-prompt-panel"><textarea spellcheck="false" maxlength="32000" data-seq-instructions aria-label="${t("sequence.instructions")}" data-i18n-aria-label="sequence.instructions"></textarea><footer class="h3ps-sequence-instructions-footer">${formatChoiceMarkup(t("sequence.format_label"),[["format-official",`<span data-i18n="sequence.format.official">${t("sequence.format.official")}</span>`],["format-compact",`<span data-i18n="sequence.format.compact">${t("sequence.format.compact")}</span>`]],"format-"+state.outputFormat,"sequence.format_label")}${button("reset", `<span data-i18n="sequence.restore_default">${t("sequence.restore_default")}</span>`)}</footer></div><small class="h3ps-sequence-contract-hint" data-seq-contract></small></div></section>`;
  root.querySelector("[data-video-inputs]").append(left);
  left.querySelector("[data-seq-brief]").value = state.brief;
  left.querySelector("[data-seq-instructions]").value = state.instructions;
  left.querySelector("[data-seq-default]").value = state.defaultDuration;
  const aspectControl = bindAspectRatio(left.querySelector(".h3ps-choice"), state.aspectRatio, value => { state.aspectRatio = value; persist(); });
  const right = document.createElement("section"); right.className = "h3ps-sequence-output"; right.setAttribute("aria-label",t("sequence.generated_aria")); right.setAttribute("data-i18n-aria-label","sequence.generated_aria");
  right.innerHTML = `<header><strong data-i18n="sequence.generated_title">${t("sequence.generated_title")}</strong><span data-seq-count></span>${iconButton("reader",t("sequence.reader"),"reader",'aria-pressed="false"',"sequence.reader")}${copyButtonMarkup(host.icon,`data-seq-action="copy-all" title="${t("sequence.copy_all")}" aria-label="${t("sequence.copy_all")}" data-i18n-title="sequence.copy_all" data-i18n-aria-label="sequence.copy_all"`, "", true)}</header><section class="h3ps-sequence-copy-format" data-seq-copy-format hidden aria-label="${t("sequence.copy_format")}" data-i18n-aria-label="sequence.copy_format">
    <div class="h3ps-sequence-copy-options"><span data-i18n="sequence.copy_format">${t("sequence.copy_format")}</span>${formatChoiceMarkup(t("sequence.copy_format"),[["copy-default",`<span data-i18n="common.default">${t("common.default")}</span>`],["copy-custom",`<span data-i18n="common.custom">${t("common.custom")}</span>`]],"copy-default","sequence.copy_format")}<small data-seq-copy-default data-i18n="sequence.copy.prompts_only">${t("sequence.copy.prompts_only")}</small></div>
    <div class="h3ps-sequence-copy-editor" data-seq-copy-custom hidden><div class="h3ps-sequence-copy-heading"><span data-i18n="sequence.copy.shape">${t("sequence.copy.shape")}</span>${button("copy-reset", `<span data-i18n="common.reset">${t("common.reset")}</span>`)}</div>
      <div class="h3ps-sequence-copy-examples" aria-label="${t("sequence.copy.examples_aria")}" data-i18n-aria-label="sequence.copy.examples_aria">${button("copy-divider", `<span data-i18n="sequence.copy.divider">${t("sequence.copy.divider")}</span>`)}${button("copy-times", `<span data-i18n="sequence.copy.time_ranges">${t("sequence.copy.time_ranges")}</span>`)}${button("copy-numbered", `<span data-i18n="sequence.copy.numbered">${t("sequence.copy.numbered")}</span>`)}${button("copy-chapters", `<span data-i18n="sequence.copy.chapters">${t("sequence.copy.chapters")}</span>`)}</div>
      <label class="h3ps-field"><span data-i18n="sequence.copy.per_chunk">${t("sequence.copy.per_chunk")}</span><textarea spellcheck="false" data-seq-copy-template maxlength="8000" rows="2" spellcheck="false" aria-label="${t("sequence.copy.chunk_template")}" data-i18n-aria-label="sequence.copy.chunk_template"></textarea></label>
      <label class="h3ps-field"><span><span data-i18n="sequence.copy.between_chunks">${t("sequence.copy.between_chunks")}</span> <small data-i18n="sequence.copy.newline_hint">${t("sequence.copy.newline_hint")}</small></span><input type="text" data-seq-copy-separator maxlength="2000" spellcheck="false" aria-label="${t("sequence.copy.between_chunks")}" data-i18n-aria-label="sequence.copy.between_chunks" placeholder="${t("sequence.copy.nothing_added")}" data-i18n-placeholder="sequence.copy.nothing_added"></label>
      <small class="h3ps-sequence-copy-tokens">{prompt} <span data-i18n="sequence.copy.token_text">${t("sequence.copy.token_text")}</span> · {index} <span data-i18n="sequence.copy.token_number">${t("sequence.copy.token_number")}</span> · {start} / {end} / {duration} <span data-i18n="sequence.copy.token_seconds">${t("sequence.copy.token_seconds")}</span></small>
    </div>
    </section><pre class="h3ps-sequence-reader-text" data-seq-copy-preview hidden></pre><small class="h3ps-sequence-progress" data-seq-progress role="status"></small><div class="h3ps-sequence-chunks"></div><div class="h3ps-sequence-add" data-seq-chrome><button type="button" class="h3ps-secondary-button" data-seq-action="add">${svg("plus")} <span data-i18n="sequence.add_chunk">${t("sequence.add_chunk")}</span></button></div>`;
  root.querySelector(".h3ps-workspace").append(right);
  right.querySelector("[data-seq-copy-template]").value=state.copyFormat.template;
  right.querySelector("[data-seq-copy-separator]").value=displaySeparator(state.copyFormat.separator);
  const persist = () => { try { saveSequence(host.storage,state); } catch(e) { host.error(e); } };
  const changed = () => { persist(); render(); };
  const controller = createSequenceController({state, snapshot:host.snapshot, prepare:host.prepare, run:host.run, cancel:host.cancel,
    changed, progressChanged:render, error:host.error, settled:host.settled, busyChanged(busy) { if(busy) selection=null; host.busy(busy); left.inert=busy; render(); } });
  function fit(editor) {
    if (!editor || editor.closest("[hidden]")) return;
    fitTextarea(editor, editor.matches("[data-seq-copy-template]") ? 56 : editor.value ? 90 : 52);
  }
  function sync() {
    left.querySelector("[data-seq-brief-count]").textContent=t("sequence.characters",{count:state.brief.length.toLocaleString()});
    root.classList.toggle("is-sequence",enabled); root.classList.toggle("is-sequence-reader",enabled && reader);
    root.classList.toggle("is-sequence-selecting",enabled && !!selection);
    left.hidden=right.hidden=!enabled;
    selector.querySelector("[data-seq-selector]").textContent=t(enabled ? "sequence.mode.sequence" : "sequence.mode.single");
    generateButton.hidden=!enabled;
    const markup=generationButtonMarkup(host.icon,controller.busy,msg(primaryAction()==="all" ? "sequence.regenerate" : "sequence.generate"));
    setMarkup(generateButton,markup);
    generateButton.classList.toggle("is-cancel",controller.busy);
    generateButton.disabled=false;
    left.querySelector("[data-seq-default-label]").textContent=`${state.defaultDuration}s`;
    left.querySelector("[data-seq-default]").style.setProperty("--h3ps-range",`${(state.defaultDuration-1)/(MAX_CHUNK_DURATION-1)*100}%`);
    left.querySelectorAll('[data-seq-action^="format-"]').forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.seqAction==="format-"+state.outputFormat)));
    left.querySelector('[data-seq-contract]').textContent=
      (state.outputFormat==="compact" ? t("sequence.contract.compact") : t("sequence.contract.official"))
      + " " + t("sequence.contract.common");
    syncSelection();
    right.querySelector("[data-seq-copy-format]").hidden=!reader;
    right.querySelector("[data-seq-copy-format]").inert=controller.busy;
    const custom=state.copyFormat.format==="custom", preview=reader && custom && !state.chunks.some(c=>c.attention);
    right.querySelector("[data-seq-copy-custom]").hidden=!custom;
    right.querySelector("[data-seq-copy-default]").hidden=custom;
    right.querySelector("[data-seq-copy-preview]").hidden=!preview;
    right.querySelector("[data-seq-copy-preview]").textContent=reader && custom ? aggregate(state) : "";
    right.querySelector(".h3ps-sequence-chunks").hidden=preview;
    right.querySelector('[data-seq-action="copy-default"]').setAttribute("aria-pressed",String(!custom));
    right.querySelector('[data-seq-action="copy-custom"]').setAttribute("aria-pressed",String(custom));
    right.querySelector('[data-seq-action="reader"]').setAttribute("aria-pressed",String(reader));
    right.querySelector('[data-seq-action="reader"]').disabled=controller.busy;
    right.querySelector('[data-seq-action="copy-all"]').disabled=!state.chunks.some(c=>c.prompt.trim());
  }
  const primaryAction = () => state.chunks.every(c=>c.prompt.trim() && !c.attention) ? "all" : "missing";
  function setReader(value) { reader=value; selection=null; activeTarget=null; render(); }
  function syncSelection() {
    let found=false;
    root.querySelectorAll("[data-seq-slot]").forEach(el=>{
      const target=slotTarget(el), active=enabled && !!selection && target.key===selection.key && target.chunk===selection.chunk && target.previous===selection.previous;
      el.classList.toggle("is-selecting",active);
      const cancel=el.querySelector('[data-seq-action="selection-cancel"]');if(cancel) cancel.hidden=!active;
      const add=el.querySelector('[data-seq-action="select-media"]');if(add) add.setAttribute("aria-pressed",String(active));
      found ||= active;
    });
    if(!found) selection=null;
    root.classList.toggle("is-sequence-selecting",!!selection);
    root.querySelectorAll('[data-h3ps-media] [data-asset-id]').forEach(card=>{
      const asset=host.assets().find(a=>a.id===card.dataset.assetId);
      card.classList.toggle("is-sequence-selectable",!!selection && !!asset && asset.status!=="needs_edit" && (selection.key==="references" || asset.type==="image"));
    });
  }
  function setEnabled(value) {
    if(value===enabled || (!enabled && host.isBusy())) return;
    if(!value) controller.leave();
    enabled=value; reader=false; selection=null; activeTarget=null;
    if(enabled && reconcileMedia(state,host.assets())) persist();
    render(); host.refresh();
  }
  function slot(key, assetId = "", tag = "", chunkId = "", editable = true) {
    const asset=host.assets().find(a=>a.id===assetId), src=asset?.preview_url || (asset ? mediaVisualDescriptor(asset)?.src : null);
    const typeLabels={image:t("sequence.type.image"),video:t("sequence.type.video"),audio:t("sequence.type.audio")};
    const label=asset ? tag || typeLabels[asset.type] : t("sequence.add_media");
    const addAria=key==="references" ? t("sequence.add_reference_aria") : key==="last" ? t("sequence.add_last_frame_aria") : t("sequence.add_first_frame_aria");
    const insertable=!!asset && !!chunkId;
    const element=asset && !insertable ? "span" : "button";
    const identity=`data-key="${key}" data-asset="${escape(assetId)}" data-slot-chunk="${escape(chunkId)}"`;
    return `<span class="h3ps-sequence-slot" ${editable ? "data-seq-slot" : "data-seq-anchor"} ${identity}><${element} ${insertable ? 'type="button" data-seq-action="insert-media"' : asset ? "" : 'type="button" data-seq-action="select-media" aria-pressed="false"'} class="h3ps-add-asset" title="${escape(asset ? asset.filename || label : t("sequence.choose_media"))}" ${asset ? "" : `aria-label="${escape(addAria)}"`}>${asset ? src ? `<img src="${escape(src)}" alt="">` : svg(asset.type === "audio" ? "audio" : "image") : svg("plus")}<span>${escape(label)}</span></${element}>${asset && editable ? iconButton("remove-media",t("sequence.remove_media"),"close") : !asset ? button("selection-cancel",t("common.cancel"),"hidden") : ""}</span>`;
  }
  function setMarkup(el, markup) { if(el._sequenceMarkup!==markup) { el.innerHTML=markup; el._sequenceMarkup=markup; } }
  function chunkElement(c) {
    const section=document.createElement("section"); section.className="h3ps-sequence-chunk"; section.dataset.chunk=c.id;
    section.innerHTML=`<header><strong data-seq-heading></strong><small class="h3ps-sequence-progress" data-seq-status role="status"></small><details class="h3ps-sequence-attention" data-seq-attention hidden><summary aria-label="${t("sequence.attention_aria")}" data-i18n-aria-label="sequence.attention_aria" aria-describedby="h3ps-seq-help-${escape(c.id)}" title="${t("sequence.attention_title")}" data-i18n-title="sequence.attention_title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/></svg></summary><div><strong data-i18n="sequence.attention_heading">${t("sequence.attention_heading")}</strong><p data-seq-help id="h3ps-seq-help-${escape(c.id)}"></p></div></details><div class="h3ps-sequence-duration" data-seq-chrome>${iconButton("decrease",t("sequence.shorten"),"minus","","sequence.shorten")}<span data-seq-duration></span>${iconButton("increase",t("sequence.lengthen"),"plus","","sequence.lengthen")}</div>${iconButton("delete",t("sequence.delete_chunk"),"close",'data-seq-chrome',"sequence.delete_chunk")}</header>
      <input spellcheck="false" class="h3ps-sequence-instruction" data-seq-instruction data-seq-chrome placeholder="${t("sequence.instruction_placeholder")}" data-i18n-placeholder="sequence.instruction_placeholder" title="${t("sequence.instruction_title")}" data-i18n-title="sequence.instruction_title">
      <div class="h3ps-sequence-conditioning" data-seq-chrome aria-label="${t("sequence.conditioning_aria")}" data-i18n-aria-label="sequence.conditioning_aria"></div>
      <div class="h3ps-sequence-editor" data-seq-chrome><div class="h3ps-editor-highlight h3ps-sequence-highlights" data-seq-highlights aria-hidden="true"></div><textarea spellcheck="false" class="h3ps-sequence-prompt" data-seq-prompt data-seq-chrome placeholder="${t("sequence.prompt_placeholder")}" data-i18n-placeholder="sequence.prompt_placeholder"></textarea></div><pre class="h3ps-sequence-reader-text h3ps-editor-highlight" data-seq-reader-text hidden></pre>
      <div class="h3ps-sequence-chunk-actions" data-seq-chrome>${button("refine-open", `<span data-i18n="sequence.refine">${t("sequence.refine")}</span>`)}${button("generate", t("sequence.chunk_regenerate"))}${copyButtonMarkup(host.icon,`data-seq-action="copy" title="${t("sequence.copy_prompt")}" aria-label="${t("sequence.copy_prompt")}" data-i18n-title="sequence.copy_prompt" data-i18n-aria-label="sequence.copy_prompt"`)}${iconButton("undo",t("sequence.undo"),"undo","","sequence.undo")}${iconButton("redo",t("sequence.redo"),"redo","","sequence.redo")}</div>
      <div class="h3ps-refine" data-seq-refine data-seq-chrome hidden><div class="h3ps-refine-heading"><span><strong data-seq-refine-title></strong><small data-i18n="sequence.describe_change">${t("sequence.describe_change")}</small></span></div><textarea spellcheck="false" data-seq-refine-instruction placeholder="${t("sequence.describe_change")}" data-i18n-placeholder="sequence.describe_change"></textarea><div class="h3ps-refine-actions">${button("refine-close", `<span data-i18n="common.cancel">${t("common.cancel")}</span>`)}<button type="button" class="h3ps-refine-submit" data-seq-action="refine">${host.icon("spark",13)} <span data-i18n="sequence.refine">${t("sequence.refine")}</span></button></div></div>`;
    return section;
  }
  function render() {
    highlights.clear();
    const scroll=right.scrollTop, rows=timeline(state), list=right.querySelector(".h3ps-sequence-chunks");
    const ids=new Set(rows.map(c=>c.id));
    for(const [id,el] of chunks) if(!ids.has(id)) { el.remove(); chunks.delete(id); refineDrafts.delete(id); }
    setMarkup(left.querySelector("[data-seq-global-media]"), ["first","last","references"].map(key=>`<div class="h3ps-sequence-media-row" data-media-role="${key}"><span>${t(ROLE_LABEL_KEYS[key])}</span><div>${(key==="references" ? state.references : state[key] ? [state[key]] : []).map(id=>slot(key,id)).join("")}${key==="references" || !state[key] ? slot(key) : ""}</div></div>`).join(""));
    right.querySelector("[data-seq-count]").textContent=t(rows.length===1?"sequence.count.one":"sequence.count.other",{count:rows.length,end:rows.at(-1).end});
    right.querySelector("[data-seq-progress]").textContent=controller.phase;
    rows.forEach(c=>{
      let el=chunks.get(c.id); if(!el) { el=chunkElement(c); chunks.set(c.id,el); list.append(el); }
      el.querySelector("[data-seq-heading]").textContent=`${String(c.index).padStart(2,"0")} · ${c.start}–${c.end}s`;
      const status=controller.progress.get(c.id);
      el.querySelector("[data-seq-status]").textContent=status && STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : "";
      const attention=el.querySelector("[data-seq-attention]");
      attention.hidden=!c.attention;
      if(!c.attention) attention.open=false;
      el.querySelector("[data-seq-help]").textContent=c.attention || "";
      el.querySelector("[data-seq-duration]").textContent=`${c.duration}s`;
      for(const [selector,value] of [["[data-seq-instruction]",c.instruction],["[data-seq-prompt]",controller.busy && status ? "" : c.prompt]]) { const input=el.querySelector(selector); if(input.value!==value) input.value=value; input.setAttribute("aria-label",t(selector.includes("prompt")?"sequence.chunk.prompt_aria":"sequence.chunk.direction_aria",{index:c.index})); }
      // Reader is a projection of the canonical prompt, never a separately edited draft.
      highlights.paint(el.querySelector("[data-seq-highlights]"),promptHighlightMarkup(el.querySelector("[data-seq-prompt]").value,state.outputFormat) + "\n");
      setMarkup(el.querySelector("[data-seq-reader-text]"),promptHighlightMarkup(c.prompt,state.outputFormat));
      el.querySelector("[data-seq-reader-text]").hidden=!reader;
      setMarkup(el.querySelector(".h3ps-sequence-conditioning"), effectiveMedia(state,c.id,host.assets()).map(m=>{
        const roleKey=MEDIA_ROLE_KEYS[m.role], roleLabel=roleKey ? t(roleKey) : m.role;
        return m.role==="Reference" ? slot("references",m.assetId,m.tag,c.id) : slot(m.role==="First frame"?"first":"last",m.assetId,m.tag===m.role ? roleLabel : `${roleLabel} · ${m.tag}`,c.id,false);
      }).join("")+slot("references","","",c.id));
      el.querySelector("[data-seq-refine-title]").textContent=t("sequence.refine_title",{index:String(c.index).padStart(2,"0")});
      el.querySelector("[data-seq-refine]").hidden=!refineDrafts.get(c.id)?.open;
      el.querySelectorAll("button,input,textarea").forEach(b=>b.disabled=controller.busy && !b.matches('[data-seq-action="copy"]'));
      const disable=(action,condition)=>el.querySelector(`[data-seq-action="${action}"]`).disabled=controller.busy || condition;
      disable("delete",rows.length===1); disable("decrease",c.duration<=1); disable("increase",c.duration>=MAX_CHUNK_DURATION);
      disable("undo",!c.undo.length); disable("redo",!c.redo.length); disable("refine-open",!c.prompt.trim());
      el.querySelector('[data-seq-action="copy"]').disabled=!c.prompt.trim();
      el.querySelector('[data-seq-action="generate"]').textContent=t(c.prompt.trim()?"sequence.chunk_regenerate":"sequence.chunk_generate");
    });
    for(const action of ["add"]) right.querySelector(`[data-seq-action="${action}"]`).disabled=controller.busy;
    sync(); fit(left.querySelector("[data-seq-brief]")); if(!reader) right.querySelectorAll("[data-seq-prompt]").forEach(fit);
    right.scrollTop=scroll;
  }
  function assign(target,id) {
    const asset=host.assets().find(a=>a.id===id);
    if(!asset || asset.status==="needs_edit" || (target.key!=="references" && asset.type!=="image")) { host.error(new Error(t("sequence.error.choose_media"))); return; }
    const c=state.chunks.find(c=>c.id===target.chunk);
    if(target.chunk && !c) return;
    if(c) assignReference(state,c,id,target.previous);
    else if(target.key==="references") state.references=[...new Set(state.references.map(x=>x===target.previous?id:x).concat(id))];
    else state[target.key]=id;
    selection=null; changed();
  }
  const slotTarget = el => ({key:el.dataset.key,previous:el.dataset.asset,chunk:el.dataset.slotChunk});
  async function action(event) {
    const el=event.target.closest("[data-seq-action]"); if(!el || el.disabled) return;
    const name=el.dataset.seqAction, section=el.closest("[data-chunk]"), c=state.chunks.find(c=>c.id===section?.dataset.chunk);
    try {
      if(name==="single" || name==="sequence") { setSplitMenuOpen(selector,false); setEnabled(name==="sequence"); }
      else if(name==="copy" || name==="copy-all") {
        const index=state.chunks.findIndex(c=>c.attention);
        if(name==="copy-all" && index>=0) { host.error(Object.assign(new Error(t("sequence.error.copy_attention",{index:index+1})),{severity:"warning"})); return; }
        await host.copy(name==="copy"?c.prompt:aggregate(state));
      }
      else if(!controller.busy) {
        if(name==="format-official" || name==="format-compact") { setSequenceFormat(state,name.slice(7));left.querySelector('[data-seq-instructions]').value=state.instructions;persist();render();fit(left.querySelector('[data-seq-instructions]'));return; }
        if(name==="reader") { setReader(!reader); return; }
        if(name==="instructions") { const panel=left.querySelector("[data-seq-instructions-panel]"); panel.hidden=!panel.hidden; el.setAttribute("aria-expanded",String(!panel.hidden)); el.classList.toggle("is-open",!panel.hidden); fit(left.querySelector("[data-seq-instructions]")); return; }
        if(name==="select-media") { selection=slotTarget(el.closest("[data-seq-slot]")); sync(); root.querySelector('[data-h3ps-media] .is-sequence-selectable')?.focus({preventScroll:true}); return; }
        if(name==="selection-cancel") { selection=null; sync(); return; }
        if(name==="copy-default" || name==="copy-custom") { state.copyFormat.format=name==="copy-custom"?"custom":"prompts"; persist(); sync(); fit(right.querySelector("[data-seq-copy-template]")); return; }
        if(["copy-reset","copy-divider","copy-times","copy-numbered","copy-chapters"].includes(name)) {
          state.copyFormat.template=name==="copy-chapters" ? "## {index} · {start}–{end}s\n\n{prompt}" : name==="copy-times" ? "[{start}-{end}s]\n{prompt}" : name==="copy-numbered" ? "{index}. {prompt}" : "{prompt}";
          state.copyFormat.separator=name==="copy-divider" ? "\n\n---\n\n" : name==="copy-reset" ? "" : "\n\n";
          right.querySelector("[data-seq-copy-template]").value=state.copyFormat.template;
          right.querySelector("[data-seq-copy-separator]").value=displaySeparator(state.copyFormat.separator);
          persist();sync();fit(right.querySelector("[data-seq-copy-template]"));return;
        }
        if(name==="insert-media") {
          const holder=el.closest("[data-slot-chunk]");
          insertInto(holder.dataset.asset,{chunk:holder.dataset.slotChunk,field:"prompt"},promptCarets.get(holder.dataset.slotChunk));return;
        }
        if(name==="remove-media") { const t=slotTarget(el.closest("[data-seq-slot]")); if(c) removeReference(state,c,t.previous); else if(t.key==="references") state.references=state.references.filter(x=>x!==t.previous); else state[t.key]=null; }
        else if(name==="add") addChunk(state);
        else if(name==="delete") deleteChunk(state,c.id);
        else if(name==="increase" || name==="decrease") c.duration=Math.max(1,Math.min(MAX_CHUNK_DURATION,c.duration+(name==="increase"?1:-1)));
        else if(name==="undo" || name==="redo") revisePrompt(c,name);
        else if(name==="reset") { state.instructions=sequenceInstructionDefault(state.outputFormat); left.querySelector("[data-seq-instructions]").value=state.instructions; fit(left.querySelector("[data-seq-instructions]")); }
        else if(name==="generate") { controller.start("generate",c.id); return; }
        else if(name==="refine-open" || name==="refine-close") { refineDrafts.set(c.id,{open:name==="refine-open"}); section.querySelector("[data-seq-refine]").hidden=name==="refine-close"; return; }
        else if(name==="refine") { controller.start("refine",c.id,section.querySelector("[data-seq-refine-instruction]").value); return; }
        changed();
      }
    } catch(error) { host.error(error); }
  }
  selector.querySelectorAll(":scope > button").forEach(b=>b.onclick=()=>setSplitMenuOpen(selector,selector.querySelector("[data-seq-menu]").hidden));
  root.addEventListener("click",event=>{ if(!selector.contains(event.target)) setSplitMenuOpen(selector,false); action(event); });
  right.addEventListener("input",event=>{
    if(controller.busy) return;
    if(event.target.matches("[data-seq-copy-template], [data-seq-copy-separator]")) {
      const template=event.target.matches("[data-seq-copy-template]");
      state.copyFormat[template?"template":"separator"]=template?event.target.value:parseSeparator(event.target.value);
      persist();sync();fit(right.querySelector("[data-seq-copy-template]"));return;
    }
    const c=state.chunks.find(c=>c.id===event.target.closest("[data-chunk]")?.dataset.chunk); if(!c) return;
    if(event.target.matches("[data-seq-prompt]")) { c.prompt=event.target.value; delete c.attention; controller.progress.delete(c.id); fit(event.target); persist(); render(); }
    if(event.target.matches("[data-seq-instruction]")) { c.instruction=event.target.value; persist(); }
  });
  left.addEventListener("input",event=>{
    if(controller.busy) return;
    const el=event.target;
    if(el.matches("[data-seq-brief]")) {state.brief=el.value;fit(el);}
    if(el.matches("[data-seq-instructions]")) { state.instructions=el.value; fit(el); }
    if(el.matches("[data-seq-default]")) state.defaultDuration=duration(el.value);
    persist(); sync();
  });
  root.addEventListener("click",event=>{
    if(!enabled) return;
    const el=event.target;
    if(selection && !controller.busy) {
      const card=el.closest('[data-h3ps-media] [data-asset-id]');
      if(card) { event.preventDefault(); event.stopImmediatePropagation(); assign(selection,card.dataset.assetId); return; }
      if(!el.closest('[data-h3ps-media]') && !el.closest('[data-seq-slot].is-selecting')) { selection=null; sync(); }
    }
    if(el.closest("[data-seq-generate]")) { event.stopImmediatePropagation(); controller.busy ? controller.cancel() : controller.start(primaryAction()); }
    if(el.closest("[data-workspace]")) setEnabled(false);
    if(el.closest("[data-clear-prompts], [data-clear-all]")) {
      event.stopImmediatePropagation(); if(controller.busy) return;
      state.brief=""; state.chunks.forEach(c=>{c.prompt="";delete c.attention;c.undo=[];c.redo=[];}); left.querySelector("[data-seq-brief]").value=""; changed();
      if(el.closest("[data-clear-all]")) host.clearMedia();
    }
    if(controller.busy && el.closest("[data-open-settings], [data-open-settings-header], .h3ps-generation-options, [data-model-picker]")) event.stopImmediatePropagation();
  },true);
  function rememberTarget(event) {
    if(!enabled || reader) return;
    const el=event.target, chunk=el.closest("[data-chunk]")?.dataset.chunk;
    if(el.matches("[data-seq-brief]")) activeTarget={field:"brief"};
    else if(chunk && el.matches("[data-seq-prompt],[data-seq-instruction],[data-seq-refine-instruction]")) {
      activeTarget={chunk,field:el.matches("[data-seq-prompt]")?"prompt":el.matches("[data-seq-instruction]")?"instruction":"refine-instruction"};
      if(activeTarget.field==="prompt") promptCarets.set(chunk,el.selectionStart);
    } else if(el.matches("textarea,input,[contenteditable=true]")) activeTarget=null;
  }
  for(const type of ["focusin","input","select","keyup","click"]) root.addEventListener(type,rememberTarget);
  root.addEventListener("pointerdown",event=>{if(event.target.closest('[data-seq-action="insert-media"]'))event.preventDefault();});
  function insertInto(assetId,target,caret) {
    if(!target) {host.error(new Error(t("sequence.error.cursor_first")));return;}
    if(target.field==="brief") {
      const tag=state.first===assetId?"first frame":state.last===assetId?"last frame":state.references.includes(assetId)?`reference ${state.references.indexOf(assetId)+1}`:null;
      if(!tag){host.error(new Error(t("sequence.error.media_not_in_sequence")));return;}
      host.insert(left.querySelector("[data-seq-brief]"),tag);return;
    }
    const c=state.chunks.find(c=>c.id===target.chunk), editor=chunks.get(target.chunk)?.querySelector(`[data-seq-${target.field}]`);
    if(!c || !editor?.isConnected || !root.contains(editor) || editor.closest("[hidden]")) {host.error(new Error(t("sequence.error.cursor_chunk")));return;}
    const item=effectiveMedia(state,c.id,host.assets()).find(m=>m.assetId===assetId);
    if(!item){host.error(new Error(t("sequence.error.media_not_in_chunk")));return;}
    if(Number.isInteger(caret))editor.setSelectionRange(caret,caret);
    host.insert(editor,item.tag);
  }
  root.addEventListener("keydown",event=>{
    if(enabled && event.key==="Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if(controller.busy) return;
      const section=event.target.closest("[data-chunk]");
      if(event.target.closest("[data-seq-refine]")) controller.start("refine",section.dataset.chunk,section.querySelector("[data-seq-refine-instruction]").value);
      else controller.start(primaryAction());
      return;
    }
    if(event.key==="Escape") {
      if(reader || selection || !selector.querySelector("[data-seq-menu]").hidden) { event.preventDefault(); event.stopImmediatePropagation(); setSplitMenuOpen(selector,false); selection=null; setReader(false); }
    } else if(selection && ["Enter"," "].includes(event.key) && event.target.matches('[data-asset-id]')) { event.preventDefault(); event.stopImmediatePropagation(); assign(selection,event.target.dataset.assetId); }
  },true);
  for(const type of ["dragover","drop"]) root.addEventListener(type,event=>{
    const slot=event.target.closest("[data-seq-slot]"); if(!enabled || !slot) return;
    event.preventDefault(); event.stopImmediatePropagation(); if(controller.busy) return;
    if(type==="dragover") event.dataTransfer.dropEffect="move";
    else { const id=event.dataTransfer.getData("application/x-h3ps-asset"); if(id) assign(slotTarget(slot),id); }
  },true);
  // Resize only measures existing editors; it never reconstructs the document.
  if(typeof ResizeObserver!=="undefined") { const observer=new ResizeObserver(()=>{if(enabled && !reader) right.querySelectorAll("[data-seq-prompt]").forEach(fit);}); observer.observe(right); }
  render();
  return { get active(){return enabled;}, get reader(){return reader;}, state, controller, setActive:setEnabled,
    loadDraft(value){
      if(controller.busy) return;
      Object.assign(state,value); aspectControl.update(state.aspectRatio); refineDrafts.clear(); selection=null; activeTarget=null;
      left.querySelector("[data-seq-brief]").value=state.brief;
      left.querySelector("[data-seq-instructions]").value=state.instructions;
      left.querySelector("[data-seq-default]").value=state.defaultDuration;
      right.querySelector("[data-seq-copy-template]").value=state.copyFormat.template;
      right.querySelector("[data-seq-copy-separator]").value=displaySeparator(state.copyFormat.separator);
      setReader(false); persist(); setEnabled(true); render();
    },
    mediaMode:mode=>enabled?"Reference":mode,
    refresh(){ if(enabled && !controller.busy && reconcileMedia(state,host.assets())) persist(); render(); },
    leave(){controller.leave();selection=null;setReader(false);highlights.clear();},
    insert(assetId){
      if(!enabled) return false;
      if(controller.busy || reader || selection) return true;
      insertInto(assetId,activeTarget);
      return true;
    },
  };
}
