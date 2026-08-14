import { app } from "/scripts/app.js";
import { cancel, clearMedia, diagnoseGGUFRuntime, disconnectApiProvider, freeComfyVram, generate, getApiProviderModels, getApiProviderPresets, getGuides, getModels, getOllamaStatus, getStatus, getSystemPrompt, probeApiProvider, probeExternalServer, refine, removeMedia, reorderMedia, resampleMedia, unloadModel, uploadMedia } from "./api/h3studio.js";
import { availableReferenceTags, createSessionId, insertReferenceAtCaret, isChoiceMenuInteraction, isGuideMenuInteraction, isRuntimeMenuInteraction, moveOntoTarget, replaceEventListener } from "./compat.js";
import { generateModelSummaryMarkup, settingsMarkup } from "./settings.js";
import {
  buildGeneratePayload,
  buildRefinePayload,
  audioWasAdded,
  createStudioState,
  isPersistedDraftMode,
  saveApiProviderConfig,
  saveCustomSystemPrompts,
  saveExternalServerConfig,
  saveOllamaModel,
  saveModeDrafts,
  saveUserPreferences,
  restoredModelAfterDiscovery,
  selectModelState,
} from "./studio_state.js";

const EXTENSION_NAME = "minimax.h3.prompt.studio";
const INSTALLATION_GUIDE_URL = "https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/blob/main/docs/INSTALLATION.md";
const TROUBLESHOOTING_GUIDE_URL = "https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/blob/main/docs/TROUBLESHOOTING.md";
const MUSIC3_GUIDE_URL = "https://github.com/MiniMax-AI/MiniMax-Music3/tree/main/skills/music-caption-rewriter";
const ASPECT_RATIOS = [
  ["1:1", "Square"], ["2:3", "Portrait"], ["3:2", "Landscape"], ["3:4", "Portrait"],
  ["4:3", "Landscape"], ["9:16", "Vertical"], ["16:9", "Widescreen"], ["21:9", "Ultrawide"],
];
const MODES = {
  T2VA: {
    title: "Text to video",
    hint: "Describe the scene. No reference media is required.",
    assets: [],
  },
  I2VA: {
    title: "Image to video",
    hint: "The opening image anchors subject, framing and visual style.",
    assets: [],
    limit: 1,
  },
  FL2VA: {
    title: "First & last frame",
    hint: "Define the visual transition between the opening and closing frames.",
    assets: [],
    limit: 2,
  },
  L2VA: {
    title: "Last frame",
    hint: "The final image defines where the generated shot must arrive.",
    assets: [],
    limit: 1,
  },
  Reference: {
    title: "Images, video & audio",
    tabTitle: "",
    hint: "Add up to 9 images, 3 videos and 3 audio files.",
    assets: [],
  },
};

const MODE_DEFAULT_DRAFTS = {
  T2VA: {
    brief: "At blue hour, a bicycle courier arrives at a quiet rooftop greenhouse, sets down a softly glowing parcel and watches the city lights switch on below. Use one continuous tracking shot, realistic motion and restrained sound.",
    prompt: `integrated_multimodal_description: [Shot 1] Live-action, cinematic, a wide tracking shot follows a bicycle courier across a rain-dark rooftop toward a glass greenhouse at blue hour. The courier brakes beside the doorway, steps down and places a softly glowing parcel on a wooden bench. The camera arcs with small amplitude at slow speed as the courier turns toward the skyline and rows of city lights switch on across the distance. Reflections travel over the greenhouse glass while the courier remains still beside the parcel.

overall_soundscape: Bicycle tires hiss across wet concrete, the chain clicks as the rider stops, and low rooftop wind moves through the greenhouse frame. Distant traffic continues below.

non_diegetic_music: Sparse electronic pulses at a slow tempo with a low sustained synth tone, fading during the final skyline view.`,
  },
  I2VA: {
    brief: "Preserve the person, wardrobe, setting and framing from the uploaded first frame. A small paper bird drifts into view; the person notices it, follows it with their eyes and slowly reaches toward it while the camera gently pushes in.",
    prompt: `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, the person shown in <Picture 1> remains in the same setting, preserving identity, wardrobe, lighting, spatial relationships and opening composition. A small folded paper bird drifts into the frame on a light current of air. The subject notices it, follows its path with their eyes and slowly raises one hand as the camera pushes in with small amplitude at slow speed. The paper bird settles just above the open palm while the original background remains stable.

overall_soundscape: Soft room ambience continues beneath a faint rustle of paper and fabric movement.

non_diegetic_music: A restrained pattern of widely spaced piano notes, ending on a sustained note as the paper bird reaches the hand.`,
  },
  FL2VA: {
    brief: "Create one continuous, physically believable transition from the uploaded opening frame to the uploaded ending frame. A cyclist releases the handlebar, raises and opens an umbrella, then settles precisely into the final pose and composition.",
    prompt: `How the reference pictures align with the target video: Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the final moment of the target video.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, the cyclist begins in the identity, clothing, pose, setting and framing established by <Picture 1>, holding a closed umbrella beside the bicycle. The camera pulls out with small amplitude at slow speed as the cyclist releases the handlebar, raises the umbrella and presses the runner upward until the canopy opens. Water rolls from the expanding fabric while the cyclist steps beneath it, rotates the handle and gradually settles into the exact pose, spacing, object positions, camera angle and final composition established by <Picture 2>.

overall_soundscape: Steady rain falls on the pavement, followed by the metallic click of the umbrella runner and the soft snap of the canopy opening. Water drips from the bicycle as distant traffic passes.

non_diegetic_music: N/A`,
  },
  L2VA: {
    brief: "Build a plausible action that lands exactly on the uploaded final frame. Begin with an intact ceramic cup near the table edge; a hand knocks it down, it breaks on the floor, and every fragment settles into the final arrangement.",
    prompt: `How the reference picture aligns with the target video: <Picture 1> (from [Shot 1]) aligns with the final moment of the target video.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, a close shot begins with an intact ceramic cup near the edge of a dark wooden table. The same hand and sleeve visible in <Picture 1> approach from the right. The camera pushes in with small amplitude at slow speed as the fingertips strike the cup. It tips, falls and breaks against the floor; fragments slide outward and gradually lose momentum. The hand lowers into view while every piece settles into the exact arrangement, lighting, focus, camera angle and final composition established by <Picture 1>.

overall_soundscape: Fingertips tap the ceramic before it scrapes across the tabletop, falls and breaks with a sharp impact. Small fragments scatter and then stop sliding across the floor.

non_diegetic_music: A low electronic pulse at a slow tempo stops immediately when the cup breaks.`,
  },
};
const REFERENCE_DEFAULT_BRIEF = "Use identity and wardrobe from Picture 1 and the slow lateral camera movement from Video 1. A solitary character waits at a rain-soaked tram stop at blue hour, notices an approaching light and turns into the wind. End on a quiet, unresolved look; keep the shot cinematic, realistic and restrained.";
const MUSIC3_DEFAULT_DRAFT = {
  brief: "A reflective indie pop song that grows from close, fragile verses into a bright final chorus. Use warm piano, clean electric guitar, restrained drums, subtle analog texture, an intimate lead vocal and natural modern production.",
  lyrics: `[Verse]
Streetlights soften before dawn
I breathe in and carry on

[Chorus]
A quiet spark becomes a flame
I step ahead and speak my name`,
  prompt: `### Global Metadata

A reflective indie pop song at a steady mid-tempo pace, moving from tender uncertainty toward clear-eyed optimism. The production is modern and natural, led by warm piano, clean electric guitar, restrained live-feeling drums, rounded bass, and subtle analog texture. Dynamics should remain open and human rather than heavily compressed, with the final chorus providing the widest and brightest moment.

### Vocal Details

An intimate lead vocal begins close and lightly breathy in the verses, with precise phrasing and a vulnerable tone. The delivery gains confidence as the song develops without becoming theatrical. Soft doubles may reinforce selected phrases, while compact harmony layers open around the chorus and expand modestly in the final repeat. Reverb stays warm and controlled so the words remain present.

### Arrangement

[Intro] Warm piano establishes the harmony alone before a faint analog pad and clean guitar harmonics enter at the edges.

[Verse] The lead vocal arrives over piano and sparse guitar arpeggios. Bass enters gradually, while percussion is limited to quiet pulse and texture.

[Chorus] Restrained drums settle into a complete groove as bass, wider guitar voicings, and vocal harmonies lift the arrangement. The transition should feel earned rather than abrupt.

[Final Chorus] The same core palette reaches its fullest scale with brighter piano octaves, broader harmonies, and a subtle sustained texture behind the band. End by letting the drums and bass fall away, leaving the opening piano color to resolve naturally.`,
};

const SAMPLE_PROMPT = `subject_definitions:
<Subject 1> is the coffee shop in <Picture 1>, with a brick wall, orange sofa, neon sign, and wooden table.
<Subject 2> is the white Samoyed in <Picture 2> and <Picture 3>, with pointed ears and a curved tail.
<Subject 3> is the blonde woman in <Video 1>, wearing a pink shirt.
<Subject 4> is the brown-haired man in a grey hoodie from <Video 2>.
<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing a spoken English vocal layer.

summary:
[reference generation + audio reference] In a three-shot sitcom scene, <Subject 3> eats a cookie inside <Subject 1>. <Subject 4> enters with <Subject 2>, which lunges toward the cookie. <Audio 1> guides <Subject 3>'s voice timbre, and a canned audience laugh ends the exchange.

retention_analysis:
<Subject 1> (appears in all shots): fully_preserved - its layout and key furniture are retained.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - its white fur and silhouette are retained.
<Subject 3> (appears in all shots): fully_preserved - her identity and wardrobe are retained.
<Subject 4> (appears in [Shot 1], [Shot 2]): fully_preserved - his identity and wardrobe are retained.
<Audio 1>: reference - its vocal timbre guides <Subject 3> without copying the signal.

detailed_description:
The target video uses a realistic multi-camera sitcom style with warm indoor lighting.
[Shot 1] A medium shot establishes <Subject 1>. <Subject 3> (S1) sits on the sofa holding a cookie. <Subject 4> enters holding <Subject 2>'s leash. The Samoyed lunges toward the cookie. <Subject 3> jerks it back and, using the voice timbre from <Audio 1>, exclaims, <d>[English] Hey! Watch your dog!</d> She guards the cookie while <Subject 4> pulls the dog back.
[Shot 2] At 00:03.000, cut to <Subject 4> (S2) holding <Subject 2> securely. In a playful tone he says, <d>[English] He just likes cookies more than me.</d> He smiles apologetically and strokes the dog's fur.
[Shot 3] At 00:05.000, cut to <Subject 3> (S1). Her annoyance softens. Using <Audio 1>'s timbre, she replies, <d>[English] Well, he has good taste at least.</d> She raises the cookie as a canned audience laugh continues to the final frame.

overall_soundscape:
Soft indoor coffee-shop room tone continues throughout the scene.

non_diegetic_music:
N/A`;

let studio;
let ggufRuntimeDiagnosticsPromise = null;
let referenceInsertTarget = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function countWords(value) {
  return String(value).trim().match(/\S+/gu)?.length || 0;
}

function promptLengthMeta(value) {
  return `${value.length.toLocaleString()} characters · ${countWords(value).toLocaleString()} words`;
}

function formatGenerationMeta(result) {
  const peakVram = result.peak_vram_mb ? ` · ${(result.peak_vram_mb / 1024).toFixed(1)} GB peak` : "";
  const load = Number(result.model_load_seconds || 0).toFixed(1);
  const media = Number(result.media_processing_seconds || 0).toFixed(1);
  const llm = Number(result.generation_seconds || 0).toFixed(1);
  const fallback = result.thinking_fallback ? " · Thinking fallback" : "";
  const memory = result.context_tokens ? ` · ${Math.round(result.context_tokens / 1024)}K/${String(result.kv_cache).toUpperCase()}` : "";
  const timing = result.api_provider
    ? `${result.total_seconds.toFixed(1)}s total (${media}s media · ${llm}s provider)`
    : result.external_server
    ? `${result.total_seconds.toFixed(1)}s total (${media}s media · ${llm}s server)`
    : `${result.total_seconds.toFixed(1)}s total (${load}s load · ${media}s media · ${llm}s LLM)`;
  const speed = Number.isFinite(result.tokens_per_second) ? ` · ${result.tokens_per_second.toFixed(1)} tok/s` : "";
  const apiRequests = result.api_provider ? ` · ${result.provider_request_count || 1} API request${result.provider_request_count === 1 ? "" : "s"}` : "";
  const cost = Number.isFinite(result.provider_cost_usd) ? ` · $${result.provider_cost_usd.toFixed(4)} reported` : "";
  const usage = result.api_provider && result.usage_source ? ` · usage ${result.usage_source}` : "";
  return `${promptLengthMeta(result.prompt)} · ${timing}${speed}${apiRequests}${cost}${usage}${peakVram}${memory}${fallback}`;
}

function syncOutputLengthMeta() {
  if (!studio) return;
  const output = studio.root.querySelector("[data-output]");
  const meta = studio.root.querySelector(".h3ps-editor-meta span:last-child");
  const suffix = meta.textContent.replace(/^[\d,.]+ (?:chars|characters)(?: · [\d,.]+ words)?(?: · )?/i, "");
  meta.textContent = `${promptLengthMeta(output.value)}${suffix ? ` · ${suffix}` : ""}`;
}

function newGenerationSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}

function resizeSystemPromptEditor(textarea) {
  if (!textarea) return;
  textarea.style.height = "";
  textarea.style.overflowY = "auto";
}

async function syncSystemPromptEditor(profile) {
  if (!studio) return;
  const textarea = studio.root.querySelector(`[data-system-prompt="${profile}"]`);
  if (!textarea) return;
  const status = studio.root.querySelector(`[data-system-prompt-status="${profile}"]`);
  const summaryStatus = studio.root.querySelector(`[data-system-prompt-summary-status="${profile}"]`);
  const reset = studio.root.querySelector(`[data-system-prompt-reset="${profile}"]`);
  const count = studio.root.querySelector(`[data-system-prompt-count="${profile}"]`);
  const requestMode = profile === "music3" ? "Music3" : profile === "reference" ? "Reference" : "T2VA";
  textarea.disabled = true;
  if (!studio.systemPromptDefaults[profile]) {
    try {
      const result = await getSystemPrompt(requestMode);
      studio.systemPromptDefaults[result.profile] = result.system_prompt;
    } catch (error) {
      textarea.value = "";
      if (status) status.textContent = "Unavailable";
      if (summaryStatus) summaryStatus.textContent = "Unavailable";
      showToast(error.code || "System Prompt unavailable", error.message, error.details);
      return;
    }
  }
  const custom = Object.hasOwn(studio.customSystemPrompts, profile);
  textarea.value = custom ? studio.customSystemPrompts[profile] : studio.systemPromptDefaults[profile];
  textarea.disabled = false;
  if (status) status.textContent = custom ? "Custom" : "Default";
  if (summaryStatus) summaryStatus.textContent = custom ? "Custom" : "Default";
  reset.hidden = !custom;
  count.textContent = `${textarea.value.length.toLocaleString()} / 8,000`;
  resizeSystemPromptEditor(textarea);
}

function syncSystemPromptEditors() {
  return Promise.all([syncSystemPromptEditor("standard"), syncSystemPromptEditor("reference"), syncSystemPromptEditor("music3")]);
}

function setSystemPromptProfile(profile) {
  if (!studio) return;
  studio.settingsPromptProfile = profile === "reference" ? "reference" : "standard";
  studio.root.querySelectorAll("[data-system-prompt-profile]").forEach((button) => {
    const selected = button.dataset.systemPromptProfile === studio.settingsPromptProfile;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  studio.root.querySelectorAll("[data-system-prompt-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.systemPromptPanel !== studio.settingsPromptProfile;
  });
  syncSystemPromptEditor(studio.settingsPromptProfile);
}

function setSystemPromptEditorOpen(open) {
  if (!studio) return;
  studio.root.querySelector("[data-system-prompt-overview]").hidden = open;
  studio.root.querySelector("[data-system-prompt-editor]").hidden = !open;
}

function renderPromptHighlights() {
  if (!studio) return;
  const editor = studio.root.querySelector("[data-output]");
  const layer = studio.root.querySelector("[data-prompt-highlights]");
  if (!editor || !layer) return;
  const tokens = /(?<dialogue>&lt;d&gt;[\s\S]*?&lt;\/d&gt;)|(?<media>@(?:Image|Video|Audio)\d+|&lt;(?:Picture|Video|Audio)\s+\d+&gt;)|(?<subject>&lt;Subject\s+\d+&gt;)|(?<section>^(?:(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):|###\s+(?:Global Metadata|Vocal Details|Arrangement)\s*$))|(?<shot>\[(?:Shot\s+\d+|Intro|Verse(?:\s+\d+)?|Pre-Chorus|Chorus(?:\s+\d+)?|Bridge|Instrumental|Final Chorus|Outro)\])|(?<time>\b(?:\d{1,2}:\d{2}(?:\.\d{1,3})?|\d+(?:\.\d+)?\s+seconds?)\b)/gim;
  layer.innerHTML = escapeHtml(editor.value).replace(tokens, (match, ...args) => {
    const groups = args.at(-1);
    if (groups.media) {
      const parsed = match.match(/@(?<legacy>Image|Video|Audio)(?<legacyNumber>\d+)|&lt;(?<official>Picture|Video|Audio)\s+(?<officialNumber>\d+)&gt;/)?.groups || {};
      const type = parsed.official || (parsed.legacy === "Image" ? "Picture" : parsed.legacy);
      const number = parsed.officialNumber || parsed.legacyNumber;
      const mediaClass = type === "Picture" ? "image" : type.toLowerCase();
      return `<mark class="is-${mediaClass}" data-prompt-reference="<${type} ${number}>">${match}</mark>`;
    }
    const kind = groups.subject ? "subject" : groups.section ? "section" : groups.shot ? "shot" : groups.time ? "time" : "dialogue";
    return `<mark class="is-${kind}">${match}</mark>`;
  }) + "\n";
  layer.scrollTop = editor.scrollTop;
  layer.scrollLeft = editor.scrollLeft;
}

function syncModifiedState() {
  if (!studio) return;
  const output = studio.root.querySelector("[data-output]");
  const hasBaseline = typeof studio.lastModelPrompt === "string";
  const modified = hasBaseline ? output.value !== studio.lastModelPrompt : true;
  studio.outputModified = modified;
  studio.root.querySelector("[data-undo-edits]").hidden = !modified || !hasBaseline;
}

function injectStyles() {
  if (!document.querySelector("link[data-h3ps-styles]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./styles.css", import.meta.url).href;
    link.dataset.h3psStyles = "true";
    document.head.appendChild(link);
  }
  if (!document.querySelector("link[data-h3ps-skin]")) {
    const skin = document.createElement("link");
    skin.rel = "stylesheet";
    skin.href = new URL("./skin.css", import.meta.url).href;
    skin.dataset.h3psSkin = "true";
    document.head.appendChild(skin);
  }
}

function icon(name, size = 16) {
  const paths = {
    spark: '<path d="M12 2l1.25 3.75L17 7l-3.75 1.25L12 12l-1.25-3.75L7 7l3.75-1.25L12 2Z"/><path d="M5 12l.8 2.2L8 15l-2.2.8L5 18l-.8-2.2L2 15l2.2-.8L5 12Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 15-4-4L5 20"/>',
    video: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2v-4Z"/>',
    audio: '<path d="M4 12h2m2-4v8m4-12v16m4-13v10m4-7v4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    play: '<path d="m9 7 8 5-8 5V7Z" fill="currentColor" stroke="none"/>',
    dots: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.35 5.65L20 14"/><path d="M20 7v4h-4"/>',
    memory: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}

function renderAsset(asset, index) {
  const destructiveDisabled = studio.requestBusy ? "disabled" : "";
  const draggable = studio.requestBusy ? "false" : "true";
  const visual = asset.type === "audio"
    ? `<div class="h3ps-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>`
    : asset.preview_url
      ? `<span class="h3ps-thumb-backdrop" style="background-image:url('${asset.preview_url}')"></span><img class="h3ps-real-thumb" src="${asset.preview_url}" alt="">`
      : `<div class="h3ps-thumb-art h3ps-tone-${asset.tone || "blue"}"><span></span></div>`;
  const overlay = asset.type === "video" ? `<span class="h3ps-play">${icon("play", 18)}</span>` : "";
  const duration = formatDuration(asset.duration);
  return `
    <div class="h3ps-asset" draggable="${draggable}" data-asset-index="${index}" data-asset-id="${asset.id}">
      <span class="h3ps-asset-preview h3ps-${asset.type}">${visual}${overlay}</span>
      <span class="h3ps-asset-copy">
        <strong>${escapeHtml(asset.reference)}</strong>
        <small>${escapeHtml(asset.filename)}</small>
      </span>
      ${duration ? `<span class="h3ps-duration">${duration}</span>` : ""}
      <button class="h3ps-more" type="button" data-asset-menu-toggle="${asset.id}" title="Asset actions">${icon("dots", 16)}</button>
      <div class="h3ps-asset-menu" data-asset-menu="${asset.id}" hidden>
        <button type="button" data-preview-asset="${asset.id}">Preview</button>
        ${asset.mode !== "Reference" ? `<button type="button" data-replace-asset="${asset.id}" ${destructiveDisabled}>Replace image</button>` : ""}
        <button type="button" data-remove-asset="${asset.id}" ${destructiveDisabled}>Remove</button>
      </div>
    </div>`;
}

function renderMedia(mode) {
  if (mode === "Music3") {
    studio.root.querySelectorAll("[data-mode]").forEach((button) => button.classList.remove("is-active"));
    return;
  }
  const data = MODES[mode];
  const assets = studio.assets.filter((asset) => asset.mode === mode);
  const media = studio.root.querySelector("[data-h3ps-media]");
  studio.root.querySelector("[data-h3ps-mode-title]").textContent = data.title;
  studio.root.querySelector("[data-h3ps-mode-hint]").textContent = data.hint;
  studio.root.querySelectorAll("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });

  if (mode === "T2VA") {
    media.innerHTML = `
      <div class="h3ps-empty-drop is-static">
        <span class="h3ps-empty-icon">${icon("spark", 20)}</span>
        <strong>Start from a text description</strong>
        <small>T2VA does not use reference media</small>
      </div>`;
  } else {
    const isReference = mode === "Reference";
    const filter = isReference ? studio.mediaFilter : "all";
    const visibleAssets = filter === "all" ? assets : assets.filter((asset) => asset.type === filter);
    const counts = assets.reduce((result, asset) => ({ ...result, [asset.type]: (result[asset.type] || 0) + 1 }), {});
    const filters = isReference ? `
      <div class="h3ps-media-filters" aria-label="Reference type">
        <button type="button" data-media-filter="all" class="${filter === "all" ? "is-active" : ""}">All <b>${assets.length}/12</b></button>
        <button type="button" data-media-filter="image" class="${filter === "image" ? "is-active" : ""}">${icon("image", 13)} Images <b>${counts.image || 0}/9</b></button>
        <button type="button" data-media-filter="video" class="${filter === "video" ? "is-active" : ""}">${icon("video", 13)} Video <b>${counts.video || 0}/3</b></button>
        <button type="button" data-media-filter="audio" class="${filter === "audio" ? "is-active" : ""}">${icon("audio", 13)} Audio <b>${counts.audio || 0}/3</b></button>
      </div>` : "";
    const addLabel = !isReference || filter === "image" ? "Add image" : filter === "video" ? "Add video" : filter === "audio" ? "Add audio" : "Add media";
    const canAdd = isReference || assets.length < data.limit;
    media.innerHTML = `
      ${filters}
      <div class="h3ps-assets ${isReference ? "is-reference" : ""}">${visibleAssets.map((asset) => renderAsset(asset, assets.indexOf(asset))).join("")}
        ${canAdd ? `<button class="${assets.length ? "h3ps-add-asset" : "h3ps-empty-drop"}" type="button" data-add-media ${studio.requestBusy ? "disabled" : ""}>${icon("plus", 18)}<span>${addLabel}</span><small>Drop files here</small></button>` : ""}
      </div>`;
  }
  bindMediaActions(mode);
  syncReferenceInsertControl();
}

function referenceTagKind(reference) {
  const type = reference.match(/^<(Subject|Picture|Video|Audio) /)?.[1] || "Subject";
  return type === "Picture" ? "image" : type.toLowerCase();
}

function referenceTagsForCurrentDraft() {
  if (!studio || studio.mode !== "Reference") return [];
  return availableReferenceTags(studio.assets, studio.root.querySelector("[data-output]").value);
}

function closeReferenceInsert() {
  if (!studio) return;
  const popover = studio.root.querySelector("[data-reference-insert-popover]");
  const toggle = studio.root.querySelector("[data-reference-insert-toggle]");
  if (popover) popover.hidden = true;
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function syncReferenceInsertControl() {
  if (!studio) return;
  const control = studio.root.querySelector("[data-reference-insert]");
  const toggle = studio.root.querySelector("[data-reference-insert-toggle]");
  if (!control || !toggle) return;
  const referenceMode = studio.mode === "Reference";
  const tags = referenceMode ? referenceTagsForCurrentDraft() : [];
  control.hidden = !referenceMode;
  toggle.disabled = !tags.length || studio.requestBusy;
  toggle.title = tags.length ? "Insert reference" : "Add reference media first";
  if (!referenceMode || !tags.length) closeReferenceInsert();
}

function rememberReferenceInsertTarget(editor) {
  if (studio?.mode !== "Reference" || !editor) return;
  referenceInsertTarget = { editor, caret: editor.selectionStart ?? editor.value.length };
}

function toggleReferenceInsert() {
  const popover = studio.root.querySelector("[data-reference-insert-popover]");
  const toggle = studio.root.querySelector("[data-reference-insert-toggle]");
  const opening = popover.hidden;
  if (!opening) {
    closeReferenceInsert();
    return;
  }
  const tags = referenceTagsForCurrentDraft();
  if (!tags.length) return;
  popover.innerHTML = tags.map((reference) => `<button type="button" class="h3ps-reference-chip is-${referenceTagKind(reference)}" data-insert-reference="${escapeHtml(reference)}" role="menuitem">${escapeHtml(reference)}</button>`).join("");
  popover.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
}

function insertSelectedReference(reference) {
  if (studio.mode !== "Reference") return;
  const fallback = studio.root.querySelector("[data-output]");
  const target = referenceInsertTarget?.editor?.isConnected ? referenceInsertTarget : { editor: fallback, caret: fallback.selectionStart };
  target.editor.setSelectionRange(target.caret, target.caret);
  if (insertReferenceAtCaret(target.editor, reference, target.caret)) {
    rememberReferenceInsertTarget(target.editor);
    syncReferenceInsertControl();
  }
  closeReferenceInsert();
}

function bindMediaActions(mode) {
  const media = studio.root.querySelector("[data-h3ps-media]");
  studio.root.querySelectorAll("[data-media-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      studio.mediaFilter = button.dataset.mediaFilter;
      renderMedia(mode);
    });
  });
  studio.root.querySelectorAll("[data-asset-index]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.target.closest("button, .h3ps-asset-menu")) return;
      const asset = studio.assets.find((item) => item.id === button.dataset.assetId);
      previewAsset(asset);
    });
  });
  studio.root.querySelectorAll("[data-asset-menu-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = studio.root.querySelector(`[data-asset-menu="${button.dataset.assetMenuToggle}"]`);
      const open = menu.hidden;
      studio.root.querySelectorAll("[data-asset-menu]").forEach((item) => { item.hidden = true; });
      menu.hidden = !open;
    });
  });
  studio.root.querySelectorAll("[data-preview-asset]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      previewAsset(studio.assets.find((item) => item.id === button.dataset.previewAsset));
    });
  });
  studio.root.querySelectorAll("[data-replace-asset]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      chooseMedia(mode, button.dataset.replaceAsset);
    });
  });
  studio.root.querySelectorAll("[data-remove-asset]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        const result = await removeMedia(studio.sessionId, button.dataset.removeAsset);
        studio.assets = result.assets;
        renderMedia(mode);
      } catch (error) {
        showToast(error.code || "Remove failed", error.message, error.details);
      }
    });
  });
  studio.root.querySelectorAll("[data-add-media]").forEach((button) => {
    button.addEventListener("click", () => chooseMedia(mode));
  });
  studio.root.querySelectorAll("[data-asset-id]").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      if (studio.requestBusy) {
        event.preventDefault();
        return;
      }
      studio.draggedAssetId = card.dataset.assetId;
      media.classList.add("is-reordering");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-h3ps-asset", card.dataset.assetId);
      const asset = studio.assets.find((item) => item.id === card.dataset.assetId);
      const ghost = document.createElement("div");
      ghost.className = "h3ps-drag-ghost";
      ghost.innerHTML = `${asset?.preview_url ? `<img src="${asset.preview_url}" alt="">` : ""}<span><strong>${escapeHtml(asset?.reference || "Media")}</strong><small>Move reference</small></span>`;
      document.body.appendChild(ghost);
      studio.dragGhost = ghost;
      event.dataTransfer.setDragImage(ghost, 24, 20);
      requestAnimationFrame(() => card.classList.add("is-dragging"));
    });
    card.addEventListener("dragend", () => {
      studio.draggedAssetId = null;
      media.classList.remove("is-reordering");
      studio.dragGhost?.remove();
      studio.dragGhost = null;
      studio.root.querySelectorAll(".is-dragging, .is-drop-before, .is-drop-after").forEach((item) => item.classList.remove("is-dragging", "is-drop-before", "is-drop-after"));
    });
    card.addEventListener("dragover", (event) => {
      if (!studio.draggedAssetId || studio.draggedAssetId === card.dataset.assetId) return;
      studio.root.querySelectorAll(".is-drop-before, .is-drop-after").forEach((item) => item.classList.remove("is-drop-before", "is-drop-after"));
      const modeAssets = studio.assets.filter((asset) => asset.mode === mode);
      const sourceIndex = modeAssets.findIndex((asset) => asset.id === studio.draggedAssetId);
      const targetIndex = modeAssets.findIndex((asset) => asset.id === card.dataset.assetId);
      const after = sourceIndex < targetIndex;
      card.classList.add(after ? "is-drop-after" : "is-drop-before");
    });
  });
  replaceEventListener(media, "dragover", "media", (event) => {
    event.preventDefault();
    if (studio.draggedAssetId) event.dataTransfer.dropEffect = "move";
  });
  replaceEventListener(media, "drop", "media", async (event) => {
    event.preventDefault();
    if (studio.requestBusy) return;
    const sourceId = event.dataTransfer.getData("application/x-h3ps-asset") || studio.draggedAssetId;
    const targetId = event.target.closest("[data-asset-id]")?.dataset.assetId;
    if (sourceId) {
      if (!targetId || sourceId === targetId) return;
      const modeAssets = studio.assets.filter((asset) => asset.mode === mode);
      const reorderedAssets = moveOntoTarget(modeAssets, sourceId, targetId);
      try {
        const result = await reorderMedia(studio.sessionId, mode, reorderedAssets.map((asset) => asset.id));
        studio.assets = result.assets;
        renderMedia(mode);
      } catch (error) {
        showToast(error.code || "Reorder failed", error.message, error.details);
      }
      return;
    }
    uploadFiles(mode, [...event.dataTransfer.files]);
  });
}

function previewAsset(asset) {
  if (!asset) return;
  if (asset.type === "video") openVideoPreview(asset);
  else if (asset.type === "image") openImagePreview(asset);
  else showToast(asset.reference, `${formatDuration(asset.duration)} audio reference loaded.`);
}

function chooseMedia(mode, replaceAssetId = null) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = mode === "Reference" || mode === "FL2VA";
  input.accept = mode === "Reference" ? "image/*,video/*,audio/*" : "image/*";
  input.addEventListener("change", () => uploadFiles(mode, [...input.files], replaceAssetId));
  input.click();
}

async function uploadFiles(mode, files, replaceAssetId = null) {
  if (!files.length || studio.requestBusy) return;
  const existing = studio.assets.filter((asset) => asset.mode === mode);
  if (mode !== "Reference" && !replaceAssetId && existing.length + files.length > MODES[mode].limit) {
    showToast("Reference slot is full", "Use Replace on the existing image.");
    return;
  }
  showToast("Processing media", "Creating previews and the ordered contact sheet…");
  const previousAssets = [...studio.assets];
  try {
    const result = await uploadMedia(studio.sessionId, mode, files, replaceAssetId);
    studio.sessionId = result.session_id;
    studio.assets = replaceAssetId ? result.assets : [...studio.assets, ...result.assets];
    renderMedia(mode);
    hideToast();
    if (audioWasAdded(previousAssets, studio.assets)) {
      showToast(
        "Audio added",
        "The prompt model can't hear audio files. Describe how the audio references should be used in the Creative Brief.",
        null,
        null,
        { durationMs: 6000 },
      );
    }
  } catch (error) {
    renderMedia(mode);
    showToast(error.code || "Upload failed", error.message, error.details);
  }
}

function openVideoPreview(asset) {
  const preview = studio.root.querySelector("[data-h3ps-preview]");
  studio.previewAssetId = asset.id;
  preview.querySelector("[data-preview-name]").textContent = asset.filename;
  const video = preview.querySelector("[data-preview-video]");
  video.src = asset.content_url;
  preview.querySelector("[data-preview-sheet]").src = asset.contact_sheet_url || "";
  preview.querySelectorAll("[data-frame-count]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.frameCount === (asset.frame_count_mode || "auto"));
  });
  preview.querySelector("[data-include-endpoints]").checked = asset.include_endpoints !== false;
  preview.querySelector("[data-preview-sampling]").textContent = `One sheet · ${asset.frames.length} frames · read left to right`;
  preview.classList.add("is-open");
  preview.classList.remove("is-updating");
  preview.setAttribute("aria-hidden", "false");
}

function closeVideoPreview() {
  const preview = studio.root.querySelector("[data-h3ps-preview]");
  preview.classList.remove("is-open");
  preview.setAttribute("aria-hidden", "true");
  preview.querySelector("[data-preview-video]").pause();
}

function openImagePreview(asset) {
  const preview = studio.root.querySelector("[data-h3ps-image-preview]");
  preview.querySelector("[data-image-preview-reference]").textContent = asset.reference || "Picture reference";
  preview.querySelector("[data-image-preview-name]").textContent = asset.filename;
  const image = preview.querySelector("[data-image-preview-image]");
  const dialog = preview.querySelector(".h3ps-image-preview-dialog");
  image.onload = () => {
    const aspect = image.naturalWidth / image.naturalHeight || 1;
    const maxStageWidth = Math.max(260, Math.min(1200, window.innerWidth - 88));
    const maxStageHeight = Math.max(260, Math.min(900, window.innerHeight - 146));
    let stageWidth = maxStageWidth;
    let stageHeight = stageWidth / aspect;
    if (stageHeight > maxStageHeight) {
      stageHeight = maxStageHeight;
      stageWidth = stageHeight * aspect;
    }
    dialog.style.setProperty("--h3ps-image-preview-width", `${Math.round(stageWidth + 28)}px`);
    dialog.style.setProperty("--h3ps-image-preview-height", `${Math.round(stageHeight + 86)}px`);
  };
  image.alt = asset.filename;
  image.src = asset.content_url || asset.preview_url;
  preview.classList.add("is-open");
  preview.setAttribute("aria-hidden", "false");
}

function closeImagePreview() {
  const preview = studio.root.querySelector("[data-h3ps-image-preview]");
  preview.classList.remove("is-open");
  preview.setAttribute("aria-hidden", "true");
  const image = preview.querySelector("[data-image-preview-image]");
  image.onload = null;
  image.removeAttribute("src");
}

function setSheetUpdating(updating) {
  const preview = studio.root.querySelector("[data-h3ps-preview]");
  preview.classList.toggle("is-updating", updating);
  preview.querySelectorAll("[data-frame-count], [data-include-endpoints], [data-resample]").forEach((control) => {
    control.disabled = updating || studio.requestBusy;
  });
}

async function resampleCurrentVideo(options = null) {
  const asset = studio.assets.find((item) => item.id === studio.previewAssetId);
  if (!asset) return;
  const preview = studio.root.querySelector("[data-h3ps-preview]");
  const selectedCount = options?.frame_count || preview.querySelector("[data-frame-count].is-active")?.dataset.frameCount || asset.frame_count_mode || "auto";
  const includeEndpoints = options?.include_endpoints ?? preview.querySelector("[data-include-endpoints]").checked;
  preview.querySelectorAll("[data-frame-count]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.frameCount === selectedCount);
  });
  setSheetUpdating(true);
  try {
    const result = await resampleMedia(studio.sessionId, asset.id, {
      frame_count: selectedCount,
      include_endpoints: includeEndpoints,
    });
    Object.assign(asset, result.asset);
    openVideoPreview(asset);
    renderMedia(studio.mode);
    showToast("Contact sheet updated", `The model will use ${asset.frames.length} uniformly sampled frames.`);
  } catch (error) {
    openVideoPreview(asset);
    showToast(error.code || "Resample failed", error.message, error.details);
  } finally {
    setSheetUpdating(false);
  }
}

function showToast(title, message, details = null, action = null, options = {}) {
  const toast = studio.root.querySelector("[data-h3ps-toast]");
  const dismissOnWorkspaceClick = options.dismissOnWorkspaceClick === true;
  const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : null;
  toast.querySelector("[data-toast-title]").textContent = title;
  toast.querySelector("[data-toast-message]").textContent = message;
  const technical = toast.querySelector("[data-toast-details]");
  technical.hidden = details == null;
  technical.open = false;
  technical.querySelector("pre").textContent = details == null ? "" : typeof details === "string" ? details : JSON.stringify(details, null, 2);
  toast.classList.toggle("has-details", details != null);
  const actionButton = toast.querySelector("[data-toast-action]");
  actionButton.hidden = !action;
  actionButton.textContent = action?.label || "";
  actionButton.onclick = action ? () => { action.onClick(); hideToast(); } : null;
  toast.classList.toggle("has-action", Boolean(action));
  toast.classList.toggle("is-persistent", dismissOnWorkspaceClick);
  toast.classList.add("is-visible");
  studio.toastDismissOnWorkspaceClick = dismissOnWorkspaceClick;
  clearTimeout(studio.toastTimer);
  if (durationMs != null || !dismissOnWorkspaceClick) {
    studio.toastTimer = setTimeout(
      hideToast,
      durationMs ?? (action ? 12000 : details == null ? 2800 : 7000),
    );
  }
}

function defaultModeDraft(mode) {
  if (mode === "Music3") return MUSIC3_DEFAULT_DRAFT;
  if (mode === "Reference") {
    return { brief: REFERENCE_DEFAULT_BRIEF, prompt: SAMPLE_PROMPT };
  }
  return MODE_DEFAULT_DRAFTS[mode] || MODE_DEFAULT_DRAFTS.T2VA;
}

function currentDraftFields() {
  return {
    brief: currentBriefTextarea().value,
    lyrics: studio.mode === "Music3" ? studio.root.querySelector("[data-music-lyrics]").value : "",
    prompt: studio.root.querySelector("[data-output]").value,
  };
}

function currentBriefTextarea() {
  return studio.root.querySelector(studio.mode === "Music3" ? "[data-music-brief]" : "[data-video-brief]");
}

function saveCurrentModeDraft() {
  if (!studio || !isPersistedDraftMode(studio.mode)) return;
  studio.modeDrafts[studio.mode] = currentDraftFields();
  saveModeDrafts(localStorage, studio.modeDrafts);
}

function stashCurrentModeDraft() {
  if (!studio) return;
  saveCurrentModeDraft();
}

function updateBriefLayout() {
  if (!studio) return;
  const brief = currentBriefTextarea();
  const compactHeight = window.innerHeight <= 800;
  const largeCanvas = window.innerWidth >= 3000 && window.innerHeight >= 1600;
  const minimumHeight = compactHeight ? 80 : largeCanvas ? 125 : 105;
  const maximumHeight = compactHeight ? 130 : largeCanvas ? 230 : 190;
  brief.closest(".h3ps-brief").querySelector(".h3ps-char-count").textContent = `${brief.value.length.toLocaleString()} / 2,000`;
  brief.style.height = "auto";
  brief.style.height = `${Math.min(maximumHeight, Math.max(minimumHeight, brief.scrollHeight))}px`;
  brief.style.overflowY = brief.scrollHeight > maximumHeight ? "auto" : "hidden";
}

function updateMusicLyricsCount() {
  if (!studio) return;
  const lyrics = studio.root.querySelector("[data-music-lyrics]");
  lyrics.closest(".h3ps-brief").querySelector(".h3ps-char-count").textContent = `${lyrics.value.length.toLocaleString()} / 4,000`;
}

function restoreModeDraft(mode) {
  if (!studio) return;
  const draft = studio.modeDrafts[mode] || defaultModeDraft(mode);
  const output = studio.root.querySelector("[data-output]");
  currentBriefTextarea().value = draft.brief;
  if (mode === "Music3") studio.root.querySelector("[data-music-lyrics]").value = draft.lyrics || "";
  output.value = draft.prompt;
  studio.lastModelPrompt = draft.prompt;
  studio.lastModelMeta = promptLengthMeta(draft.prompt);
  studio.refineRestore = null;
  studio.root.querySelector("[data-refine-restore]").hidden = true;
  studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent = promptLengthMeta(output.value);
  updateBriefLayout();
  updateMusicLyricsCount();
  renderPromptHighlights();
  syncModifiedState();
}

function syncWorkspace() {
  if (!studio) return;
  const music = studio.mode === "Music3";
  studio.root.classList.toggle("is-music", music);
  studio.root.querySelectorAll("[data-workspace]").forEach((button) => {
    const selected = button.dataset.workspace === (music ? "music" : "video");
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  studio.root.querySelector("[data-video-modes]").hidden = music;
  studio.root.querySelector("[data-video-inputs]").hidden = music;
  studio.root.querySelector("[data-music-inputs]").hidden = !music;
  studio.root.querySelector("[data-output-label]").textContent = music ? "Generated caption" : "Generated prompt";
  studio.root.querySelector("[data-copy-label]").textContent = music ? "Copy caption" : "Copy prompt";
  studio.root.querySelector("[data-generate-label]").textContent = music ? "Generate caption" : "Generate prompt";
  studio.root.querySelector("[data-refine-media-note]").textContent = music ? "Lyrics stay separate" : "No media re-upload";
  studio.root.querySelector("[data-refine-title]").textContent = music ? "Refine caption" : "Refine prompt";
  studio.root.querySelector("[data-refine-helper]").textContent = music ? "Describe the musical change" : "Describe only what should change";
  studio.root.querySelector("[data-refine-instruction]").placeholder = music
    ? "For example: keep the verses sparse and let the final chorus open wider."
    : "For example: make the camera movement slower and keep the ending more ambiguous.";
  if (studio.mode === "Reference") rememberReferenceInsertTarget(studio.root.querySelector("[data-output]"));
  else referenceInsertTarget = null;
  syncReferenceInsertControl();
  if (music) syncSystemPromptEditor("music3");
}

function disarmDraftDefaults() {
  if (!studio) return;
  clearTimeout(studio.draftDefaultsTimer);
  studio.draftDefaultsArmed = false;
  const label = studio.root.querySelector("[data-restore-default-drafts-label]");
  if (label) label.textContent = "Restore default drafts";
}

function restoreDefaultDrafts(event) {
  event.stopPropagation();
  if (!studio.draftDefaultsArmed) {
    studio.draftDefaultsArmed = true;
    studio.root.querySelector("[data-restore-default-drafts-label]").textContent = "Click again to confirm";
    clearTimeout(studio.draftDefaultsTimer);
    studio.draftDefaultsTimer = setTimeout(disarmDraftDefaults, 5000);
    return;
  }
  disarmDraftDefaults();
  studio.modeDrafts = {};
  saveModeDrafts(localStorage, studio.modeDrafts);
  restoreModeDraft(studio.mode);
  showToast("Default drafts restored", "Saved mode drafts were removed.");
}

function hideToast() {
  if (!studio) return;
  clearTimeout(studio.toastTimer);
  studio.toastDismissOnWorkspaceClick = false;
  const toast = studio.root.querySelector("[data-h3ps-toast]");
  const actionButton = toast.querySelector("[data-toast-action]");
  actionButton.onclick = null;
  actionButton.textContent = "";
  actionButton.hidden = true;
  toast.classList.remove("is-visible", "is-persistent", "has-action");
}

function thinkingFallbackMessage(result, outputLabel) {
  if (
    result.thinking_budget_reduced
    && studio.selectedModel?.family === "gguf"
    && Number(result.context_tokens || 0) < 24_576
  ) {
    return `Thinking used all the space available in the selected context. The ${outputLabel} was completed in standard mode. A larger Context setting can give Thinking more room.`;
  }
  return `Thinking used its full token budget. The ${outputLabel} was completed in standard mode.`;
}

function setGenerationState(state, label, detail) {
  const button = studio.root.querySelector("[data-generate]");
  const status = studio.root.querySelector("[data-status]");
  const statusDetail = studio.root.querySelector("[data-status-detail]");
  const busy = state === "busy";
  studio.requestBusy = busy;
  studio.root.querySelector("[data-clear-media]").disabled = busy;
  studio.root.querySelectorAll("[data-mode]").forEach((control) => { control.disabled = busy; });
  studio.root.querySelectorAll("[data-workspace]").forEach((control) => { control.disabled = busy; });
  const comfyMemory = studio.root.querySelector("[data-comfy-memory-action]");
  comfyMemory.disabled = busy;
  comfyMemory.title = busy
    ? "Available after the active Writer request finishes"
    : "Unload models held by ComfyUI without clearing cached workflow results";
  button.classList.toggle("is-cancel", busy);
  button.innerHTML = busy ? `<span class="h3ps-spinner"></span>Cancel` : `${icon("spark", 16)}<span data-generate-label>${studio.mode === "Music3" ? "Generate caption" : "Generate prompt"}</span>`;
  renderMedia(studio.mode);
  setSheetUpdating(false);
  syncLifecycleActions();
  status.hidden = !busy;
  status.classList.toggle("is-busy", busy);
  if (busy) {
    if (label === "Generating") {
      studio.generationDotCount = ((studio.generationDotCount || 0) % 3) + 1;
      status.querySelector("strong").textContent = `${label}${".".repeat(studio.generationDotCount)}`;
    } else {
      studio.generationDotCount = 0;
      status.querySelector("strong").textContent = label;
    }
    statusDetail.textContent = detail;
  } else {
    studio.generationDotCount = 0;
  }
}

function updatePromptResidency(status) {
  const residency = status?.prompt_residency;
  if (!residency) return;
  studio.promptResidency = {
    direct: residency.direct?.loaded ? { modelId: residency.direct.model_id || null } : null,
    ollama: Array.isArray(residency.ollama?.models) ? residency.ollama.models.filter(Boolean) : [],
  };
}

function lifecycleTargets() {
  const targets = [];
  if (studio.promptResidency.direct) targets.push({ family: "gguf", modelId: studio.promptResidency.direct.modelId });
  studio.promptResidency.ollama.forEach((modelId) => targets.push({ family: "ollama", modelId }));
  return targets;
}

function lifecycleButtonMarkup(target, { stop = false } = {}) {
  const provider = target.family === "ollama" ? "ollama" : "direct";
  const label = stop ? "Stop & unload" : target.family === "ollama" ? "Unload Ollama" : "Unload Direct";
  const title = stop
    ? "Cancel the active request and unload its prompt model"
    : `Unload ${target.modelId || (target.family === "ollama" ? "the Ollama model" : "the Direct model")}`;
  return `<button class="h3ps-memory-action h3ps-prompt-lifecycle-action" type="button" data-lifecycle-family="${target.family}" ${target.modelId ? `data-lifecycle-model="${escapeHtml(target.modelId)}"` : ""} data-lifecycle-stop="${stop}" title="${escapeHtml(title)}"><span class="h3ps-provider-icon" data-provider-icon="${provider}" aria-hidden="true"></span>${label}</button>`;
}

function syncLifecycleActions() {
  const slot = studio.root.querySelector("[data-prompt-lifecycle-actions]");
  const directStatus = studio.root.querySelector("[data-model-lifecycle]");
  if (directStatus) directStatus.hidden = !studio.promptResidency.direct;
  const activeFamily = studio.activeRequestFamily;
  const activeLocal = studio.requestBusy && ["gguf", "ollama"].includes(activeFamily);
  const activeTarget = activeLocal ? { family: activeFamily, modelId: studio.activeRequestModelId } : null;
  const background = lifecycleTargets().filter((target) => {
    if (!activeTarget) return true;
    if (activeTarget.family === "gguf" && target.family === "gguf") return false;
    return target.family !== activeTarget.family || target.modelId !== activeTarget.modelId;
  });
  const backgroundMarkup = background.length > 1
    ? `<details class="h3ps-prompt-models-menu"><summary class="h3ps-memory-action">${icon("memory", 15)}Prompt models · ${background.length}</summary><span>${background.map((target) => lifecycleButtonMarkup(target)).join("")}</span></details>`
    : background.map((target) => lifecycleButtonMarkup(target)).join("");
  slot.innerHTML = `${activeTarget ? lifecycleButtonMarkup(activeTarget, { stop: true }) : ""}${backgroundMarkup}`;
  slot.querySelectorAll("[data-lifecycle-family]").forEach((button) => button.addEventListener("click", runLifecycleAction));
}

async function releaseComfyVram({ retry = null } = {}) {
  const button = studio.root.querySelector("[data-comfy-memory-action]");
  if (button.disabled) return;
  let shouldRetry = false;
  button.disabled = true;
  button.innerHTML = `<span class="h3ps-spinner"></span>Releasing…`;
  try {
    const before = await getStatus();
    const beforeFree = Number(before.gpu_memory?.free_mb);
    await freeComfyVram();

    let latest = before;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      latest = await getStatus();
      const currentFree = Number(latest.gpu_memory?.free_mb);
      if (Number.isFinite(beforeFree) && Number.isFinite(currentFree) && currentFree - beforeFree >= 64) break;
    }
    studio.gpuMemory = latest.gpu_memory || studio.gpuMemory;
    const afterFree = Number(latest.gpu_memory?.free_mb);
    const releasedMb = Number.isFinite(beforeFree) && Number.isFinite(afterFree) ? Math.max(0, afterFree - beforeFree) : 0;
    if (typeof retry === "function") {
      shouldRetry = true;
    } else if (releasedMb >= 64) {
      showToast("ComfyUI VRAM released", `${(releasedMb / 1024).toFixed(1)} GB freed. Workflow and cached node results were kept.`);
    } else {
      showToast("ComfyUI VRAM release requested", "No immediate VRAM change was detected. No workflow model may be loaded, or an active workflow must finish first.");
    }
  } catch (error) {
    showToast("VRAM release failed", error.message);
  } finally {
    button.disabled = false;
    syncLifecycleActions();
  }
  if (shouldRetry) await retry();
}

function showVramRetry(error, retry) {
  const freeGb = Number(error.details?.free_mb) / 1024;
  const requiredGb = Number(error.details?.required_free_mb) / 1024;
  const message = Number.isFinite(freeGb) && Number.isFinite(requiredGb)
    ? `${freeGb.toFixed(1)} GB is free; this runtime needs about ${requiredGb.toFixed(1)} GB.`
    : error.message;
  showToast(
    "Not enough free VRAM",
    message,
    null,
    { label: "Free ComfyUI VRAM & retry", onClick: () => releaseComfyVram({ retry }) },
  );
}

async function runLifecycleAction(event) {
  const button = event.currentTarget;
  if (button.disabled) return;
  const family = button.dataset.lifecycleFamily;
  const modelId = button.dataset.lifecycleModel || null;
  const stop = button.dataset.lifecycleStop === "true";
  if (stop) setGenerationState("busy", "Stopping & unloading", "Cancelling the request and unloading its prompt model");
  button.disabled = true;
  try {
    await unloadModel({ family, model_id: modelId });
    if (family === "gguf") studio.promptResidency.direct = null;
    else studio.promptResidency.ollama = studio.promptResidency.ollama.filter((name) => name !== modelId);
    showToast(
      stop ? "Stop & unload requested" : family === "ollama" ? "Ollama model unloaded" : "Direct model unloaded",
      stop ? "The request will stop and release its model at the next safe point." : "GPU memory used by the prompt model was released.",
    );
  } catch (error) {
    showToast(error.code || "Unload failed", error.message, error.details);
  } finally {
    button.disabled = false;
    syncLifecycleActions();
  }
}

async function startGenerationPreview() {
  if (studio.requestBusy) {
    setGenerationState("busy", "Cancelling", "Stopping after the current token");
    await cancel();
    return;
  }
  if (!studio.selectedModel) {
    showToast("No prompt model selected", "Choose a local model, connect llama.cpp, or configure an API provider.");
    return;
  }
  if (!studio.selectedModel.runtime_ready) {
    showToast("Model setup is incomplete", studio.selectedModel.setup_message || `Missing: ${studio.selectedModel.missing_dependencies.join(", ")}. Open the model menu to finish setup.`);
    return;
  }
  if (!await inspectDirectRuntime()) return;
  const modelName = studio.selectedModel.name.split("/").pop();
  const external = studio.selectedModel.family === "external";
  const apiProvider = studio.selectedModel.family === "api";
  const remote = external || apiProvider;
  studio.activeRequestFamily = studio.selectedModel.family;
  studio.activeRequestModelId = studio.selectedModel.family === "ollama" ? studio.selectedModel.remote_model : studio.selectedModel.id;
  const generationDetail = external ? `${modelName} · the server may load its model if idle` : apiProvider ? `${modelName} · ${studio.selectedModel.api_preset}` : modelName;
  setGenerationState("busy", remote ? "Contacting provider" : "Loading model", generationDetail);
  studio.statusTimer = setInterval(async () => {
    try {
      const status = await getStatus();
      const labels = { loading_model: remote ? "Contacting provider" : "Loading model", processing_media: "Processing references", generating: "Generating", cancelling: "Cancelling" };
      if (labels[status.phase]) setGenerationState("busy", labels[status.phase], generationDetail);
    } catch {}
  }, 650);
  try {
    const result = await generate(buildGeneratePayload(studio, {
      creativeBrief: currentBriefTextarea().value,
      lyrics: studio.mode === "Music3" ? studio.root.querySelector("[data-music-lyrics]").value : "",
      seed: newGenerationSeed(),
    }));
    const output = studio.root.querySelector("[data-output]");
    output.value = result.prompt;
    studio.lastModelPrompt = result.prompt;
    renderPromptHighlights();
    studio.lastModelMeta = formatGenerationMeta(result);
    syncRuntimeSummary(result);
    studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.lastModelMeta;
    syncModifiedState();
    saveCurrentModeDraft();
    studio.refineRestore = null;
    studio.root.querySelector("[data-refine-restore]").hidden = true;
    if (result.thinking_fallback) {
      showToast("Prompt completed", thinkingFallbackMessage(result, "final prompt"), null, null, { dismissOnWorkspaceClick: true });
    } else if (result.format_repair_applied) {
      const repairDetail = result.format_repair_multimodal
        ? "the existing uploaded references were checked again and the prompt was corrected"
        : `${result.format_repair_method} corrected it without re-uploading media`;
      showToast("Prompt generated", `The first draft failed ${result.format_repair_reason}; ${repairDetail}.`, null, null, { dismissOnWorkspaceClick: true });
    } else if (result.format_repair_failure) {
      showToast("Prompt generated with a format warning", `The first draft failed ${result.format_repair_reason}; the safe repair was rejected because ${result.format_repair_failure}.`, null, null, { dismissOnWorkspaceClick: true });
    } else {
      const reasoning = result.api_provider ? "Reasoning provider managed" : `Thinking ${result.thinking ? "on" : "off"}`;
      showToast(studio.mode === "Music3" ? "Caption generated" : "Prompt generated", `${result.total_seconds.toFixed(1)}s · ${result.tokens_per_second.toFixed(1)} tok/s · ${reasoning}`);
    }
  } catch (error) {
    if (error.code === "GENERATION_CANCELLED") {
      showToast("Generation cancelled", "The active request stopped.");
    } else if (error.code === "INSUFFICIENT_FREE_VRAM") {
      showVramRetry(error, startGenerationPreview);
    } else if (error.code === "CONTEXT_BUDGET_EXCEEDED" && error.details?.suggested_context_profile && studio.selectedModel?.family === "gguf") {
      const target = error.details.suggested_context_profile;
      const targetLabel = CONTEXT_LABELS[target] || target;
      showToast(
        "More context is needed",
        `This request needs at least ${targetLabel} context. ${CONTEXT_LABELS[studio.contextProfile]} cannot fit the current references.`,
        null,
        { label: `Use ${targetLabel}`, onClick: () => {
          studio.contextProfile = target;
          rememberRuntimePreferences();
          saveUserPreferences(localStorage, studio);
          syncRuntimeSummary();
          syncThinkingAvailability();
        } },
      );
    } else {
      showToast(error.code || "Generation failed", error.message, error.details);
    }
  } finally {
    clearInterval(studio.statusTimer);
    studio.statusTimer = null;
    try {
      const status = await getStatus();
      updatePromptResidency(status);
    } catch {}
    studio.activeRequestFamily = null;
    studio.activeRequestModelId = null;
    setGenerationState("idle", "", "");
  }
}

function modelVramLabel(model) {
  if (["external", "api"].includes(model?.family)) return "";
  const name = model?.name?.toLowerCase() || "";
  if (/e4b/.test(name)) return "8 GB VRAM";
  if (/12b/.test(name) && /q4/.test(name)) return "12 GB VRAM";
  if (/12b/.test(name)) return "16 GB VRAM";
  if (/26b/.test(name)) return "24 GB VRAM";
  if (/31b/.test(name)) return "32 GB VRAM";
  return "";
}

function detectedVramTier() {
  const totalMb = studio.gpuMemory?.total_mb;
  if (!Number.isFinite(totalMb)) return null;
  const totalGb = totalMb / 1024;
  if (totalGb >= 31) return 32;
  if (totalGb >= 23) return 24;
  if (totalGb >= 15) return 16;
  if (totalGb >= 11) return 12;
  if (totalGb >= 7) return 8;
  return null;
}

function renderModelSetupRows() {
  const tier = detectedVramTier();
  return studio.modelSetup.map((model, index) => `
    <div class="h3ps-model-setup-row ${model.vram_gb === tier ? "fits-detected-vram" : ""}" ${model.vram_gb === tier ? 'title="Fits the detected total VRAM tier"' : ""}>
      <span><strong>${escapeHtml(model.name)}</strong><small>${model.vram_gb} GB VRAM · ${model.recommended_context === "low" ? "8K" : "16K"}${model.vram_gb === tier ? " · Fits detected VRAM" : ""}</small><small class="h3ps-model-source">${escapeHtml(model.source_label)}</small></span>
      <span class="h3ps-model-files"><button type="button" data-model-files-toggle="${index}">Files ↗</button><span data-model-files-menu="${index}" hidden><a href="${model.model_url}" target="_blank" rel="noopener noreferrer">Model file ↗</a><a href="${model.projector_url}" target="_blank" rel="noopener noreferrer">Projector file ↗</a></span></span>
    </div>`).join("");
}

function modelDiscoveryDetails() {
  const roots = studio.modelDiscovery?.roots || [];
  if (!roots.length) return "";
  const lines = [];
  for (const root of roots) {
    lines.push(root.path);
    lines.push(`  Model GGUF: ${root.model_files.length}`);
    for (const path of root.model_files) lines.push(`    ${path}`);
    lines.push(`  mmproj GGUF: ${root.projector_files.length}`);
    for (const path of root.projector_files) lines.push(`    ${path}`);
    for (const issue of root.issues) lines.push(`  Issue: ${issue}`);
  }
  return lines.join("\n");
}

function renderModelScanDetails() {
  const discovery = modelDiscoveryDetails();
  return discovery ? `<details class="h3ps-model-scan"><summary>Scan details</summary><pre>${escapeHtml(discovery)}</pre></details>` : "";
}

function renderModelSetup() {
  const directory = studio.modelDirectory || "ComfyUI/models/LLM/";
  return `
    <div class="h3ps-model-setup h3ps-direct-model-empty">
      <strong>No compatible local model found</strong>
      <p>Open the two verified Hugging Face pages, download both files, then place them in:</p>
      <button type="button" class="h3ps-model-path" data-copy-model-path><code>${escapeHtml(directory)}</code>${icon("copy", 13)}</button>
      <p>Using multiple models? Keep each model and its matching vision projector together in a separate subfolder.</p>
    </div>`;
}

function renderDirectRuntimeStatus() {
  const diagnostics = studio.ggufRuntimeDiagnostics;
  if (!diagnostics) {
    return studio.ggufRuntimeDiagnosticsLoading
      ? `<section class="h3ps-direct-runtime-state is-checking"><header><span><small>Runtime</small><strong>Checking llama-cpp-python…</strong></span></header></section>`
      : "";
  }
  const onboarding = diagnostics.onboarding || {};
  if (onboarding.state === "ready") return "";
  if (onboarding.state === "missing") {
    const command = typeof onboarding.install_command === "string" ? onboarding.install_command : "";
    return `<section class="h3ps-direct-runtime-state is-missing">
      <header><span><small>Runtime</small><strong>llama-cpp-python is not installed.</strong></span></header>
      <p>Direct GGUF needs an additional native runtime. Ollama and API providers work without it.</p>
      ${command ? `<div class="h3ps-direct-runtime-command"><code>${escapeHtml(command)}</code><button type="button" data-copy-direct-runtime-command="${escapeHtml(command)}" title="Copy install command" aria-label="Copy install command">${icon("copy", 13)}</button></div><small>Run this from your ComfyUI Portable folder containing <code>python_embeded</code>. Restart ComfyUI after installation.</small>` : ""}
      <div class="h3ps-direct-runtime-links"><a href="${INSTALLATION_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Installation guide ↗</a><a href="${TROUBLESHOOTING_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Troubleshooting guide ↗</a></div>
    </section>`;
  }
  const version = diagnostics.package_version ? ` Version ${escapeHtml(diagnostics.package_version)} was detected.` : "";
  return `<section class="h3ps-direct-runtime-state is-broken">
    <header><span><small>Runtime</small><strong>llama-cpp-python is installed, but the runtime is not usable.</strong></span></header>
    <p>The native compatibility check did not find a working GPU runtime.${version}</p>
    <a href="${TROUBLESHOOTING_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Troubleshooting ↗</a>
  </section>`;
}

function localRuntimeLabel() {
  const diagnostics = studio?.ggufRuntimeDiagnostics;
  if (!diagnostics) return "Local GGUF · llama-cpp-python";
  if (diagnostics.status !== "ok") return "Runtime could not be inspected";
  const offload = diagnostics.gpu_offload ? "GPU offload available" : "GPU offload unavailable";
  return `${offload}${diagnostics.backend ? ` · ${diagnostics.backend}` : ""}`;
}

function syncSelectedModelSourceLabel() {
  if (!studio) return;
  const localModel = studio.selectedModel?.family === "gguf"
    ? studio.selectedModel
    : studio.models.find((model) => model.family === "gguf" && model.runtime_ready) || studio.models.find((model) => model.family === "gguf");
  studio.root.querySelector("[data-model-source-label]").textContent = localModel ? localRuntimeLabel() : "No compatible Direct GGUF model";
  studio.root.querySelector("[data-active-model-source]").textContent = studio.selectedModel?.family === "external"
    ? "External server"
    : studio.selectedModel?.family === "ollama"
      ? "Ollama · local service"
      : studio.selectedModel?.family === "api"
        ? `${studio.selectedModel.api_preset} · API provider`
      : studio.selectedModel
        ? localRuntimeLabel()
        : "No prompt model";
}

function syncActiveModelSummary(runtimeSummary = null) {
  if (!studio) return;
  const model = studio.selectedModel;
  const modelIcon = studio.root.querySelector("[data-active-model-icon]");
  const providerIcon = model?.family === "external"
    ? "external"
    : model?.family === "ollama"
      ? "ollama"
      : model?.family === "api"
        ? `api-${model.api_preset || studio.apiProviderConfig?.preset || "custom"}`
        : "direct";
  modelIcon.textContent = "";
  modelIcon.dataset.providerIcon = providerIcon;
  studio.root.querySelector("[data-active-model-name]").textContent = model ? model.name.split("/").pop() : "No compatible prompt model";
  studio.root.querySelector("[data-active-model-source]").textContent = model?.family === "external"
    ? "External server"
    : model?.family === "ollama"
      ? "Ollama · local service"
      : model?.family === "api"
        ? `${model.api_preset} · API provider`
      : model ? localRuntimeLabel() : "Open Settings to configure";
  if (runtimeSummary != null) studio.root.querySelector("[data-active-runtime-summary]").textContent = runtimeSummary;
}

async function inspectDirectRuntime() {
  if (studio.selectedModel?.family !== "gguf") return true;
  if (!studio.ggufRuntimeDiagnostics) {
    try {
      await loadGGUFRuntimeDiagnostics();
    } catch (error) {
      showToast("Runtime could not be inspected", "The isolated compatibility check was unavailable. Generation will continue with the existing runtime behavior.", error.details || error.message);
      return true;
    }
    syncSelectedModelSourceLabel();
  }

  const diagnostics = studio.ggufRuntimeDiagnostics;
  const blocking = diagnostics.onboarding?.state === "broken" || diagnostics.status === "crashed" || diagnostics.status === "unavailable";
  if (blocking) {
    const warning = diagnostics.warnings?.[0];
    showToast(
      warning ? "Native runtime configuration issue" : "Native runtime compatibility check failed",
      warning?.message || diagnostics.message,
      diagnostics,
    );
    return false;
  }
  if (diagnostics.status !== "ok" && !studio.runtimeWarningShown) {
    studio.runtimeWarningShown = true;
    showToast("Runtime could not be inspected", diagnostics.message, diagnostics);
  } else if (diagnostics.gpu_offload === false && !studio.runtimeWarningShown) {
    studio.runtimeWarningShown = true;
    showToast("GPU offload unavailable", "This llama.cpp build may generate on CPU and can be much slower. Install a GPU-enabled wheel that matches ComfyUI's Python and runtime.", diagnostics);
  }
  return true;
}

function renderOtherModelsTrigger() {
  return `
    <button class="h3ps-other-models-trigger" type="button" data-other-models-toggle aria-expanded="false">
      <span><strong>Browse verified models</strong><small>Model and projector download pairs</small></span>${icon("chevron", 14)}
    </button>`;
}

function renderExternalServerControl() {
  const connected = studio.externalModel;
  const config = studio.externalServerConfig || { url: "http://127.0.0.1:8080", model: "" };
  const title = connected ? connected.name.split("/").pop() : "External llama.cpp server";
  const contextLabel = Number.isFinite(connected?.server_context_tokens)
    ? ` · ${Math.round(connected.server_context_tokens / 1024)}K context`
    : "";
  const state = connected
    ? `${connected.endpoint}${contextLabel}`
    : studio.externalServerError
      ? "Saved server is offline"
      : "Connect to a model already running in llama-server";
  return `
    <div class="h3ps-external-connection ${connected ? "is-connected" : ""}">
      <div class="h3ps-external-connection-status">
        <span class="h3ps-provider-icon" data-provider-icon="external" aria-hidden="true"></span>
        <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(state)}</small></span>
        <em>${connected ? "Connected" : studio.externalServerError ? "Offline" : "Not connected"}</em>
      </div>
      <form data-external-server-form>
        <label><span>Server URL</span><input name="url" type="url" value="${escapeHtml(config.url)}" placeholder="http://127.0.0.1:8080" required></label>
        <label><span>Model ID <em>optional</em></span><input name="model" type="text" value="${escapeHtml(config.model)}" placeholder="Use the first loaded model"></label>
        <small>Localhost only. Context, KV cache and model loading stay under server control.</small>
        <div><button type="button" data-external-server-disconnect ${connected || studio.externalServerConfig ? "" : "hidden"}>Disconnect</button><span></span><button type="submit">${connected ? "Reconnect" : "Connect"}</button></div>
      </form>
    </div>`;
}

function ollamaModels() {
  return Array.isArray(studio.ollamaStatus?.compatible_models) ? studio.ollamaStatus.compatible_models : [];
}

function ollamaModelForSettings() {
  const models = ollamaModels();
  if (studio.selectedModel?.family === "ollama") {
    return models.find((model) => model.id === studio.selectedModel.id) || studio.selectedModel;
  }
  return models.find((model) => model.remote_model === studio.ollamaModelName) || models[0] || null;
}

function ollamaJourneyMarkup(step) {
  const steps = [["service", "Ollama"], ["model", "Prompt model"], ["ready", "Ready"]];
  const current = steps.findIndex(([name]) => name === step);
  return `<ol class="h3ps-ollama-journey">${steps.map(([name, label], index) => `
    <li class="${index < current ? "is-complete" : index === current ? "is-current" : ""}"><span>${index + 1}</span><em>${label}</em></li>`).join("")}</ol>`;
}

function ollamaDetectedTier() {
  const totalMb = studio.gpuMemory?.total_mb;
  if (!Number.isFinite(totalMb)) return null;
  return detectedVramTier() || "under-8";
}

function renderOllamaModelTiers(status) {
  const tiers = Array.isArray(status.model_tiers) ? status.model_tiers : [];
  const detected = ollamaDetectedTier();
  return `<div class="h3ps-ollama-tier-list">${tiers.map((tier) => {
    const vramTiers = Array.isArray(tier.vram_tiers) ? tier.vram_tiers : [];
    const isDetected = detected === "under-8" ? vramTiers.length === 0 : vramTiers.includes(detected);
    const command = `ollama pull ${tier.model}`;
    return `<div class="h3ps-ollama-tier-row ${isDetected ? "is-detected" : ""}">
      <span class="h3ps-ollama-tier-vram">${escapeHtml(tier.label)}</span>
      <code>${escapeHtml(command)}</code>
      ${isDetected ? "<em>Detected</em>" : "<span></span>"}
      <button type="button" data-copy-ollama-command="${escapeHtml(command)}" title="Copy ${escapeHtml(command)}" aria-label="Copy ${escapeHtml(command)}">${icon("copy", 13)}</button>
    </div>`;
  }).join("")}</div>`;
}

function renderOllamaProviderControl() {
  const status = studio.ollamaStatus;
  if (!status) {
    return `<header class="h3ps-settings-section-heading"><span><small>Local service</small><strong>Ollama</strong></span></header>
      ${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state"><span class="h3ps-spinner"></span><span class="h3ps-ollama-state-copy"><strong>Checking Ollama…</strong><p>Looking for the local service and installed models.</p></span></div>`;
  }
  const ready = status.state === "ready";
  const refresh = ready ? `<button type="button" data-ollama-refresh>${icon("refresh", 13)} Refresh</button>` : "";
  const header = `<header class="h3ps-settings-section-heading"><span><small>Local service</small><strong>Ollama</strong></span>${refresh}</header>`;
  if (status.state === "not_installed") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">1</span><span class="h3ps-ollama-state-copy"><strong>Get Ollama</strong>
      <p>Install the official Ollama app, open it once, then return here. This page will detect it automatically.</p></span>
      <a class="h3ps-ollama-primary" href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">Official download ↗</a>
    </div>`;
  }
  if (status.state === "not_running") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">1</span><span class="h3ps-ollama-state-copy"><strong>Start Ollama</strong>
      <p>Ollama is installed, but its local service is not responding. Open the Ollama app; this page checks automatically.</p></span>
      <button class="h3ps-ollama-primary" type="button" data-ollama-refresh>Check now</button>
    </div>`;
  }
  if (status.state === "error") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state is-error">
      <span class="h3ps-ollama-state-icon">!</span><span class="h3ps-ollama-state-copy"><strong>Ollama could not be inspected</strong>
      <p>${escapeHtml(status.error?.message || "The service returned an unexpected response.")}</p></span>
      <button class="h3ps-ollama-primary" type="button" data-ollama-refresh>Try again</button>
    </div>`;
  }
  const models = ollamaModels();
  if (!models.length) {
    return `${header}${ollamaJourneyMarkup("model")}<div class="h3ps-ollama-state h3ps-ollama-model-state">
      <span class="h3ps-ollama-state-copy"><strong>Add a compatible prompt model</strong>
      <p>Ollama is running, but no installed model reports both vision and text generation support.</p>
      <div class="h3ps-ollama-tier-heading">Choose a model for your GPU</div>
      ${renderOllamaModelTiers(status)}
      <small>Copy a command and run it in Terminal or PowerShell. This page detects the model automatically.</small>
      <details class="h3ps-ollama-storage-help"><summary>Need models on another drive?</summary><p>Ollama manages one global model store. Set <code>OLLAMA_MODELS</code> before pulling a model, then restart Ollama. <a href="https://docs.ollama.com/windows#changing-model-location" target="_blank" rel="noopener noreferrer">Official instructions ↗</a></p></details></span>
    </div>`;
  }
  const selected = ollamaModelForSettings();
  const tested = selected?.tested_for_h3 === true;
  const addModelOpen = studio.ollamaAddModelOpen === true;
  return `${header}${ollamaJourneyMarkup("ready")}<div class="h3ps-ollama-ready">
    <div class="h3ps-ollama-ready-heading"><span class="h3ps-provider-icon" data-provider-icon="ollama" aria-hidden="true"></span><span><strong>Ollama is ready</strong><small>Version ${escapeHtml(status.version || "unknown")} · local service</small></span><em>Running</em></div>
    <div class="h3ps-ollama-model-heading"><span>Prompt model</span><button class="h3ps-ollama-add-model-toggle" type="button" data-ollama-add-model aria-expanded="${String(addModelOpen)}">${addModelOpen ? "− Hide models" : "+ Add model"}</button></div>
    <label class="h3ps-ollama-model-select"><select data-ollama-model>${models.map((model) => `<option value="${escapeHtml(model.remote_model)}" ${model.remote_model === selected?.remote_model ? "selected" : ""}>${escapeHtml(model.name)}${model.parameter_size ? ` · ${escapeHtml(model.parameter_size)}` : ""}${model.quantization_level ? ` · ${escapeHtml(model.quantization_level)}` : ""}</option>`).join("")}</select></label>
    ${addModelOpen ? `<div class="h3ps-ollama-add-model"><strong>Choose another tested model</strong>${renderOllamaModelTiers(status)}<small>Copy a command and run it in Terminal or PowerShell. Select Refresh after the pull completes.</small></div>` : ""}
    <div class="h3ps-ollama-badges"><span>Vision</span><span>${selected?.thinking_detected ? "Thinking detected" : "Standard generation"}</span><span class="${tested ? "is-tested" : ""}">${tested ? "Tested for H3" : "Compatible · not yet H3-tested"}</span></div>
    <p>${tested ? "This exact Ollama tag passed the focused H3 Generate and Refine smoke test." : "Compatibility comes from Ollama model metadata. It is not a quality guarantee for H3 prompts."}</p>
    <small>Use “Keep model loaded” on the Generate page to control whether Ollama retains this model after each request.</small>
  </div>`;
}

const API_PROVIDER_UI = {
  gemini: { name: "Gemini", icon: "api-gemini", note: "Google API", keyUrl: "https://aistudio.google.com/api-keys" },
  openai: { name: "OpenAI", icon: "api-openai", note: "OpenAI API", keyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { name: "OpenRouter", icon: "api-openrouter", note: "Multi-provider gateway", keyUrl: "https://openrouter.ai/settings/keys" },
  custom: { name: "Custom", icon: "api-custom", note: "Generic OpenAI-compatible", keyUrl: null },
};

function apiProviderModelForSettings() {
  if (studio.selectedModel?.family === "api") {
    return studio.apiProviderModels.find((model) => model.id === studio.selectedModel.id) || studio.selectedModel;
  }
  const requested = studio.apiProviderConfig?.model_id;
  return studio.apiProviderModels.find((model) => model.remote_model === requested)
    || studio.apiProviderModels.find((model) => model.capabilities?.images === true)
    || studio.apiProviderModels[0]
    || null;
}

function renderApiProviderControl() {
  const config = studio.apiProviderConfig;
  const selectedPreset = API_PROVIDER_UI[config.preset] || API_PROVIDER_UI.gemini;
  const providerMetadata = studio.apiProviderPresets.find((provider) => provider.id === config.preset) || {};
  const connection = studio.apiProviderConnection;
  const model = apiProviderModelForSettings();
  const providerChoices = Object.entries(API_PROVIDER_UI).map(([id, provider]) => `
    <button type="button" class="h3ps-api-preset ${id === config.preset ? "is-selected" : ""}" data-api-preset="${id}">
      <span class="h3ps-provider-icon" data-provider-icon="${provider.icon}" aria-hidden="true"></span><span><strong>${provider.name}</strong><small>${provider.note}</small></span>${icon("check", 13)}
    </button>`).join("");
  const header = `<header class="h3ps-settings-section-heading"><span><small>OpenAI-compatible</small><strong>API providers</strong></span></header>`;
  const disclosure = `<div class="h3ps-api-disclosure"><strong>What leaves this computer</strong><p>The provider receives your brief, H3 instructions, prepared images and one derived contact sheet per video in the current manifest. Original videos and audio bytes are not uploaded.</p>${config.preset === "openrouter" ? "<small>OpenRouter forwards the request to an upstream model provider with its own data policy.</small>" : ""}</div>`;
  const policyLinks = [
    providerMetadata.pricing_url ? `<a href="${escapeHtml(providerMetadata.pricing_url)}" target="_blank" rel="noopener noreferrer">Pricing ↗</a>` : "",
    providerMetadata.privacy_url ? `<a href="${escapeHtml(providerMetadata.privacy_url)}" target="_blank" rel="noopener noreferrer">Data policy ↗</a>` : "",
  ].filter(Boolean).join("");
  if (connection) {
    const models = studio.apiProviderModels.length ? studio.apiProviderModels : model ? [model] : [];
    return `${header}<div class="h3ps-api-layout">
      <div class="h3ps-api-preset-list">${providerChoices}</div>
      <div class="h3ps-api-setup">
        <div class="h3ps-api-connected">
          <span class="h3ps-provider-icon" data-provider-icon="${selectedPreset.icon}" aria-hidden="true"></span>
          <span><strong>${escapeHtml(connection.provider_name)}</strong><small>${escapeHtml(connection.base_url)} · ${escapeHtml(connection.key_hint || "no key")}${connection.compatibility_profile === "lm_studio" ? " · LM Studio detected" : ""}</small></span>
          <em>${connection.connection_verified ? "Connected" : "Configured"}</em>
        </div>
        <label class="h3ps-api-model-select"><span>Model</span><select data-api-model>${models.map((item) => `<option value="${escapeHtml(item.remote_model)}" ${item.remote_model === model?.remote_model ? "selected" : ""}>${escapeHtml(item.name)}${item.model_context_limit ? ` · ${Math.round(item.model_context_limit / 1024)}K` : ""}</option>`).join("")}</select></label>
        <div class="h3ps-api-badges"><span class="${model?.capabilities?.images ? "is-ready" : ""}">${model?.capabilities?.images ? "Vision" : "Text only / unknown"}</span><span>${config.preset === "gemini" ? `Thinking ${escapeHtml(connection.reasoning_effort || "minimal")}` : "Reasoning provider managed"}</span><span>Provider managed</span></div>
        <div class="h3ps-api-actions"><span>${policyLinks}</span><button type="button" data-api-model-refresh>${icon("refresh", 13)} Refresh models</button><button type="button" data-api-disconnect>Disconnect</button></div>
        ${disclosure}
        <p class="h3ps-api-cancel-note">Stop aborts H3's connection. The remote provider may continue processing or billing.</p>
      </div>
    </div>`;
  }
  return `${header}<div class="h3ps-api-layout">
    <div class="h3ps-api-preset-list">${providerChoices}</div>
    <form class="h3ps-api-setup" data-api-provider-form>
      <div class="h3ps-api-intro"><strong>Connect ${selectedPreset.name}</strong><p>One shared Chat Completions backend. Provider-specific fields are applied by the selected preset.</p></div>
      ${config.preset === "custom" ? `<label><span>API base URL</span><input name="base_url" type="url" value="${escapeHtml(config.base_url)}" placeholder="https://host.example/v1 or http://localhost:8000/v1" required><small>Remote endpoints require HTTPS; loopback HTTP is allowed for local vLLM or LM Studio.</small></label>` : ""}
      <label><span>API key ${config.preset === "custom" ? "<em>optional</em>" : ""}</span><input name="api_key" type="password" value="" placeholder="Paste key for this session" autocomplete="off" spellcheck="false" ${config.preset === "custom" ? "" : "required"}><small>The key is sent once to the local H3 backend, kept only in memory, and never saved in localStorage.</small></label>
      <label><span>Model ID <em>optional before connect</em></span><input name="model_id" type="text" value="${escapeHtml(config.model_id)}" placeholder="Choose from provider list or enter an exact ID" spellcheck="false"></label>
      ${config.preset === "gemini" ? `<label><span>Thinking level</span><select name="gemini_reasoning_effort"><option value="minimal" ${config.gemini_reasoning_effort === "minimal" ? "selected" : ""}>Minimal</option><option value="low" ${config.gemini_reasoning_effort === "low" ? "selected" : ""}>Low</option><option value="medium" ${config.gemini_reasoning_effort === "medium" ? "selected" : ""}>Medium</option><option value="high" ${config.gemini_reasoning_effort === "high" ? "selected" : ""}>High</option></select><small>Gemini manages the reasoning and output budget. Higher levels can use more tokens and take longer.</small></label>` : ""}
      ${config.preset === "custom" ? `<div class="h3ps-api-custom-options"><label><input name="custom_images" type="checkbox" ${config.custom_images ? "checked" : ""}><span>Endpoint accepts image_url inputs</span></label><label><span>Known context <em>optional</em></span><input name="custom_context_tokens" type="number" min="4096" step="1024" value="${config.custom_context_tokens || ""}" placeholder="32768"></label></div>` : ""}
      ${studio.apiProviderError ? `<div class="h3ps-api-error"><strong>${escapeHtml(studio.apiProviderError.code || "Connection failed")}</strong><span>${escapeHtml(studio.apiProviderError.message)}</span></div>` : ""}
      ${disclosure}
      <div class="h3ps-api-actions"><span>${selectedPreset.keyUrl ? `<a href="${selectedPreset.keyUrl}" target="_blank" rel="noopener noreferrer">Create or manage key ↗</a>` : ""}${policyLinks}</span><button class="h3ps-api-primary" type="submit">Connect &amp; test</button></div>
    </form>
  </div>`;
}

function setOtherModelsPopover(open) {
  if (!studio) return;
  const popover = studio.root.querySelector("[data-other-models-popover]");
  const trigger = studio.root.querySelector("[data-other-models-toggle]");
  if (!popover) return;
  popover.hidden = !open;
  trigger?.setAttribute("aria-expanded", String(open));
  if (open) requestAnimationFrame(positionOtherModelsPopover);
}

function positionOtherModelsPopover() {
  const popover = studio?.root.querySelector("[data-other-models-popover]");
  const trigger = studio?.root.querySelector("[data-other-models-toggle]");
  const panel = studio?.root.querySelector('[data-provider-panel="direct"]');
  if (!popover || popover.hidden || !trigger || !panel) return;
  const margin = 12;
  const gap = 8;
  const panelRect = panel.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const width = Math.min(panelRect.width, 560, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;
  const maxHeight = Math.min(window.innerHeight * 0.62, 520, window.innerHeight - margin * 2);
  const height = Math.min(popover.scrollHeight, maxHeight);
  let left = triggerRect.right + gap;
  if (left + width > window.innerWidth - margin) left = triggerRect.left - width - gap;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  const top = Math.max(margin, Math.min(triggerRect.top, window.innerHeight - height - margin));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function localModels() {
  return studio.models.filter((model) => model.family === "gguf");
}

function directModelForSettings() {
  const models = localModels();
  if (studio.selectedModel?.family === "gguf") {
    return models.find((model) => model.id === studio.selectedModel.id) || studio.selectedModel;
  }
  return models.find((model) => model.runtime_ready) || models[0] || null;
}

function syncProviderSettings() {
  const provider = ["direct", "external", "ollama", "api"].includes(studio.settingsProvider) ? studio.settingsProvider : "direct";
  studio.root.querySelectorAll("[data-provider-option]").forEach((button) => {
    const selected = button.dataset.providerOption === provider;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  studio.root.querySelectorAll("[data-provider-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.providerPanel !== provider;
  });
  const runtimeSettings = studio.root.querySelector(".h3ps-runtime-settings");
  runtimeSettings.hidden = provider !== "direct";
}

function renderInferenceSettings() {
  const models = localModels();
  const directModel = directModelForSettings();
  const select = studio.root.querySelector("[data-installed-model]");
  select.disabled = !models.length;
  select.innerHTML = models.length
    ? models.map((model) => {
      const modelFileNeedsSetup = (model.missing_dependencies || []).some((dependency) => dependency !== "llama-cpp-python");
      const suffix = [modelVramLabel(model), model.format, modelFileNeedsSetup ? "Needs setup" : ""].filter(Boolean).join(" · ");
      return `<option value="${escapeHtml(model.id)}" ${model.id === directModel?.id ? "selected" : ""}>${escapeHtml(model.name.split("/").pop())}${suffix ? ` — ${escapeHtml(suffix)}` : ""}</option>`;
    }).join("")
    : "<option>No compatible model found</option>";
  studio.root.querySelector("[data-direct-runtime-status]").innerHTML = renderDirectRuntimeStatus();
  const directStatus = studio.root.querySelector("[data-direct-model-status]");
  if (!models.length) {
    directStatus.innerHTML = renderModelSetup();
  } else if (directModel) {
    const missingModelFiles = (directModel.missing_dependencies || []).filter((dependency) => dependency !== "llama-cpp-python");
    directStatus.innerHTML = missingModelFiles.length
      ? `<div class="h3ps-direct-model-warning"><strong>Model needs attention</strong><span>${escapeHtml(directModel.setup_message || `Missing ${missingModelFiles.join(", ")}`)}</span></div>`
      : "";
  } else {
    directStatus.innerHTML = "";
  }
  studio.root.querySelector("[data-model-scan-slot]").innerHTML = renderModelScanDetails();
  studio.root.querySelector("[data-verified-models-slot]").innerHTML = studio.modelSetup.length ? renderOtherModelsTrigger() : "";
  studio.root.querySelector("[data-external-provider-control]").innerHTML = renderExternalServerControl();
  studio.root.querySelector("[data-ollama-provider-control]").innerHTML = renderOllamaProviderControl();
  studio.root.querySelector("[data-api-provider-control]").innerHTML = renderApiProviderControl();
  const catalog = studio.root.querySelector("[data-other-models-catalog]");
  catalog.innerHTML = `<div class="h3ps-model-setup-list">${renderModelSetupRows()}</div>`;
  syncSelectedModelSourceLabel();
  syncProviderSettings();
}

async function loadGGUFRuntimeDiagnostics(force = false) {
  if (studio.ggufRuntimeDiagnostics && !force) return studio.ggufRuntimeDiagnostics;
  if (ggufRuntimeDiagnosticsPromise) return ggufRuntimeDiagnosticsPromise;
  studio.ggufRuntimeDiagnosticsLoading = true;
  if (studio.root) renderInferenceSettings();
  ggufRuntimeDiagnosticsPromise = diagnoseGGUFRuntime(force)
    .then((result) => {
      studio.ggufRuntimeDiagnostics = result.diagnostics;
      return result.diagnostics;
    })
    .finally(() => {
      studio.ggufRuntimeDiagnosticsLoading = false;
      ggufRuntimeDiagnosticsPromise = null;
      if (studio.root) renderInferenceSettings();
    });
  return ggufRuntimeDiagnosticsPromise;
}

async function refreshGGUFRuntimeDiagnostics(force = false) {
  try {
    await loadGGUFRuntimeDiagnostics(force);
  } catch (error) {
    studio.ggufRuntimeDiagnostics = {
      status: "unavailable",
      message: error.message || "The native runtime could not be inspected.",
      onboarding: { state: "broken", install_command: null },
    };
    renderInferenceSettings();
  }
}

function selectSettingsProvider(provider) {
  setOtherModelsPopover(false);
  rememberRuntimePreferences();
  studio.settingsProvider = ["direct", "external", "ollama", "api"].includes(provider) ? provider : "direct";
  applyRuntimePreferences(studio.settingsProvider);
  syncOllamaAutoDetection();
  if (studio.settingsProvider === "external" && studio.externalModel) {
    selectModel(studio.externalModel);
    return;
  }
  if (studio.settingsProvider === "direct") {
    const model = directModelForSettings();
    if (model && studio.selectedModel?.id !== model.id) {
      selectModel(model);
      return;
    }
  }
  if (studio.settingsProvider === "ollama") {
    studio.contextProfile = "auto";
    studio.kvCache = "auto";
    const model = ollamaModelForSettings();
    if (model && studio.selectedModel?.id !== model.id) {
      selectModel(model);
      return;
    }
  }
  if (studio.settingsProvider === "api") {
    studio.contextProfile = "auto";
    studio.kvCache = "auto";
    const model = apiProviderModelForSettings();
    if (studio.apiProviderConnection && model && studio.selectedModel?.id !== model.id) {
      selectModel(model);
      return;
    }
  }
  renderInferenceSettings();
  syncRuntimeSummary();
  saveUserPreferences(localStorage, studio);
}

function selectModel(model, { preserveSettingsProvider = false } = {}) {
  rememberRuntimePreferences();
  selectModelState(studio, model, { preserveSettingsProvider });
  applyRuntimePreferences(studio.settingsProvider);
  if (model?.family === "gguf") studio.preferredDirectModelId = model.id;
  const remote = ["external", "api"].includes(model?.family);
  if (model?.family !== "gguf") {
    studio.contextProfile = "auto";
    studio.kvCache = "auto";
  }
  if (model?.family === "ollama") {
    studio.ollamaModelName = model.remote_model;
    saveOllamaModel(localStorage, model.remote_model);
  }
  if (model?.family === "api") {
    studio.contextProfile = "auto";
    studio.kvCache = "auto";
    studio.thinking = false;
    studio.apiProviderConfig.model_id = model.remote_model;
    saveApiProviderConfig(localStorage, studio.apiProviderConfig);
  }
  const keepLoaded = studio.root.querySelector("[data-keep-loaded]");
  const keepLoadedControl = studio.root.querySelector("[data-keep-loaded-control]");
  keepLoadedControl.hidden = remote;
  keepLoaded.checked = studio.keepModelLoaded;
  renderInferenceSettings();
  renderMedia(studio.mode);
  setOtherModelsPopover(false);
  syncRuntimeSummary();
  syncThinkingAvailability();
  saveUserPreferences(localStorage, studio);
}

function rememberRuntimePreferences(provider = studio.settingsProvider) {
  if (studio.preferencesRestoring) return;
  if (provider === "direct") {
    studio.directContextProfile = studio.contextProfile;
    studio.directKvCache = studio.kvCache;
  }
}

function applyRuntimePreferences(provider) {
  if (provider === "direct") {
    studio.contextProfile = studio.directContextProfile;
    studio.kvCache = studio.directKvCache;
  } else {
    studio.contextProfile = "auto";
    studio.kvCache = "auto";
  }
}

function syncThinkingAvailability() {
  if (!studio) return;
  const apiManaged = studio.selectedModel?.family === "api";
  const external = studio.selectedModel?.family === "external";
  const context = studio.contextProfile;
  const resolved = context === "auto" ? (studio.selectedModel?.recommended_context || "standard") : context;
  const input = studio.root.querySelector("[data-thinking]");
  const label = input.closest("label");
  const unsupported = studio.selectedModel?.family === "ollama" && studio.selectedModel.thinking !== true;
  const disabled = apiManaged || unsupported || (!external && context !== "auto" && resolved === "low");
  if (disabled) input.checked = false;
  if (disabled) studio.thinking = false;
  input.checked = studio.thinking;
  input.disabled = disabled;
  label.hidden = apiManaged;
  label.classList.toggle("is-disabled", disabled);
  label.title = unsupported
    ? "This provider model does not report thinking controls."
    : disabled ? "Thinking needs Standard 16K or Extended 24K context." : "";
}

const CONTEXT_LABELS = { auto: "Auto", low: "8K", standard: "16K", extended: "24K" };
const KV_LABELS = { auto: "Auto", q8: "Q8", f16: "F16" };

function syncRuntimeSummary(result = null) {
  if (!studio) return;
  studio.root.querySelector('[data-runtime-label="context"]').textContent = CONTEXT_LABELS[studio.contextProfile];
  studio.root.querySelector('[data-runtime-label="kv"]').textContent = KV_LABELS[studio.kvCache];
  const summary = studio.root.querySelector("[data-runtime-summary]");
  let activeSummary;
  if (studio.selectedModel?.family === "external") {
    const tokens = result?.context_tokens || studio.selectedModel.server_context_tokens;
    activeSummary = tokens ? `Server · ${Math.round(tokens / 1024)}K` : "Server managed";
  } else if (studio.selectedModel?.family === "ollama") {
    const tokens = result?.context_tokens || (studio.contextProfile === "auto" ? null : ({ low: 8192, standard: 16384, extended: 24576 }[studio.contextProfile]));
    activeSummary = tokens ? `Ollama · ${Math.round(tokens / 1024)}K` : "Ollama · Auto";
  } else if (studio.selectedModel?.family === "api") {
    const tokens = result?.context_limit_known ? result.context_tokens : studio.selectedModel.model_context_limit;
    activeSummary = tokens ? `API · ${Math.round(tokens / 1024)}K` : "API · Provider managed";
  } else if (result && studio.contextProfile === "auto") {
    activeSummary = `Auto → ${Math.round(result.context_tokens / 1024)}K · ${String(result.kv_cache).toUpperCase()}`;
  } else {
    activeSummary = studio.contextProfile === "auto" ? "Runtime · Auto" : `${CONTEXT_LABELS[studio.contextProfile]} · ${KV_LABELS[studio.kvCache]}`;
  }
  const settingsSummary = studio.contextProfile === "auto"
    ? "Auto"
    : `${CONTEXT_LABELS[studio.contextProfile]} · ${KV_LABELS[studio.kvCache]}`;
  summary.textContent = settingsSummary;
  syncActiveModelSummary(activeSummary);
  studio.root.querySelectorAll("[data-runtime-option]").forEach((button) => {
    const selected = button.dataset.runtimeOption === "context" ? studio.contextProfile : studio.kvCache;
    button.classList.toggle("is-selected", button.dataset.value === selected);
  });
}

function setSettingsOpen(open) {
  if (!studio) return;
  setOtherModelsPopover(false);
  const selectedProvider = studio.selectedModel?.family === "external" ? "external" : studio.selectedModel?.family === "ollama" ? "ollama" : studio.selectedModel?.family === "api" ? "api" : studio.selectedModel?.family === "gguf" ? "direct" : null;
  if (!open && selectedProvider) studio.settingsProvider = selectedProvider;
  studio.root.querySelector("[data-settings-view]").hidden = !open;
  studio.root.querySelectorAll("[data-generate-view]").forEach((element) => { element.hidden = open; });
  studio.root.querySelector("[data-open-settings-header]").hidden = open;
  studio.root.classList.toggle("is-settings-open", open);
  if (open) {
    if (selectedProvider) studio.settingsProvider = selectedProvider;
    renderInferenceSettings();
    syncRuntimeSummary();
    syncSystemPromptEditors();
    setSystemPromptProfile(studio.settingsPromptProfile);
    setSystemPromptEditorOpen(false);
  }
  syncOllamaAutoDetection();
}

function syncOllamaAutoDetection() {
  clearTimeout(studio?.ollamaPollTimer);
  if (!studio) return;
  studio.ollamaPollTimer = null;
  const settingsOpen = studio.root.classList.contains("is-settings-open");
  const needsDetection = studio.settingsProvider === "ollama" && studio.ollamaStatus?.state !== "ready";
  if (!settingsOpen || !needsDetection) return;
  studio.ollamaPollTimer = setTimeout(() => refreshOllama({ automatic: true }), 4000);
}

async function connectExternalServer(form) {
  const submit = form.querySelector('[type="submit"]');
  const config = {
    url: form.elements.url.value.trim(),
    model: form.elements.model.value.trim(),
  };
  submit.disabled = true;
  submit.textContent = "Connecting…";
  try {
    const result = await probeExternalServer(config);
    const saved = { url: result.model.endpoint, model: result.model.remote_model };
    studio.externalServerConfig = saved;
    studio.externalServerError = null;
    studio.externalModel = result.model;
    saveExternalServerConfig(localStorage, saved);
    studio.models = [...studio.models.filter((model) => model.family !== "external"), result.model];
    selectModel(result.model);
    showToast("llama.cpp connected", `${result.model.name} · ${Math.round(result.model.server_context_tokens / 1024)}K context`);
  } catch (error) {
    studio.externalServerError = error;
    showToast(error.code || "Connection failed", error.message, error.details);
    renderInferenceSettings();
  } finally {
    submit.disabled = false;
    submit.textContent = "Connect";
  }
}

function disconnectExternalServer() {
  const wasSelected = studio.selectedModel?.family === "external";
  studio.externalServerConfig = null;
  studio.externalServerError = null;
  studio.externalModel = null;
  saveExternalServerConfig(localStorage, null);
  studio.models = studio.models.filter((model) => model.family !== "external");
  if (wasSelected) selectModel(studio.models.find((model) => model.runtime_ready) || studio.models[0] || null);
  studio.settingsProvider = "external";
  renderInferenceSettings();
  syncRuntimeSummary();
  saveUserPreferences(localStorage, studio);
  showToast("External server disconnected", "The llama.cpp process was left running and unchanged.");
}

async function connectConfiguredApiProvider(form) {
  const submit = form.querySelector('[type="submit"]');
  const contextValue = Number(form.elements.custom_context_tokens?.value || 0);
  const config = {
    preset: studio.apiProviderConfig.preset,
    base_url: form.elements.base_url?.value.trim() || "",
    model_id: form.elements.model_id.value.trim(),
    gemini_reasoning_effort: form.elements.gemini_reasoning_effort?.value || studio.apiProviderConfig.gemini_reasoning_effort || "minimal",
    custom_images: Boolean(form.elements.custom_images?.checked),
    custom_context_tokens: Number.isInteger(contextValue) && contextValue >= 4096 ? contextValue : null,
  };
  submit.disabled = true;
  submit.textContent = "Connecting…";
  try {
    const result = await probeApiProvider({
      preset: config.preset,
      base_url: config.base_url,
      model_id: config.model_id,
      credential: {
        source: "session",
        value: form.elements.api_key?.value || "",
      },
      custom_capabilities: {
        images: config.custom_images,
        context_tokens: config.custom_context_tokens,
      },
      provider_options: {
        reasoning_effort: config.gemini_reasoning_effort,
      },
    });
    if (studio.apiProviderConnection?.id && studio.apiProviderConnection.id !== result.connection.id) {
      disconnectApiProvider(studio.apiProviderConnection.id).catch(() => {});
    }
    studio.apiProviderConfig = config;
    studio.apiProviderConnection = result.connection;
    studio.apiProviderModels = result.models || [];
    studio.apiProviderError = null;
    saveApiProviderConfig(localStorage, config);
    studio.models = [...studio.models.filter((model) => model.family !== "api"), ...studio.apiProviderModels];
    const model = result.model || apiProviderModelForSettings();
    if (model) selectModel(model);
    else {
      renderInferenceSettings();
      syncRuntimeSummary();
      saveUserPreferences(localStorage, studio);
    }
    showToast(
      `${result.connection.provider_name} connected`,
      model ? `${model.name} · ${model.capabilities?.images ? "vision ready" : "text only or vision unknown"}${result.connection.connection_verified ? "" : " · endpoint unverified"}` : "Connected. Enter an exact model ID or refresh the model list.",
    );
  } catch (error) {
    studio.apiProviderError = error;
    showToast(error.code || "API connection failed", error.message, error.details);
    renderInferenceSettings();
  } finally {
    submit.disabled = false;
    submit.textContent = "Connect & test";
  }
}

async function disconnectConfiguredApiProvider({ announce = true } = {}) {
  const connection = studio.apiProviderConnection;
  const wasSelected = studio.selectedModel?.family === "api";
  if (connection?.id) {
    try {
      await disconnectApiProvider(connection.id);
    } catch {}
  }
  studio.apiProviderConnection = null;
  studio.apiProviderModels = [];
  studio.apiProviderError = null;
  studio.models = studio.models.filter((model) => model.family !== "api");
  if (wasSelected) selectModel(studio.models.find((model) => model.runtime_ready) || studio.models[0] || null);
  studio.settingsProvider = "api";
  renderInferenceSettings();
  syncRuntimeSummary();
  saveUserPreferences(localStorage, studio);
  if (announce) showToast("API provider disconnected", "The session credential was removed from backend memory.");
}

async function chooseApiProviderPreset(preset) {
  if (!API_PROVIDER_UI[preset] || preset === studio.apiProviderConfig.preset) return;
  if (studio.apiProviderConnection) await disconnectConfiguredApiProvider({ announce: false });
  studio.apiProviderConfig = {
    ...studio.apiProviderConfig,
    preset,
    base_url: "",
    model_id: "",
    gemini_reasoning_effort: "minimal",
    custom_images: false,
    custom_context_tokens: null,
  };
  saveApiProviderConfig(localStorage, studio.apiProviderConfig);
  studio.settingsProvider = "api";
  renderInferenceSettings();
}

async function refreshApiProviderModels() {
  if (!studio.apiProviderConnection) return;
  try {
    const result = await getApiProviderModels(studio.apiProviderConnection.id);
    const selectedRemote = studio.selectedModel?.family === "api" ? studio.selectedModel.remote_model : studio.apiProviderConfig.model_id;
    studio.apiProviderConnection = result.connection;
    studio.apiProviderModels = result.models || [];
    studio.models = [...studio.models.filter((model) => model.family !== "api"), ...studio.apiProviderModels];
    const model = studio.apiProviderModels.find((item) => item.remote_model === selectedRemote) || apiProviderModelForSettings();
    if (model) selectModel(model);
    else renderInferenceSettings();
    showToast("API models refreshed", `${studio.apiProviderModels.length} model${studio.apiProviderModels.length === 1 ? "" : "s"} reported.`);
  } catch (error) {
    studio.apiProviderError = error;
    showToast(error.code || "Model refresh failed", error.message, error.details);
  }
}

async function refreshModels() {
  try {
    const [result, status, ollamaStatus, apiPresets] = await Promise.all([
      getModels(),
      getStatus(),
      getOllamaStatus().catch((error) => ({ state: "error", running: false, compatible_models: [], error: { code: error.code, message: error.message } })),
      getApiProviderPresets().catch(() => ({ presets: [] })),
    ]);
    const selectedId = studio.selectedModel?.id;
    const selectedBeforeRefresh = studio.selectedModel;
    studio.ollamaStatus = ollamaStatus;
    studio.ollamaError = ollamaStatus.error || null;
    studio.apiProviderPresets = apiPresets.presets || [];
    studio.models = [...result.models, ...(ollamaStatus.compatible_models || []), ...studio.apiProviderModels];
    studio.externalModel = null;
    studio.externalServerError = null;
    if (studio.externalServerConfig) {
      try {
        const external = await probeExternalServer(studio.externalServerConfig);
        studio.externalModel = external.model;
        studio.models.push(external.model);
      } catch (error) {
        studio.externalServerError = error;
      }
    }
    studio.modelSetup = result.setup || [];
    studio.modelDiscovery = result.discovery || null;
    studio.modelDirectory = result.model_directory || "ComfyUI/models/LLM/";
    studio.gpuMemory = status.gpu_memory;
    updatePromptResidency(status);
    const restoredModel = !selectedBeforeRefresh ? restoredModelAfterDiscovery(studio) : null;
    selectModel(
      restoredModel
      || studio.models.find((model) => model.id === selectedId)
      || (selectedBeforeRefresh?.family === "ollama" ? selectedBeforeRefresh : null)
      || (selectedBeforeRefresh?.family === "api" ? selectedBeforeRefresh : null)
      || restoredModelAfterDiscovery(studio),
      { preserveSettingsProvider: studio.root.classList.contains("is-settings-open") },
    );
    studio.preferencesRestoring = false;
    setGenerationState("idle", "", "");
    refreshGGUFRuntimeDiagnostics();
  } catch (error) {
    studio.preferencesRestoring = false;
    showToast(error.code || "Model scan failed", error.message, error.details);
  }
}

async function refreshOllama({ automatic = false } = {}) {
  if (studio.ollamaRefreshBusy) return;
  studio.ollamaRefreshBusy = true;
  clearTimeout(studio.ollamaPollTimer);
  studio.ollamaPollTimer = null;
  const control = studio.root.querySelector("[data-ollama-provider-control]");
  const refreshButton = control?.querySelector("[data-ollama-refresh]");
  if (refreshButton && !automatic) {
    refreshButton.disabled = true;
    refreshButton.textContent = "Checking…";
  }
  try {
    const status = await getOllamaStatus();
    studio.ollamaStatus = status;
    studio.ollamaError = status.error || null;
    studio.models = [...studio.models.filter((model) => model.family !== "ollama"), ...(status.compatible_models || [])];
    const model = ollamaModelForSettings();
    if (model && studio.settingsProvider === "ollama") selectModel(model);
    else renderInferenceSettings();
    if (!automatic && status.state !== "ready") {
      showToast(
        status.state === "not_installed" ? "Ollama is not installed" : "Ollama is not running",
        status.state === "not_installed"
          ? "Install the official Ollama app, then return here."
          : "Open the Ollama app, wait for its local service to start, then select Check now again.",
      );
    }
  } catch (error) {
    studio.ollamaStatus = { state: "error", running: false, compatible_models: [], error: { code: error.code, message: error.message } };
    studio.ollamaError = error;
    renderInferenceSettings();
    if (!automatic) showToast("Ollama check failed", error.message, error.details);
  } finally {
    studio.ollamaRefreshBusy = false;
    syncOllamaAutoDetection();
  }
}

function toggleRefine(open) {
  const panel = studio.root.querySelector("[data-refine-panel]");
  const outputPanel = studio.root.querySelector(".h3ps-output-panel");
  panel.hidden = !open;
  outputPanel.classList.toggle("is-refining", open);
  if (open) requestAnimationFrame(() => panel.querySelector("textarea").focus({ preventScroll: true }));
}

async function submitRefinement() {
  const panel = studio.root.querySelector("[data-refine-panel]");
  const submit = panel.querySelector("[data-refine-submit]");
  const instruction = panel.querySelector("textarea").value.trim();
  const output = studio.root.querySelector("[data-output]");
  if (submit.disabled) return;
  if (!instruction) {
    showToast("Add a revision note", "Tell the model what should change in the current prompt.");
    return;
  }
  if (!studio.selectedModel) {
    showToast("No prompt model selected", "Choose a local model, connect llama.cpp, or configure an API provider.");
    return;
  }
  if (!studio.selectedModel.runtime_ready) {
    showToast("Model setup is incomplete", studio.selectedModel.setup_message || `Missing: ${studio.selectedModel.missing_dependencies.join(", ")}.`);
    return;
  }
  if (!await inspectDirectRuntime()) return;

  const previousPrompt = output.value;
  const previousMeta = studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent;
  studio.activeRequestFamily = studio.selectedModel.family;
  studio.activeRequestModelId = studio.selectedModel.family === "ollama" ? studio.selectedModel.remote_model : studio.selectedModel.id;
  submit.disabled = true;
  submit.innerHTML = `<span class="h3ps-spinner"></span>Rewriting…`;
  setGenerationState("busy", "Refining prompt", studio.selectedModel.name.split("/").pop());
  try {
    const result = await refine(buildRefinePayload(studio, {
      currentPrompt: previousPrompt,
      instruction,
      creativeBrief: currentBriefTextarea().value.trim(),
      lyrics: studio.mode === "Music3" ? studio.root.querySelector("[data-music-lyrics]").value : "",
      seed: newGenerationSeed(),
    }));
    studio.refineRestore = {
      prompt: previousPrompt,
      meta: previousMeta,
      lastModelPrompt: studio.lastModelPrompt,
      lastModelMeta: studio.lastModelMeta,
    };
    output.value = result.prompt;
    studio.lastModelPrompt = result.prompt;
    renderPromptHighlights();
    panel.querySelector("textarea").value = "";
    panel.querySelector("[data-refine-restore]").hidden = false;
    studio.lastModelMeta = formatGenerationMeta(result);
    syncRuntimeSummary(result);
    studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.lastModelMeta;
    syncModifiedState();
    saveCurrentModeDraft();
    showToast(
      result.thinking_fallback ? "Rewrite completed" : "Prompt rewritten",
      result.thinking_fallback
        ? thinkingFallbackMessage(result, "rewrite")
        : result.format_repair_applied
          ? result.format_repair_multimodal
            ? `The first draft failed ${result.format_repair_reason}; the existing references were checked again and repaired once.`
            : `The first draft failed ${result.format_repair_reason}; its format was repaired once without media.`
        : result.format_repair_failure
          ? `Format warning: ${result.format_repair_reason}; safe repair rejected because ${result.format_repair_failure}.`
        : `${result.total_seconds.toFixed(1)}s · ${result.tokens_per_second.toFixed(1)} tok/s · no media re-upload`,
    );
  } catch (error) {
    if (error.code === "INSUFFICIENT_FREE_VRAM") showVramRetry(error, submitRefinement);
    else showToast(error.code || "Refinement failed", error.message, error.details);
  } finally {
    submit.disabled = false;
    submit.innerHTML = `${icon("spark", 13)} Rewrite`;
    try {
      const status = await getStatus();
      updatePromptResidency(status);
    } catch {}
    studio.activeRequestFamily = null;
    studio.activeRequestModelId = null;
    setGenerationState("idle", "", "");
  }
}

function createStudio() {
  if (studio) return studio;
  injectStyles();
  const studioBrandIcon = new URL("./assets/h3-prompt-writer-launcher.svg", import.meta.url).href;
  const root = document.createElement("div");
  root.className = "h3ps-root";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="h3ps-backdrop" data-close-studio></div>
    <section class="h3ps-modal" role="dialog" aria-modal="true" aria-label="H3 Prompt Writer">
      <header class="h3ps-header">
        <div class="h3ps-brand">
          <img class="h3ps-brandmark" src="${studioBrandIcon}" alt="H3 Prompt Writer">
          <span><strong>H3 Prompt Writer</strong></span>
        </div>
        <nav class="h3ps-workspaces" aria-label="Writer workspace">
          <button type="button" data-workspace="video">H3 Video</button>
          <button type="button" data-workspace="music">Music 3</button>
        </nav>
        <div class="h3ps-header-meta">
          <div class="h3ps-guide-picker">
            <button class="h3ps-guide-button" type="button" data-guide-toggle>Official guides ${icon("chevron", 13)}</button>
            <div class="h3ps-guide-menu" data-guide-menu hidden><span>Loading guides…</span></div>
          </div>
          <button class="h3ps-guide-button" type="button" data-open-settings-header>Settings</button>
          <button class="h3ps-icon-button" type="button" title="Close" data-close-studio>${icon("close", 18)}</button>
        </div>
      </header>

      ${settingsMarkup(icon)}

      <div class="h3ps-workspace-toolbar" data-generate-view>
        <nav class="h3ps-modes" aria-label="Generation mode" data-video-modes>
          ${Object.keys(MODES).map((mode) => `<button type="button" role="tab" data-mode="${mode}">${mode}</button>`).join("")}
        </nav>
        <div class="h3ps-output-toolbar">
          <span data-output-label>Generated prompt</span>
          <div class="h3ps-output-badges"><button type="button" data-undo-edits hidden>Undo</button></div>
        </div>
      </div>

      <div class="h3ps-workspace" data-generate-view>
        <section class="h3ps-input-panel">
          <div data-video-inputs>
          <div class="h3ps-section-heading">
            <span><small>Media</small><strong data-h3ps-mode-title></strong></span>
            <button class="h3ps-quiet-button" type="button" data-clear-media>Clear</button>
          </div>
          <p class="h3ps-section-hint" data-h3ps-mode-hint></p>
          <div class="h3ps-media" data-h3ps-media></div>

          <div class="h3ps-control-grid">
            <label class="h3ps-field h3ps-duration-field"><span>Duration <b data-duration-label>10 seconds</b></span><div><input type="range" min="1" max="20" step="1" value="10" style="--h3ps-range:47.37%" data-duration-slider><i></i></div></label>
            <label class="h3ps-field h3ps-choice"><span>Aspect ratio</span><button type="button" data-choice-toggle="aspect"><b data-aspect-label>16:9</b><em data-aspect-description>Widescreen</em>${icon("chevron", 13)}</button><div class="h3ps-choice-menu h3ps-aspect-menu" data-choice-menu="aspect" hidden>${ASPECT_RATIOS.map(([value, label]) => `<button type="button" data-aspect="${value}"><b>${value}</b><em>${label}</em></button>`).join("")}</div></label>
          </div>

          <label class="h3ps-brief">
            <span><strong>Creative brief</strong><small>Describe what should happen in the video</small></span>
            <textarea spellcheck="true" data-video-brief>Use identity and wardrobe from Picture 1 and the slow lateral camera movement from Video 1. A solitary character waits at a rain-soaked tram stop at blue hour, notices an approaching light and turns into the wind. End on a quiet, unresolved look; keep the shot cinematic, realistic and restrained.</textarea>
            <small class="h3ps-char-count">0 / 2,000</small>
          </label>
          </div>

          <div class="h3ps-music-inputs" data-music-inputs hidden>
            <label class="h3ps-brief">
              <span><strong>Music brief</strong><small>Describe the sound, vocals, mood, arrangement or production</small></span>
              <textarea spellcheck="true" data-music-brief>${MUSIC3_DEFAULT_DRAFT.brief}</textarea>
              <small class="h3ps-char-count">0 / 2,000</small>
            </label>
            <label class="h3ps-brief h3ps-lyrics">
              <span><strong>Lyrics</strong><small>Optional</small></span>
              <textarea spellcheck="true" maxlength="4000" data-music-lyrics placeholder="[Verse 1]&#10;...&#10;&#10;[Chorus]&#10;..."></textarea>
              <small class="h3ps-char-count">0 / 4,000</small>
            </label>
            <section class="h3ps-music-prompt-rules">
              <header>
                <span><strong>Prompt rules</strong><small data-system-prompt-status="music3">Default</small></span>
                <button type="button" data-music-prompt-toggle>Edit</button>
              </header>
              <div data-music-prompt-editor hidden>
                <textarea data-system-prompt="music3" maxlength="8000" spellcheck="true" disabled></textarea>
                <footer><small data-system-prompt-count="music3">0 / 8,000</small><button type="button" data-system-prompt-reset="music3" hidden>Restore default</button></footer>
              </div>
            </section>
          </div>

          ${generateModelSummaryMarkup(icon)}
        </section>

        <section class="h3ps-output-panel">
          <div class="h3ps-editor-wrap">
            <div class="h3ps-editor-highlight" data-prompt-highlights aria-hidden="true"></div>
            <textarea class="h3ps-editor" spellcheck="false" data-output>${SAMPLE_PROMPT}</textarea>
            <div class="h3ps-reference-peek" data-reference-peek hidden></div>
            <div class="h3ps-editor-meta"><span>${promptLengthMeta(SAMPLE_PROMPT)}</span></div>
          </div>
          <div class="h3ps-refine" data-refine-panel hidden>
            <div class="h3ps-refine-heading">
              <span><strong data-refine-title>Refine prompt</strong><small data-refine-helper>Describe only what should change</small></span>
              <em data-refine-media-note>No media re-upload</em>
            </div>
            <textarea rows="2" data-refine-instruction placeholder="For example: make the camera movement slower and keep the ending more ambiguous."></textarea>
            <div class="h3ps-refine-actions">
              <button type="button" class="h3ps-text-button" data-refine-restore hidden>Restore original</button>
              <span></span>
              <button type="button" class="h3ps-text-button" data-refine-cancel>Cancel</button>
              <button type="button" class="h3ps-refine-submit" data-refine-submit>${icon("spark", 13)} Rewrite</button>
            </div>
          </div>
          <div class="h3ps-output-actions">
            <span class="h3ps-output-primary-actions">
              <button class="h3ps-secondary-button" type="button" title="Refine with local LLM" data-refine-toggle>${icon("spark", 15)} Refine</button>
              <span class="h3ps-reference-insert" data-reference-insert hidden>
                <button class="h3ps-reference-insert-toggle" type="button" title="Insert reference" aria-label="Insert reference" aria-haspopup="menu" aria-expanded="false" data-reference-insert-toggle></button>
                <span class="h3ps-reference-insert-popover" data-reference-insert-popover role="menu" hidden></span>
              </span>
            </span>
            <button class="h3ps-secondary-button" type="button" data-copy>${icon("copy", 15)} <span data-copy-label>Copy prompt</span></button>
          </div>
        </section>
      </div>

      <footer class="h3ps-footer" data-generate-view>
        <div class="h3ps-footer-memory-actions">
          <button class="h3ps-memory-action" type="button" data-comfy-memory-action title="Unload models held by ComfyUI without clearing cached workflow results">${icon("memory", 15)}Free ComfyUI VRAM</button>
          <span class="h3ps-prompt-lifecycle-actions" data-prompt-lifecycle-actions></span>
        </div>
        <div class="h3ps-status is-busy" data-status hidden><span><strong></strong><small data-status-detail></small></span></div>
        <div class="h3ps-footer-actions">
          <span class="h3ps-generation-options">
            <label class="h3ps-toggle-control"><input type="checkbox" data-thinking><span></span>Thinking</label>
            <label class="h3ps-toggle-control" data-keep-loaded-control title="Keep the prompt model in VRAM for the next prompt"><input type="checkbox" data-keep-loaded><span></span>Keep model loaded</label>
          </span>
          <button class="h3ps-primary-button" type="button" data-generate>${icon("spark", 16)}<span data-generate-label>Generate prompt</span></button>
        </div>
      </footer>
    </section>

    <section class="h3ps-other-models-popover" data-other-models-popover hidden>
      <header><span><strong>Other verified models</strong><small>Recommended GGUF and projector pairs</small></span><button class="h3ps-icon-button" type="button" data-other-models-close>${icon("close", 16)}</button></header>
      <div class="h3ps-other-models-catalog" data-other-models-catalog></div>
    </section>

    <section class="h3ps-video-preview" data-h3ps-preview aria-hidden="true">
      <div class="h3ps-preview-backdrop" data-close-preview></div>
      <div class="h3ps-preview-dialog">
        <header><span><small>Video reference</small><strong data-preview-name>camera_motion.mp4</strong></span><button class="h3ps-icon-button" type="button" data-close-preview>${icon("close", 18)}</button></header>
        <div class="h3ps-video-stage"><video controls preload="metadata" data-preview-video></video></div>
        <div class="h3ps-sample-heading"><span><small>What the model sees</small><strong>Contact sheet</strong></span><div class="h3ps-sample-controls"><div class="h3ps-frame-count"><span>Frames</span><button type="button" data-frame-count="auto">Auto</button><button type="button" data-frame-count="4">4</button><button type="button" data-frame-count="6">6</button><button type="button" data-frame-count="8">8</button></div><label class="h3ps-endpoints"><input type="checkbox" data-include-endpoints checked>First & last</label><button type="button" data-resample>${icon("refresh", 14)} Resample</button></div></div>
        <div class="h3ps-contact-sheet"><img data-preview-sheet alt="Contact sheet sent to the local model"><span class="h3ps-sheet-updating"><i class="h3ps-spinner"></i>Updating…</span></div>
        <footer><span>${icon("check", 13)} Use for local analysis</span><small data-preview-sampling></small></footer>
      </div>
    </section>

    <section class="h3ps-image-preview" data-h3ps-image-preview aria-hidden="true">
      <div class="h3ps-preview-backdrop" data-close-image-preview></div>
      <div class="h3ps-image-preview-dialog">
        <header><span><small data-image-preview-reference>Picture reference</small><strong data-image-preview-name></strong></span><button class="h3ps-icon-button" type="button" data-close-image-preview>${icon("close", 18)}</button></header>
        <div class="h3ps-image-preview-stage"><img data-image-preview-image alt=""></div>
      </div>
    </section>

    <div class="h3ps-toast" data-h3ps-toast><span class="h3ps-toast-icon">${icon("info", 17)}</span><span><strong data-toast-title>Notice</strong><span data-toast-message></span><button type="button" class="h3ps-toast-action" data-toast-action hidden></button><details data-toast-details hidden><summary>Technical details</summary><pre></pre></details></span></div>`;
  document.body.appendChild(root);

  studio = { root, ...createStudioState({ sessionId: createSessionId(), storage: localStorage }) };
  const durationSlider = root.querySelector("[data-duration-slider]");
  durationSlider.value = String(studio.durationSeconds);
  durationSlider.style.setProperty("--h3ps-range", `${(studio.durationSeconds - 1) / 19 * 100}%`);
  root.querySelector("[data-duration-label]").textContent = `${studio.durationSeconds} seconds`;
  const restoredAspect = ASPECT_RATIOS.find(([value]) => value === studio.aspectRatio) || ASPECT_RATIOS.find(([value]) => value === "16:9");
  root.querySelector("[data-aspect-label]").textContent = restoredAspect[0];
  root.querySelector("[data-aspect-description]").textContent = restoredAspect[1];
  root.querySelectorAll("[data-close-studio]").forEach((el) => el.addEventListener("click", closeStudio));
  root.addEventListener("click", (event) => {
    if (studio.draftDefaultsArmed && !event.target.closest("[data-restore-default-drafts]")) disarmDraftDefaults();
    if (studio.toastDismissOnWorkspaceClick && !event.target.closest("[data-h3ps-toast]")) hideToast();
    if (!event.target.closest("[data-asset-menu], [data-asset-menu-toggle]")) {
      root.querySelectorAll("[data-asset-menu]").forEach((menu) => { menu.hidden = true; });
    }
    if (!event.target.closest("[data-other-models-toggle], [data-other-models-popover]")) setOtherModelsPopover(false);
    if (!isRuntimeMenuInteraction(event.target)) {
      root.querySelectorAll("[data-runtime-menu]").forEach((menu) => { menu.hidden = true; });
    }
    if (!isChoiceMenuInteraction(event.target)) {
      root.querySelectorAll("[data-choice-menu]").forEach((menu) => { menu.hidden = true; });
    }
    if (!isGuideMenuInteraction(event.target)) {
      root.querySelectorAll("[data-guide-menu]").forEach((menu) => { menu.hidden = true; });
    }
    if (!event.target.closest("[data-model-files-toggle], [data-model-files-menu]")) {
      root.querySelectorAll("[data-model-files-menu]").forEach((menu) => { menu.hidden = true; });
    }
    if (!event.target.closest("[data-reference-insert]")) closeReferenceInsert();
  });
  root.querySelectorAll("[data-close-preview]").forEach((el) => el.addEventListener("click", closeVideoPreview));
  root.querySelectorAll("[data-close-image-preview]").forEach((el) => el.addEventListener("click", closeImagePreview));
  root.querySelectorAll("[data-workspace]").forEach((button) => button.addEventListener("click", () => {
    const nextMode = button.dataset.workspace === "music" ? "Music3" : studio.lastVideoMode;
    if (nextMode === studio.mode) return;
    stashCurrentModeDraft();
    if (studio.mode !== "Music3") studio.lastVideoMode = studio.mode;
    studio.mode = nextMode;
    syncWorkspace();
    restoreModeDraft(studio.mode);
    renderMedia(studio.mode);
    syncRuntimeSummary();
    saveUserPreferences(localStorage, studio);
  }));
  root.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.mode === studio.mode) return;
    stashCurrentModeDraft();
    studio.mode = button.dataset.mode;
    studio.lastVideoMode = studio.mode;
    syncWorkspace();
    restoreModeDraft(studio.mode);
    renderMedia(studio.mode);
    syncRuntimeSummary();
    saveUserPreferences(localStorage, studio);
  }));
  root.querySelector("[data-open-settings-header]").addEventListener("click", () => setSettingsOpen(true));
  root.querySelector("[data-open-settings]").addEventListener("click", () => setSettingsOpen(true));
  root.querySelector("[data-close-settings]").addEventListener("click", () => setSettingsOpen(false));
  root.querySelector("[data-clear-media]").addEventListener("click", async () => {
    try {
      const result = await clearMedia(studio.sessionId, studio.mode);
      studio.assets = result.assets;
      closeVideoPreview();
      renderMedia(studio.mode);
      showToast("Media cleared", "The temporary session files were removed.");
    } catch (error) {
      showToast(error.code || "Clear failed", error.message, error.details);
    }
  });
  root.querySelector("[data-generate]").addEventListener("click", startGenerationPreview);
  root.querySelector("[data-restore-default-drafts]").addEventListener("click", restoreDefaultDrafts);
  root.querySelector("[data-comfy-memory-action]").addEventListener("click", () => releaseComfyVram());
  root.querySelector("[data-guide-toggle]").addEventListener("click", async () => {
    const menu = root.querySelector("[data-guide-menu]");
    menu.hidden = !menu.hidden;
    if (menu.hidden) return;
    if (studio.mode === "Music3") {
      menu.innerHTML = `<a href="${MUSIC3_GUIDE_URL}" target="_blank" rel="noopener noreferrer"><strong>Music Caption Rewriter</strong><small>Official MiniMax Music 3 guide</small></a>`;
      return;
    }
    try {
      if (!studio.guides.length) {
        const result = await getGuides();
        studio.guides = result.guides;
      }
      menu.innerHTML = studio.guides.map((guide) => `<a href="${escapeHtml(guide.source_url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(guide.filename)}</strong><small>${escapeHtml(guide.modes.join(" · "))}</small></a>`).join("");
    } catch (error) {
      showToast(error.code || "Guide unavailable", error.message, error.details);
    }
  });
  root.querySelectorAll("[data-choice-toggle]").forEach((button) => button.addEventListener("click", () => {
    const menu = root.querySelector(`[data-choice-menu="${button.dataset.choiceToggle}"]`);
    root.querySelectorAll("[data-choice-menu]").forEach((item) => { if (item !== menu) item.hidden = true; });
    menu.hidden = !menu.hidden;
  }));
  root.querySelector("[data-duration-slider]").addEventListener("input", (event) => {
    studio.durationSeconds = Number(event.target.value);
    root.querySelector("[data-duration-label]").textContent = `${studio.durationSeconds} seconds`;
    event.target.style.setProperty("--h3ps-range", `${(studio.durationSeconds - 1) / 19 * 100}%`);
    saveUserPreferences(localStorage, studio);
  });
  root.querySelectorAll("[data-runtime-toggle]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    const menu = root.querySelector(`[data-runtime-menu="${button.dataset.runtimeToggle}"]`);
    root.querySelectorAll("[data-runtime-menu]").forEach((item) => { if (item !== menu) item.hidden = true; });
    menu.hidden = !menu.hidden;
  }));
  root.querySelectorAll("[data-runtime-option]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    if (button.dataset.runtimeOption === "context") studio.contextProfile = button.dataset.value;
    else studio.kvCache = button.dataset.value;
    button.closest("[data-runtime-menu]").hidden = true;
    syncRuntimeSummary();
    syncThinkingAvailability();
    rememberRuntimePreferences();
    saveUserPreferences(localStorage, studio);
  }));
  syncRuntimeSummary();
  root.querySelectorAll("[data-system-prompt-profile]").forEach((button) => button.addEventListener("click", () => {
    setSystemPromptProfile(button.dataset.systemPromptProfile);
    setSystemPromptEditorOpen(true);
  }));
  root.querySelectorAll("[data-system-prompt-back]").forEach((button) => button.addEventListener("click", () => {
    setSystemPromptEditorOpen(false);
  }));
  root.querySelector("[data-music-prompt-toggle]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const editor = root.querySelector("[data-music-prompt-editor]");
    const opening = editor.hidden;
    if (opening) await syncSystemPromptEditor("music3");
    editor.hidden = !opening;
    button.textContent = opening ? "Done" : "Edit";
  });
  root.querySelectorAll("[data-system-prompt]").forEach((textarea) => textarea.addEventListener("input", () => {
    const profile = textarea.dataset.systemPrompt;
    const defaultPrompt = studio.systemPromptDefaults[profile] || "";
    if (textarea.value === defaultPrompt) delete studio.customSystemPrompts[profile];
    else studio.customSystemPrompts[profile] = textarea.value;
    saveCustomSystemPrompts(localStorage, studio.customSystemPrompts);
    const custom = Object.hasOwn(studio.customSystemPrompts, profile);
    const status = root.querySelector(`[data-system-prompt-status="${profile}"]`);
    const summaryStatus = root.querySelector(`[data-system-prompt-summary-status="${profile}"]`);
    if (status) status.textContent = custom ? "Custom" : "Default";
    if (summaryStatus) summaryStatus.textContent = custom ? "Custom" : "Default";
    root.querySelector(`[data-system-prompt-reset="${profile}"]`).hidden = !custom;
    root.querySelector(`[data-system-prompt-count="${profile}"]`).textContent = `${textarea.value.length.toLocaleString()} / 8,000`;
    resizeSystemPromptEditor(textarea);
  }));
  root.querySelectorAll("[data-system-prompt-reset]").forEach((button) => button.addEventListener("click", () => {
    const profile = button.dataset.systemPromptReset;
    delete studio.customSystemPrompts[profile];
    saveCustomSystemPrompts(localStorage, studio.customSystemPrompts);
    syncSystemPromptEditor(profile);
    showToast("System Prompt reset", profile === "music3"
      ? "Music 3 is using its complete built-in prompt rules."
      : `H3 Prompt Writer is using its default ${profile} instructions.`);
  }));
  root.querySelector("[data-thinking]").addEventListener("change", (event) => {
    studio.thinking = event.target.checked;
  });
  root.querySelector("[data-keep-loaded]").addEventListener("change", (event) => {
    studio.keepModelLoaded = event.target.checked;
  });
  const updateBriefCount = () => {
    updateBriefLayout();
    saveCurrentModeDraft();
  };
  root.querySelectorAll("[data-video-brief], [data-music-brief]").forEach((brief) => brief.addEventListener("input", updateBriefCount));
  root.querySelector("[data-music-lyrics]").addEventListener("input", () => {
    updateMusicLyricsCount();
    saveCurrentModeDraft();
  });
  root.querySelectorAll("[data-aspect]").forEach((button) => button.addEventListener("click", () => {
    studio.aspectRatio = button.dataset.aspect;
    const option = ASPECT_RATIOS.find(([value]) => value === studio.aspectRatio);
    root.querySelector("[data-aspect-label]").textContent = option[0];
    root.querySelector("[data-aspect-description]").textContent = option[1];
    root.querySelector('[data-choice-menu="aspect"]').hidden = true;
    saveUserPreferences(localStorage, studio);
  }));
  root.querySelectorAll("[data-provider-option]").forEach((button) => button.addEventListener("click", () => {
    selectSettingsProvider(button.dataset.providerOption);
  }));
  root.querySelector("[data-model-refresh]").addEventListener("click", async () => {
    await refreshModels();
    const count = localModels().length;
    showToast("Models refreshed", `${count} supported local model${count === 1 ? "" : "s"} found.`);
  });
  root.querySelector("[data-installed-model]").addEventListener("change", (event) => {
    selectModel(localModels().find((model) => model.id === event.target.value));
  });
  root.querySelector("[data-provider-detail]").addEventListener("click", (event) => {
    const apiPreset = event.target.closest("[data-api-preset]");
    if (apiPreset) {
      chooseApiProviderPreset(apiPreset.dataset.apiPreset);
      return;
    }
    const apiDisconnect = event.target.closest("[data-api-disconnect]");
    if (apiDisconnect) {
      disconnectConfiguredApiProvider();
      return;
    }
    const apiModelRefresh = event.target.closest("[data-api-model-refresh]");
    if (apiModelRefresh) {
      refreshApiProviderModels();
      return;
    }
    const ollamaRefresh = event.target.closest("[data-ollama-refresh]");
    if (ollamaRefresh) {
      refreshOllama();
      return;
    }
    const copyOllamaCommand = event.target.closest("[data-copy-ollama-command]");
    if (copyOllamaCommand) {
      const command = copyOllamaCommand.dataset.copyOllamaCommand;
      navigator.clipboard.writeText(command);
      showToast("Command copied", `${command} · paste it into Terminal or PowerShell.`);
      return;
    }
    const ollamaAddModel = event.target.closest("[data-ollama-add-model]");
    if (ollamaAddModel) {
      studio.ollamaAddModelOpen = !studio.ollamaAddModelOpen;
      renderInferenceSettings();
      return;
    }
    const copyDirectRuntimeCommand = event.target.closest("[data-copy-direct-runtime-command]");
    if (copyDirectRuntimeCommand) {
      const command = copyDirectRuntimeCommand.dataset.copyDirectRuntimeCommand;
      navigator.clipboard.writeText(command);
      showToast("Command copied", "Paste it into PowerShell or CMD from the ComfyUI portable folder.");
      return;
    }
    const externalDisconnect = event.target.closest("[data-external-server-disconnect]");
    if (externalDisconnect) {
      disconnectExternalServer();
      return;
    }
    const otherModelsToggle = event.target.closest("[data-other-models-toggle]");
    if (otherModelsToggle) {
      const popover = root.querySelector("[data-other-models-popover]");
      setOtherModelsPopover(popover.hidden);
      return;
    }
    const filesToggle = event.target.closest("[data-model-files-toggle]");
    if (filesToggle) {
      const menu = filesToggle.closest(".h3ps-model-files").querySelector("[data-model-files-menu]");
      root.querySelectorAll("[data-model-files-menu]").forEach((item) => { if (item !== menu) item.hidden = true; });
      menu.hidden = !menu.hidden;
      return;
    }
    const copyPath = event.target.closest("[data-copy-model-path]");
    if (copyPath) {
      navigator.clipboard.writeText(studio.modelDirectory || "ComfyUI/models/LLM/");
      showToast("Model path copied", studio.modelDirectory || "ComfyUI/models/LLM/");
      return;
    }
  });
  root.querySelector("[data-provider-detail]").addEventListener("change", (event) => {
    const apiModel = event.target.closest("[data-api-model]");
    if (apiModel) {
      const model = studio.apiProviderModels.find((item) => item.remote_model === apiModel.value);
      if (model) selectModel(model);
      return;
    }
    const select = event.target.closest("[data-ollama-model]");
    if (select) {
      const model = ollamaModels().find((item) => item.remote_model === select.value);
      if (model) selectModel(model);
    }
  });
  root.querySelector("[data-provider-detail]").addEventListener("submit", (event) => {
    const apiForm = event.target.closest("[data-api-provider-form]");
    if (apiForm) {
      event.preventDefault();
      connectConfiguredApiProvider(apiForm);
      return;
    }
    const form = event.target.closest("[data-external-server-form]");
    if (!form) return;
    event.preventDefault();
    connectExternalServer(form);
  });
  root.querySelector("[data-other-models-close]").addEventListener("click", () => setOtherModelsPopover(false));
  root.querySelector("[data-other-models-popover]").addEventListener("click", (event) => {
    const filesToggle = event.target.closest("[data-model-files-toggle]");
    if (!filesToggle) return;
    const menu = filesToggle.closest(".h3ps-model-files").querySelector("[data-model-files-menu]");
    root.querySelectorAll("[data-model-files-menu]").forEach((item) => { if (item !== menu) item.hidden = true; });
    menu.hidden = !menu.hidden;
  });
  root.querySelector(".h3ps-input-panel").addEventListener("scroll", () => setOtherModelsPopover(false));
  root.querySelector("[data-settings-view]").addEventListener("scroll", () => setOtherModelsPopover(false));
  window.addEventListener("resize", () => {
    updateBriefCount();
    if (!root.querySelector("[data-other-models-popover]").hidden) positionOtherModelsPopover();
  });
  root.querySelector("[data-refine-toggle]").addEventListener("click", () => toggleRefine(root.querySelector("[data-refine-panel]").hidden));
  root.querySelector("[data-refine-cancel]").addEventListener("click", () => toggleRefine(false));
  root.querySelector("[data-refine-submit]").addEventListener("click", submitRefinement);
  root.querySelector("[data-reference-insert-toggle]").addEventListener("pointerdown", (event) => event.preventDefault());
  root.querySelector("[data-reference-insert-toggle]").addEventListener("click", toggleReferenceInsert);
  root.querySelector("[data-reference-insert-popover]").addEventListener("pointerdown", (event) => event.preventDefault());
  root.querySelector("[data-reference-insert-popover]").addEventListener("click", (event) => {
    const option = event.target.closest("[data-insert-reference]");
    if (option) insertSelectedReference(option.dataset.insertReference);
  });
  root.querySelector("[data-refine-restore]").addEventListener("click", () => {
    if (studio.refineRestore == null) return;
    const output = root.querySelector("[data-output]");
    output.value = studio.refineRestore.prompt;
    studio.lastModelPrompt = studio.refineRestore.lastModelPrompt;
    studio.lastModelMeta = studio.refineRestore.lastModelMeta;
    renderPromptHighlights();
    root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.refineRestore.meta;
    studio.refineRestore = null;
    root.querySelector("[data-refine-restore]").hidden = true;
    syncModifiedState();
    saveCurrentModeDraft();
    showToast("Previous prompt restored", "The AI rewrite was discarded.");
  });
  root.querySelector("[data-undo-edits]").addEventListener("click", () => {
    if (typeof studio.lastModelPrompt !== "string") return;
    const output = root.querySelector("[data-output]");
    output.value = studio.lastModelPrompt;
    root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.lastModelMeta;
    renderPromptHighlights();
    syncModifiedState();
    saveCurrentModeDraft();
    showToast("Edits undone", "Restored the latest AI-generated prompt.");
  });
  root.querySelector("[data-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(root.querySelector("[data-output]").value);
      showToast(studio.mode === "Music3" ? "Caption copied" : "Prompt copied", studio.mode === "Music3" ? "The generated Music 3 caption is on your clipboard." : "The generated H3 prompt is on your clipboard.");
    } catch (error) {
      showToast("Copy failed", "Clipboard access was denied.", error.message);
    }
  });
  root.querySelector("[data-output]").addEventListener("input", () => {
    syncModifiedState();
    renderPromptHighlights();
    syncOutputLengthMeta();
    saveCurrentModeDraft();
    syncReferenceInsertControl();
  });
  root.querySelector("[data-output]").addEventListener("scroll", renderPromptHighlights);
  const editor = root.querySelector("[data-output]");
  const supportedReferenceEditors = root.querySelectorAll("[data-video-brief], [data-output], [data-refine-instruction]");
  supportedReferenceEditors.forEach((field) => {
    ["focus", "click", "keyup", "select", "input"].forEach((type) => field.addEventListener(type, () => rememberReferenceInsertTarget(field)));
  });
  const editorWrap = root.querySelector(".h3ps-editor-wrap");
  const peek = root.querySelector("[data-reference-peek]");
  editor.addEventListener("focus", () => {
    editorWrap.classList.add("is-editing");
    peek.hidden = true;
  });
  editor.addEventListener("blur", () => setTimeout(() => editorWrap.classList.remove("is-editing"), 80));
  root.querySelector("[data-prompt-highlights]").addEventListener("pointerover", (event) => {
    const mark = event.target.closest("[data-prompt-reference]");
    if (!mark || editorWrap.classList.contains("is-editing")) return;
    const reference = mark.dataset.promptReference;
    const asset = studio.assets.find((item) => item.reference === reference);
    if (!asset) return;
    const visual = asset.type === "audio"
      ? `<span class="h3ps-peek-audio">${icon("audio", 18)}</span>`
      : `<img src="${asset.preview_url}" alt="">`;
    peek.innerHTML = `${visual}<span><strong>${escapeHtml(reference)}</strong><small>${escapeHtml(asset.filename)}</small></span>`;
    const markRect = mark.getBoundingClientRect();
    const wrapRect = editorWrap.getBoundingClientRect();
    peek.style.left = `${Math.max(8, Math.min(markRect.left - wrapRect.left, wrapRect.width - 190))}px`;
    peek.style.top = `${Math.max(8, markRect.top - wrapRect.top - 62)}px`;
    peek.hidden = false;
  });
  root.querySelector("[data-prompt-highlights]").addEventListener("pointerout", (event) => {
    if (event.target.closest("[data-prompt-reference]")) peek.hidden = true;
  });
  root.querySelector("[data-prompt-highlights]").addEventListener("click", () => editor.focus());
  root.querySelector("[data-resample]").addEventListener("click", () => resampleCurrentVideo());
  root.querySelectorAll("[data-frame-count]").forEach((button) => button.addEventListener("click", () => {
    const asset = studio.assets.find((item) => item.id === studio.previewAssetId);
    if (!asset || button.dataset.frameCount === (asset.frame_count_mode || "auto")) return;
    resampleCurrentVideo({ frame_count: button.dataset.frameCount });
  }));
  root.querySelector("[data-include-endpoints]").addEventListener("change", (event) => {
    resampleCurrentVideo({ include_endpoints: event.target.checked });
  });
  syncWorkspace();
  restoreModeDraft(studio.mode);
  renderMedia(studio.mode);
  renderPromptHighlights();
  syncSystemPromptEditors();
  refreshModels();
  return studio;
}

function openStudio() {
  const current = createStudio();
  current.root.classList.add("is-open");
  current.root.setAttribute("aria-hidden", "false");
  document.body.classList.add("h3ps-modal-open");
}

function closeStudio() {
  if (!studio) return;
  setSettingsOpen(false);
  setOtherModelsPopover(false);
  closeVideoPreview();
  closeImagePreview();
  studio.root.classList.remove("is-open");
  studio.root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("h3ps-modal-open");
}

function installLauncher() {
  if (document.querySelector("[data-h3ps-launcher]")) return;
  document.querySelector("[data-h3ps-launcher-group]")?.remove();
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "h3ps-floating-launcher";
  launcher.dataset.h3psLauncher = "true";
  launcher.setAttribute("aria-label", "Open H3 Prompt Writer");
  launcher.title = "Open H3 Prompt Writer · drag to move";
  const launcherIcon = new URL("./assets/h3-prompt-writer-launcher.svg", import.meta.url).href;
  launcher.innerHTML = `<img src="${launcherIcon}" alt="H3 Prompt Writer">`;
  document.body.appendChild(launcher);

  const positionKey = "h3ps-launcher-position";
  const edgeGap = 10;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(value, maximum));
  const savePosition = (position) => localStorage.setItem(positionKey, JSON.stringify(position));
  const applyPosition = (position) => {
    const maxX = Math.max(edgeGap, window.innerWidth - launcher.offsetWidth - edgeGap);
    const maxY = Math.max(edgeGap, window.innerHeight - launcher.offsetHeight - edgeGap);
    const horizontalOffset = clamp(Number(position.horizontalOffset) || edgeGap, edgeGap, maxX);
    const verticalOffset = clamp(Number(position.verticalOffset) || edgeGap, edgeGap, maxY);
    launcher.style.left = position.horizontalAnchor === "left" ? `${horizontalOffset}px` : "auto";
    launcher.style.right = position.horizontalAnchor === "right" ? `${horizontalOffset}px` : "auto";
    launcher.style.top = position.verticalAnchor === "top" ? `${verticalOffset}px` : "auto";
    launcher.style.bottom = position.verticalAnchor === "bottom" ? `${verticalOffset}px` : "auto";
  };
  const positionFromRect = (rect) => {
    const horizontalAnchor = rect.left + rect.width / 2 <= window.innerWidth / 2 ? "left" : "right";
    const verticalAnchor = rect.top + rect.height / 2 <= window.innerHeight / 2 ? "top" : "bottom";
    return {
      version: 3,
      horizontalAnchor,
      verticalAnchor,
      horizontalOffset: Math.round(horizontalAnchor === "left" ? rect.left : window.innerWidth - rect.right),
      verticalOffset: Math.round(verticalAnchor === "top" ? rect.top : window.innerHeight - rect.bottom),
    };
  };

  let saved = JSON.parse(localStorage.getItem(positionKey) || "null");
  if (saved?.version === 3) {
    applyPosition(saved);
  } else if (saved) {
    // Reset absolute and early edge-relative positions to the intended first-run corner.
    saved = {
      version: 3,
      horizontalAnchor: "right",
      verticalAnchor: "bottom",
      horizontalOffset: 24,
      verticalOffset: 104,
    };
    applyPosition(saved);
    savePosition(saved);
  }
  let drag = null;
  launcher.addEventListener("pointerdown", (event) => {
    const rect = launcher.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
    launcher.setPointerCapture(event.pointerId);
  });
  launcher.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const x = Math.max(10, Math.min(event.clientX - drag.dx, window.innerWidth - launcher.offsetWidth - 10));
    const y = Math.max(10, Math.min(event.clientY - drag.dy, window.innerHeight - launcher.offsetHeight - 10));
    drag.moved ||= Math.abs(event.movementX) + Math.abs(event.movementY) > 1;
    launcher.style.left = `${x}px`;
    launcher.style.top = `${y}px`;
    launcher.style.right = "auto";
    launcher.style.bottom = "auto";
  });
  launcher.addEventListener("pointerup", (event) => {
    if (!drag) return;
    launcher.releasePointerCapture(event.pointerId);
    const rect = launcher.getBoundingClientRect();
    if (drag.moved) {
      saved = positionFromRect(rect);
      applyPosition(saved);
      savePosition(saved);
    }
    else openStudio();
    drag = null;
  });
  window.addEventListener("resize", () => {
    if (!saved || drag) return;
    applyPosition(saved);
  });
}

document.addEventListener("keydown", (event) => {
  if (!studio?.root.classList.contains("is-open")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (!studio.root.querySelector("[data-other-models-popover]").hidden) setOtherModelsPopover(false);
    else if (studio.root.querySelector("[data-h3ps-image-preview]").classList.contains("is-open")) closeImagePreview();
    else if (studio.root.querySelector("[data-h3ps-preview]").classList.contains("is-open")) closeVideoPreview();
    else closeStudio();
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (event.target.closest("[data-refine-panel]")) submitRefinement();
    else startGenerationPreview();
  }
});

app.registerExtension({
  name: EXTENSION_NAME,
  commands: [{ id: "h3-prompt-studio.open", label: "Open H3 Prompt Writer", function: openStudio }],
  menuCommands: [{ path: ["Extensions", "H3 Prompt Writer"], commands: ["h3-prompt-studio.open"] }],
  async setup() {
    injectStyles();
    installLauncher();
  },
});
