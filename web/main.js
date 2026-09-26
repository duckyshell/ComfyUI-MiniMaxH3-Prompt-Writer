import { referenceTextRemapper } from "./reference_labels.js";
import { draftFile, draftFilename, parseDraft } from "./draft_files.js";
import { createDesktopNotifications } from "./desktop_notifications.js";
import { promptHighlightMarkup } from "./prompt_highlights.js";
import { fitTextarea, generationButtonMarkup, sequenceNotificationOptions, aspectRatioMarkup, bindAspectRatio, splitMenuMarkup, setSplitMenuOpen, copyButtonMarkup } from "./writer_controls.js";
import { mediaVisualDescriptor } from "./media_visual.js";
import { createSequenceWorkspace } from "./sequence_workspace.js";
import { generateSequence, cancelSequence } from "./api/sequence.js";
import { app } from "/scripts/app.js";
import { selectProjector, cancel, clearMedia, diagnoseGGUFRuntime, disconnectApiProvider, freeComfyVram, generate, getApiProviderModels, getApiProviderPresets, getGuides, getModels, getOllamaStatus, getStatus, getSystemPrompt, probeApiProvider, probeExternalServer, refine, removeMedia, reorderMedia, unloadModel, uploadMedia } from "./api/h3studio.js";
import { comfyVramIsAlreadyEmpty, createSessionId, fileCountFromDataTransfer, insertReferenceAtCaret, isChoiceMenuInteraction, isGuideMenuInteraction, isRuntimeMenuInteraction, moveOntoTarget, replacementTargetForFileDrop, replaceEventListener, vramReleaseReachedTarget } from "./compat.js";
import { generateModelSummaryMarkup, settingsMarkup } from "./settings.js";
import {
  buildGeneratePayload,
  buildLyricsRefinePayload,
  buildRefinePayload,
  audioWasAdded,
  clearPromptDraft,
  createStudioState,
  isGenerationModeAvailable,
  isPersistedDraftMode,
  isTextOnlyDirectModel,
  DEFAULT_OLLAMA_HOST,
  INTERFACE_SIZES,
  loadOllamaModel,
  loadOllamaHost,
  loadUserPreferences,
  normalizeOllamaHost,
  saveApiProviderConfig,
  saveCustomSystemPrompts,
  saveExternalServerConfig,
  saveOllamaHost,
  saveOllamaModel,
  saveModeDrafts,
  saveUserPreferences,
  restoredModelAfterDiscovery,
  selectModelState,
} from "./studio_state.js";
import { autoVramControlMarkup, createVramHandoffCoordinator, installVramHandoff, isLocalOllamaHost, releaseComfyVramWhenIdle, unloadWriterModels } from "./vram_handoff.js";
import { createLazyMediaTool } from "./media_tools.js";

import { editMedia } from "./api/h3studio.js";

const EXTENSION_NAME = "minimax.h3.prompt.studio";
const LAUNCHER_SCHEMA_VERSION = "2";
const VRAM_HANDOFF_SUPPORTED = typeof app?.queuePrompt === "function";
const HOST_CAPABILITIES = { windowed: true, comfyMemory: VRAM_HANDOFF_SUPPORTED, workflowMedia: true, ...app.h3psHost };
const vramHandoffCoordinator = createVramHandoffCoordinator();
const INSTALLATION_GUIDE_URL = "https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/blob/main/docs/INSTALLATION.md";
const TROUBLESHOOTING_GUIDE_URL = "https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/blob/main/docs/TROUBLESHOOTING.md";
const MUSIC3_GUIDE_URL = "https://github.com/MiniMax-AI/MiniMax-Music3/tree/main/skills/music-caption-rewriter";

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
let workflowRevision = 0;
let mediaPanelRequest = 0;
let ggufRuntimeDiagnosticsPromise = null;
let referenceInsertTarget = null;
let studioReturnFocus = null;
let studioFocusEpoch = 0;

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

function syncMusicSystemPromptSummary() {
  if (!studio) return;
  const summary = studio.root.querySelector("[data-music-system-prompt-summary]");
  if (!summary) return;
  summary.textContent = Object.hasOwn(studio.customSystemPrompts, "music3")
    || Object.hasOwn(studio.customSystemPrompts, "music3_lyrics")
    ? "Custom"
    : "Default";
}

async function syncSystemPromptEditor(profile) {
  if (!studio) return;
  const textarea = studio.root.querySelector(`[data-system-prompt="${profile}"]`);
  if (!textarea) return;
  const status = studio.root.querySelector(`[data-system-prompt-status="${profile}"]`);
  const summaryStatus = studio.root.querySelector(`[data-system-prompt-summary-status="${profile}"]`);
  const reset = studio.root.querySelector(`[data-system-prompt-reset="${profile}"]`);
  const count = studio.root.querySelector(`[data-system-prompt-count="${profile}"]`);
  const requestMode = profile === "music3_lyrics" ? "Music3Lyrics" : profile === "music3" ? "Music3" : profile === "reference" ? "Reference" : "T2VA";
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
  syncMusicSystemPromptSummary();
}

function syncSystemPromptEditors() {
  return Promise.all([
    syncSystemPromptEditor("standard"),
    syncSystemPromptEditor("reference"),
    syncSystemPromptEditor("music3"),
    syncSystemPromptEditor("music3_lyrics"),
  ]);
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
  // The textarea scrollbar consumes layout width; the mirror has no scrollbar.
  layer.style.right = `${editor.offsetWidth - editor.clientWidth}px`;
  layer.innerHTML = promptHighlightMarkup(editor.value) + "\n";
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

const STYLE_MODULES = [
  "tokens",
  "themes/dark",
  "themes/light",
  "foundation",
  "shell",
  "workbench",
  "media",
  "composer",
  "editor",
  "floating-media",
  "settings",
  "models",
  "providers",
  "prompts",
  "overlays",
  "music",
  "responsive",
  "sequence",
];

function injectStyles() {
  for (const name of STYLE_MODULES) {
    if (document.querySelector(`link[data-h3ps-style="${name}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL(`./styles/${name}.css`, import.meta.url).href;
    link.dataset.h3psStyle = name;
    document.head.appendChild(link);
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
    pause: '<path d="M8 6v12M16 6v12" stroke-width="3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.35 5.65L20 14"/><path d="M20 7v4h-4"/>',
    memory: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5"/>',
    collapse: '<path d="M8 8H3V3m13 5h5V3M8 16H3v5m13-5h5v5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
    moon: '<path d="M20.2 15.3A8.5 8.5 0 0 1 8.7 3.8 8.5 8.5 0 1 0 20.2 15.3Z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="--h3ps-icon-size:${size}px" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}

function renderAsset(asset, index) {
  const destructiveDisabled = studio.requestBusy ? "disabled" : "";
  const tagDisabled = studio.requestBusy ? "disabled" : "";
  const draggable = studio.requestBusy ? "false" : "true";
  const visual = asset.type === "audio"
    ? `<div class="h3ps-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>`
    : asset.preview_url
      ? `<span class="h3ps-thumb-backdrop" style="background-image:url('${asset.preview_url}')"></span><img class="h3ps-real-thumb" src="${asset.preview_url}" alt="">`
      : `<div class="h3ps-thumb-art h3ps-tone-${asset.tone || "blue"}"><span></span></div>`;
  const overlay = asset.type === "video" ? `<span class="h3ps-play">${icon("play", 18)}</span>` : "";
  const duration = formatDuration(asset.duration);
  return `
    <div class="h3ps-asset" tabindex="0" role="group" aria-label="Media inspector" draggable="${draggable}" data-asset-index="${index}" data-asset-id="${asset.id}" data-replace-label="Replace ${escapeHtml(asset.reference || asset.filename)}">
      <span class="h3ps-asset-preview h3ps-${asset.type}">${visual}${overlay}</span>
      <span class="h3ps-asset-copy">
        <strong>${asset.reference ? `<button type="button" class="h3ps-media-tag is-${asset.type}" data-media-tag="${escapeHtml(asset.reference)}" ${tagDisabled} title="Insert reference at text cursor">${escapeHtml(asset.reference || asset.filename)}</button>` : "Trim required"}</strong>
        <small>${escapeHtml(asset.filename)}</small>
      </span>
      ${duration ? `<span class="h3ps-duration">${duration}</span>` : ""}
      <button class="h3ps-replace-asset" type="button" data-replace-asset="${asset.id}" title="Replace ${escapeHtml(asset.reference || asset.filename)}" aria-label="Replace ${escapeHtml(asset.reference || asset.filename)}" ${destructiveDisabled}>${icon("refresh", 12)}</button>
      <button class="h3ps-remove-asset" type="button" data-remove-asset="${asset.id}" title="Remove ${escapeHtml(asset.reference || asset.filename)}" aria-label="Remove ${escapeHtml(asset.reference || asset.filename)}" ${destructiveDisabled}>${icon("close", 12)}</button>
    </div>`;
}

function referenceComposerAssets() {
  return studio.assets.filter((asset) => asset.mode === "Reference" && mediaVisualDescriptor(asset));
}

function composerAddState() {
  const assets = studio.assets.filter((asset) => asset.mode === "Reference");
  const pictureCount = assets.filter((asset) => asset.type === "image").length;
  if (studio.requestBusy) return { allowed: false, message: "Wait for the current Writer request to finish." };
  if (pictureCount >= 9) return { allowed: false, message: "Remove a Picture before adding the composition." };
  if (assets.length >= 12) return { allowed: false, message: "Remove a reference before adding the composition." };
  return { allowed: true, reference: `<Picture ${pictureCount + 1}>` };
}

function syncComposerControl(mode = studio.mode) {
  const panel = studio.root.querySelector("[data-media-panel-action]");
  if (panel) {
    panel.disabled = !studio.assets.some(asset => ["image", "video", "audio"].includes(asset.type) && asset.content_url);
    panel.title = panel.disabled ? "Add media first" : "Open Media panel";
  }
  const button = studio.root.querySelector("[data-open-composer]");
  if (!button) return;
  const sources = mode === "Reference" ? referenceComposerAssets() : [];
  button.disabled = studio.requestBusy || !sources.length;
  button.title = mode !== "Reference" ? "Switch to Reference mode"
    : studio.requestBusy ? "Wait for the current request to finish"
    : sources.length ? `Compose a new Picture from ${sources.length} media source${sources.length === 1 ? "" : "s"}`
    : "Add a Picture or Video first";
}

async function addComposedPicture({ blob, width, height, mimeType, filename, sources }) {
  const file = new File([blob], filename, { type: mimeType });
  const result = await uploadMedia(studio.sessionId, "Reference", [file]);
  studio.sessionId = result.session_id;
  studio.assets = [...studio.assets, ...result.assets];
  studio.mediaFilter = studio.mediaFilter === "image" ? "image" : "all";
  renderMedia("Reference");
  const added = result.assets[0];
  showToast(
    `${added.reference} added`,
    `Composed from ${sources.length} source${sources.length === 1 ? "" : "s"} · ${width}×${height} PNG.`,
  );
}

function openMediaComposer(trigger) {
  if (studio.mode !== "Reference" || studio.requestBusy) return;
  const assets = referenceComposerAssets();
  if (!assets.length) return;
  setClearMenuOpen(false);
  studio.mediaComposer.open({ assets, trigger: studio.root.querySelector("[data-actions-menu-toggle]") });
}

function notifyMediaCompatibility() {
  const pending=studio.assets.filter(a=>a.status==="needs_edit");
  const total=studio.assets.filter(a=>a.mode==="Reference"&&a.type==="video"&&a.status!=="needs_edit").reduce((sum,a)=>sum+(a.duration||0),0);
  const signature=pending.map(a=>a.id).join("|")+":"+(total>15);
  if(signature===studio.mediaCompatibilityNotice)return;
  studio.mediaCompatibilityNotice=signature;
  const messages=[];
  if(pending.length)messages.push("Trim the video source to 2–15 seconds and Apply to use it as a reference.");
  if(total>15)messages.push("Reference videos exceed 15 seconds in total. Prompt generation is still available; check H3 compatibility.");
  if(messages.length)showToast("Reference media",messages.join(" "),null,null,{dismissOnWorkspaceClick:true});
}

function renderMedia(mode) {
  mode = studio.sequence?.mediaMode(mode) ?? mode;
  studio.floatingMedia?.refresh();
  if (mode === "Music3") {
    studio.root.querySelectorAll("[data-mode]").forEach((button) => button.classList.remove("is-active"));
    syncComposerControl(mode);
    syncModeAvailability();
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
  notifyMediaCompatibility();
  bindMediaActions(mode);
  syncComposerControl(mode);

  syncModeAvailability();
  studio.sequence?.refresh();
}

function setMusicSystemPromptProfile(profile) {
  if (!studio) return;
  studio.musicSystemPromptProfile = profile === "music3_lyrics" ? "music3_lyrics" : "music3";
  studio.root.querySelectorAll("[data-music-system-prompt-profile]").forEach((button) => {
    const selected = button.dataset.musicSystemPromptProfile === studio.musicSystemPromptProfile;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  studio.root.querySelectorAll("[data-music-system-prompt-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.musicSystemPromptPanel !== studio.musicSystemPromptProfile;
  });
  syncSystemPromptEditor(studio.musicSystemPromptProfile);
}

function setMusicSystemPromptEditorOpen(open) {
  if (!studio) return;
  studio.root.querySelector("[data-music-system-prompt-overview]").hidden = open;
  studio.root.querySelector("[data-music-system-prompt-editor]").hidden = !open;
}

function setMusicSystemPromptExpanded(open) {
  if (!studio) return;
  studio.musicSystemPromptExpanded = open;
  const toggle = studio.root.querySelector("[data-music-system-prompt-toggle]");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.classList.toggle("is-open", open);
  studio.root.querySelector("[data-music-system-prompt-details]").hidden = !open;
  if (!open) setMusicSystemPromptEditorOpen(false);
}

function rememberReferenceInsertTarget(editor) {
  if (!studio || studio.mode === "Music3" || !editor) return;
  referenceInsertTarget = { editor, caret: editor.selectionStart ?? editor.value.length };
}

function insertSelectedReference(reference, assetId) {
  if (studio.sequence?.insert(assetId)) return;
  if (studio.mode === "Music3") return;
  const fallback = studio.root.querySelector("[data-output]");
  const target = referenceInsertTarget?.editor?.isConnected ? referenceInsertTarget : { editor: fallback, caret: fallback.selectionStart };
  target.editor.setSelectionRange(target.caret, target.caret);
  if (insertReferenceAtCaret(target.editor, reference, target.caret)) {
    rememberReferenceInsertTarget(target.editor);
  }
}

function acceptMediaAssets(assets) {
  const rewrite = referenceTextRemapper(studio.assets, assets);
  let missing = false;
  const remap = text => {
    const next = rewrite(text);
    if (next !== text && /<Missing (Picture|Video|Audio) [1-9]\d*>/.test(next)) missing = true;
    return next;
  };
  const saved = studio.modeDrafts.Reference;
  if (saved) studio.modeDrafts.Reference = {...saved, brief:remap(saved.brief), prompt:remap(saved.prompt)};
  // Sequence owns request-local labels. Only the separate Single draft is rewritten.
  if (studio.mode === "Reference") {
    for (const selector of ["[data-video-brief]", "[data-output]", "[data-refine-instruction]"]) {
      const input = studio.root.querySelector(selector), next = remap(input.value);
      if (next !== input.value) input.value = next;
    }
    studio.lastModelPrompt = remap(studio.lastModelPrompt);
    if (studio.lastModelPrompt != null) studio.lastModelMeta = promptLengthMeta(studio.lastModelPrompt);
    if (studio.refineRestore) {
      studio.refineRestore.prompt = remap(studio.refineRestore.prompt);
      studio.refineRestore.lastModelPrompt = remap(studio.refineRestore.lastModelPrompt);
      studio.refineRestore.meta = promptLengthMeta(studio.refineRestore.prompt);
      if (studio.refineRestore.lastModelPrompt != null) studio.refineRestore.lastModelMeta = promptLengthMeta(studio.refineRestore.lastModelPrompt);
    }
    studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent = promptLengthMeta(studio.root.querySelector("[data-output]").value);
    updateBriefLayout(); renderPromptHighlights(); syncModifiedState(); saveCurrentModeDraft();
  } else saveModeDrafts(localStorage, studio.modeDrafts);
  studio.assets = assets;
  if (missing) showToast("Reference removed", "Missing media tags are marked in your Single text. Replace or remove them before Generate or Refine.");
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
    button.addEventListener("keydown",event=>{
      if(event.target===button && ["Enter"," "].includes(event.key)){event.preventDefault();button.click();}
    });
    button.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      const asset = studio.assets.find((item) => item.id === button.dataset.assetId);
      if(asset.type === "image" || asset.type === "video"){if(!studio.requestBusy)studio.mediaEditor.open(asset,button);}
      else previewAsset(asset);
    });
  });
  studio.root.querySelectorAll("[data-replace-asset]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      button.blur();
      chooseMedia(mode, button.dataset.replaceAsset);
    });
  });
  studio.root.querySelectorAll("[data-media-tag]").forEach(button=>{
    button.addEventListener("pointerdown",e=>e.preventDefault());
    button.addEventListener("click",e=>{e.stopPropagation();if(!studio.requestBusy)insertSelectedReference(button.dataset.mediaTag,button.closest("[data-asset-id]")?.dataset.assetId);});
  });
  studio.root.querySelectorAll("[data-remove-asset]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        const result = await removeMedia(studio.sessionId, button.dataset.removeAsset);
        acceptMediaAssets(result.assets);
        renderMedia(studio.mode);
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
      const ghost = document.createElement("canvas");
      ghost.width = ghost.height = 1;
      ghost.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
      studio.root.appendChild(ghost);
      studio.dragGhost = ghost;
      event.dataTransfer.setDragImage(ghost, 0, 0);
      requestAnimationFrame(() => card.classList.add("is-dragging"));
    });
    card.addEventListener("dragend", () => {
      studio.draggedAssetId = null;
      media.classList.remove("is-reordering");
      studio.dragGhost?.remove();
      studio.dragGhost = null;
      studio.root.querySelectorAll(".is-dragging, .is-drop-before, .is-drop-after, .is-file-replace-target").forEach((item) => item.classList.remove("is-dragging", "is-drop-before", "is-drop-after", "is-file-replace-target"));
    });
    card.addEventListener("dragover", (event) => {
      if (!studio.draggedAssetId && [...(event.dataTransfer.types || [])].includes("Files")) {
        event.preventDefault();
        studio.root.querySelectorAll(".is-file-replace-target").forEach((item) => item.classList.remove("is-file-replace-target"));
        if (replacementTargetForFileDrop(card.dataset.assetId, fileCountFromDataTransfer(event.dataTransfer))) {
          card.classList.add("is-file-replace-target");
        }
        event.dataTransfer.dropEffect = "copy";
        return;
      }
      if (!studio.draggedAssetId || studio.draggedAssetId === card.dataset.assetId) return;
      studio.root.querySelectorAll(".is-drop-before, .is-drop-after").forEach((item) => item.classList.remove("is-drop-before", "is-drop-after"));
      const modeAssets = studio.assets.filter((asset) => asset.mode === mode);
      const sourceIndex = modeAssets.findIndex((asset) => asset.id === studio.draggedAssetId);
      const targetIndex = modeAssets.findIndex((asset) => asset.id === card.dataset.assetId);
      const after = sourceIndex < targetIndex;
      card.classList.add(after ? "is-drop-after" : "is-drop-before");
    });
    card.addEventListener("dragleave", (event) => {
      if (!card.contains(event.relatedTarget)) card.classList.remove("is-file-replace-target");
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
    studio.root.querySelectorAll(".is-file-replace-target").forEach((item) => item.classList.remove("is-file-replace-target"));
    if (sourceId) {
      if (!targetId || sourceId === targetId) return;
      const modeAssets = studio.assets.filter((asset) => asset.mode === mode);
      const reorderedAssets = moveOntoTarget(modeAssets, sourceId, targetId);
      try {
        const result = await reorderMedia(studio.sessionId, mode, reorderedAssets.map((asset) => asset.id));
        acceptMediaAssets(result.assets);
        renderMedia(studio.mode);
      } catch (error) {
        showToast(error.code || "Reorder failed", error.message, error.details);
      }
      return;
    }
    const files = [...event.dataTransfer.files];
    uploadFiles(mode, files, replacementTargetForFileDrop(targetId, files.length));
  });
}

function previewAsset(asset) {
  if (!asset) return;
  showToast(asset.reference, `${formatDuration(asset.duration)} audio reference loaded.`);
}

function chooseMedia(mode, replaceAssetId = null) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = !replaceAssetId && (mode === "Reference" || mode === "FL2VA");
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
    hideToast();
    if (replaceAssetId) acceptMediaAssets(result.assets);
    else studio.assets = [...studio.assets, ...result.assets];
    if (audioWasAdded(previousAssets, studio.assets)) {
      showToast(
        "Audio added",
        "The prompt model can't hear audio files. Describe how the audio references should be used in the Creative Brief.",
        null,
        null,
        { durationMs: 6000 },
      );
    }
    renderMedia(studio.mode);
  } catch (error) {
    renderMedia(studio.mode);
    showToast(error.code || "Upload failed", error.message, error.details);
  }
}

function showToast(title, message, details = null, action = null, options = {}) {
  const toast = studio.root.querySelector("[data-h3ps-toast]");
  const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : null;
  const dismissOnWorkspaceClick = options.dismissOnWorkspaceClick === true
    || (details != null && durationMs == null);
  const dismissGeneration = (studio.toastDismissGeneration || 0) + 1;
  studio.toastDismissGeneration = dismissGeneration;
  studio.toastDismissOnWorkspaceClick = false;
  setTimeout(() => {
    if (
      studio.toastDismissGeneration === dismissGeneration
      && toast.classList.contains("is-visible")
    ) {
      studio.toastDismissOnWorkspaceClick = dismissOnWorkspaceClick;
    }
  }, 0);
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

async function copyPromptText(text, music = false) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(music ? "Caption copied" : "Prompt copied", music ? "The generated Music 3 caption is on your clipboard." : "The generated H3 prompt is on your clipboard.");
  } catch (error) {
    showToast("Copy failed", "Clipboard access was denied.", error.message);
  }
}

function setClearMenuOpen(open) {
  if (!studio) return;
  setSplitMenuOpen(studio.root.querySelector("[data-clear-control]"), open);
}

function clearCurrentPrompts({ notify = true } = {}) {
  if (!studio || studio.requestBusy) return false;
  const draft = clearPromptDraft(currentDraftFields());
  const output = studio.root.querySelector("[data-output]");
  currentBriefTextarea().value = draft.brief;
  output.value = draft.prompt;
  studio.lastModelPrompt = null;
  studio.lastModelMeta = null;
  studio.refineRestore = null;
  studio.root.querySelector("[data-refine-restore]").hidden = true;
  toggleRefine(false);

  studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent = promptLengthMeta(output.value);
  updateBriefLayout();
  renderPromptHighlights();
  syncModifiedState();

  saveCurrentModeDraft();
  if (notify) {
    const detail = studio.mode === "Music3"
      ? "The Music Brief and generated caption were cleared. Lyrics and media were kept."
      : "The Creative Brief and generated prompt were cleared. Media was kept.";
    showToast("Prompts cleared", detail);
  }
  return true;
}

async function clearCurrentMedia({ notify = true } = {}) {
  if (!studio || studio.requestBusy) return false;
  try {
    const result = await clearMedia(studio.sessionId, studio.sequence?.mediaMode(studio.mode) ?? studio.mode);
    studio.assets = result.assets;


    renderMedia(studio.mode);
    if (notify) showToast("Media cleared", "The temporary session files were removed.");
    return true;
  } catch (error) {
    showToast(error.code || "Clear failed", error.message, error.details);
    return false;
  }
}

async function clearEverything() {
  const mode = studio.mode;
  const submittedDraft = currentDraftFields();
  if (!await clearCurrentMedia({ notify: false })) return;
  const currentDraft = currentDraftFields();
  if (studio.mode !== mode || currentDraft.brief !== submittedDraft.brief || currentDraft.prompt !== submittedDraft.prompt) {
    showToast("Media cleared", "Your current prompts were kept because the workspace changed.");
    return;
  }
  clearCurrentPrompts({ notify: false });
  const detail = studio.mode === "Music3"
    ? "Media, Music Brief and generated caption were removed. Lyrics were kept."
    : "Media, Creative Brief and generated prompt were removed.";
  showToast("Everything cleared", detail);
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

function saveTextDraft() {
  if (studio.requestBusy) return;
  try {
    const sequence = studio.sequence.active;
    const mode = sequence ? "Reference" : studio.mode;
    const media = studio.assets.filter(a => a.mode === mode).map(a => `${a.reference || a.type}: ${a.filename}`);
    if (sequence) {
      const state = studio.sequence.state, name = id => studio.assets.find(a => a.id === id)?.filename || "Missing media";
      if (state.first) media.push(`First frame: ${name(state.first)}`);
      if (state.last) media.push(`Last frame: ${name(state.last)}`);
      state.references.forEach(id => media.push(`Sequence reference: ${name(id)}`));
      state.chunks.forEach((c,i) => {
        c.additions.forEach(id => media.push(`Chunk ${i+1} reference: ${name(id)}`));
        c.exclusions.forEach(id => media.push(`Chunk ${i+1} excludes: ${name(id)}`));
      });
    }
    const profile = mode === "Reference" ? "reference" : "standard";
    const value = draftFile(sequence ? "sequence" : "single", sequence ? studio.sequence.state : {
      mode, ...currentDraftFields(), duration:studio.durationSeconds, aspectRatio:studio.aspectRatio,
      instructions:studio.customSystemPrompts[profile] ?? null,
    }, media);
    const blob = new Blob([JSON.stringify(value,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href=url; link.download=draftFilename(value.kind); link.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  } catch(error) { showToast("Save draft", error.message); }
}

async function loadTextDraft(value) {
  if (studio.requestBusy) return;
  const owner = studio;
  let loaded = false;
  const mode = value.kind === "sequence" ? "Reference" : value.content.mode;
  setGenerationState("busy", "Loading draft", "");
  try {
    // Remove this mode's old references so identical labels cannot bind to unrelated media.
    const result = await clearMedia(studio.sessionId, mode);
    if (studio !== owner) return;
    studio.assets = result.assets;
    stashCurrentModeDraft();
    if (value.kind === "sequence") {
      studio.mode = "Reference"; studio.lastVideoMode = "Reference"; syncWorkspace();
      studio.sequence.loadDraft(value.content);
    } else {
      studio.sequence.setActive(false);
      studio.mode=mode; studio.lastVideoMode=mode;
      studio.durationSeconds=value.content.duration; studio.aspectRatio=value.content.aspectRatio; studio.aspectControl.update(studio.aspectRatio);
      studio.modeDrafts[mode]={brief:value.content.brief,prompt:value.content.prompt};
      const profile=mode === "Reference" ? "reference" : "standard";
      if(value.content.instructions === null) delete studio.customSystemPrompts[profile];
      else studio.customSystemPrompts[profile]=value.content.instructions;
      saveCustomSystemPrompts(localStorage,studio.customSystemPrompts);
      saveModeDrafts(localStorage,studio.modeDrafts); saveUserPreferences(localStorage,studio);
      studio.root.querySelector("[data-duration-slider]").value=String(studio.durationSeconds);
      studio.root.querySelector("[data-duration-slider]").dispatchEvent(new Event("input"));
      syncWorkspace(); restoreModeDraft(mode); syncSystemPromptEditors();
    }
    renderMedia(studio.mode);
    loaded = true;
    showToast("Draft loaded", "Media is not included. Reattach and assign the original references before generating.", value.media.length ? {references:value.media} : null);
  } catch(error) { showToast("Load draft",error.message); }
  finally {
    if (studio === owner) {
      setGenerationState("idle", "", "");
      if (loaded && value.kind === "sequence") studio.sequence.setActive(true);
    }
  }
}

function updateBriefLayout() {
  if (!studio) return;
  const brief = currentBriefTextarea();
  const compactHeight = window.innerHeight <= 800;
  const largeCanvas = window.innerWidth >= 3000 && window.innerHeight >= 1600;
  const minimumHeight = compactHeight ? 80 : largeCanvas ? 125 : 105;
  const counter = brief.closest(".h3ps-brief").querySelector(".h3ps-char-count");
  counter.textContent = `${brief.value.length.toLocaleString()}${studio.mode === "Music3" ? " / 2,000" : " characters"}`;
  fitTextarea(brief, minimumHeight, 2);
  brief.style.overflowY = "hidden";
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
  studio.lyricsRestore = null;
  studio.root.querySelector("[data-lyrics-refine-restore]").hidden = true;
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
  const outputLabel = music ? "Generated caption" : "Generated prompt";
  studio.root.querySelector("[data-output-label]").textContent = outputLabel;
  studio.root.querySelector("[data-output-mobile-label]").textContent = outputLabel;
  studio.root.querySelector("[data-output]").setAttribute("aria-label", outputLabel);
  studio.root.querySelector("[data-copy-label]").textContent = music ? "Copy caption" : "Copy prompt";
  studio.root.querySelector("[data-generate-label]").textContent = music ? "Generate caption" : "Generate prompt";
  studio.root.querySelector("[data-refine-media-note]").textContent = music ? "Lyrics stay separate" : "No media re-upload";
  studio.root.querySelector("[data-refine-title]").textContent = music ? "Refine caption" : "Refine prompt";
  studio.root.querySelector("[data-refine-helper]").textContent = music ? "Describe the musical change" : "Describe only what should change";
  studio.root.querySelector("[data-refine-instruction]").placeholder = music
    ? "For example: keep the verses sparse and let the final chorus open wider."
    : "For example: make the camera movement slower and keep the ending more ambiguous.";
  if (studio.mode !== "Music3") rememberReferenceInsertTarget(studio.root.querySelector("[data-output]"));
  else referenceInsertTarget = null;

  if (music) {
    syncSystemPromptEditor("music3");
    syncSystemPromptEditor("music3_lyrics");
  } else {
    toggleLyricsRefine(false);
    setMusicSystemPromptExpanded(false);
  }
  syncModeAvailability();
}

function syncModeAvailability() {
  if (!studio?.root) return;
  const textOnlyDirect = isTextOnlyDirectModel(studio.selectedModel);
  studio.root.querySelectorAll("[data-mode]").forEach((control) => {
    const unavailable = !isGenerationModeAvailable(studio.selectedModel, control.dataset.mode);
    control.disabled = studio.requestBusy || unavailable;
    control.setAttribute("aria-disabled", String(control.disabled));
    control.title = unavailable && textOnlyDirect
      ? "This Direct GGUF is text-only. Add its matching mmproj to enable visual modes."
      : "";
  });
  studio.root.querySelectorAll("[data-workspace]").forEach((control) => {
    control.disabled = studio.requestBusy;
    control.setAttribute("aria-disabled", String(control.disabled));
    control.title = "";
  });
}

function generationModeIsAvailable() {
  if (isGenerationModeAvailable(studio.selectedModel, studio.mode)) return true;
  showToast(
    "Text-only Direct GGUF",
    "Use T2VA or Music3, or add the matching mmproj to enable visual modes.",
  );
  return false;
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
  const wasBusy = studio.requestBusy;
  studio.requestBusy = busy;
  syncModeAvailability();
  studio.root.querySelectorAll("[data-draft-save], [data-draft-load], [data-clear-media], [data-clear-menu-toggle], [data-actions-menu-toggle], [data-clear-action]").forEach((control) => { control.disabled = busy; });
  if (busy) setClearMenuOpen(false);
  studio.root.querySelector("[data-lyrics-refine-toggle]").disabled = busy;
  const comfyMemory = studio.root.querySelector("[data-comfy-memory-action]");
  comfyMemory.disabled = busy || !HOST_CAPABILITIES.comfyMemory;
  comfyMemory.title = busy
    ? "Available after the active Writer request finishes"
    : "Unload models held by ComfyUI without clearing cached workflow results";
  button.classList.toggle("is-cancel", busy);
  if (!busy || !wasBusy) button.innerHTML = generationButtonMarkup(icon, busy, studio.mode === "Music3" ? "Generate caption" : "Generate prompt");
  renderMedia(studio.mode);
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
    external: Array.isArray(residency.external?.targets) ? residency.external.targets : [],
    ollama: Array.isArray(residency.ollama?.models) ? residency.ollama.models.filter(Boolean) : [],
  };
}

function selectedModelSupportsVramHandoff() {
  const model = studio?.selectedModel;
  return ["gguf", "external"].includes(model?.family)
    || (model?.family === "ollama" && isLocalOllamaHost(studio.ollamaHost));
}

function vramHandoffIsEnabled() {
  if (!VRAM_HANDOFF_SUPPORTED) return false;
  if (studio) return studio.vramHandoff;
  const preferences = loadUserPreferences(localStorage);
  return preferences?.vram_handoff === true;
}

function vramHandoffOllamaHost() {
  return studio?.ollamaHost || loadOllamaHost(localStorage);
}

function writerAutoVramApplies() {
  return vramHandoffIsEnabled() && selectedModelSupportsVramHandoff();
}

function writerAttemptIsCurrent(token) {
  return token == null || vramHandoffCoordinator.isWriterAttemptCurrent(token);
}

async function prepareWriterVram(token) {
  if (token == null) return true;
  studio.vramHandoffInFlight = true;
  setGenerationState("busy", "Freeing VRAM", "Preparing ComfyUI memory for the prompt model");
  try {
    await releaseComfyVramWhenIdle({
      getStatus,
      freeComfyVram,
      ollamaHost: studio.ollamaHost,
      isCurrent: () => writerAttemptIsCurrent(token),
      onStatus: (status) => {
        studio.gpuMemory = status.gpu_memory || studio.gpuMemory;
        updatePromptResidency(status);
      },
    });
    return writerAttemptIsCurrent(token);
  } catch (error) {
    if (error.code !== "WRITER_PREPARATION_CANCELLED") {
      showToast("Auto VRAM could not prepare memory", error.message, error.details);
    }
    setGenerationState("idle", "", "");
    return false;
  } finally {
    studio.vramHandoffInFlight = false;
  }
}

async function prepareWriterRequest() {
  const token = writerAutoVramApplies() ? vramHandoffCoordinator.beginWriterAttempt() : null;
  if (!await inspectDirectRuntime() || !writerAttemptIsCurrent(token)) return false;
  if (!await prepareWriterVram(token)) return false;
  if (writerAttemptIsCurrent(token)) return true;
  setGenerationState("idle", "", "");
  return false;
}

function markActiveWriterRequest() {
  studio.activeRequestFamily = studio.selectedModel.family;
  studio.activeRequestModelId = studio.selectedModel.family === "ollama" ? studio.selectedModel.remote_model : studio.selectedModel.id;
  studio.activeRequestOllamaHost = studio.selectedModel.family === "ollama" ? studio.ollamaHost : null;
}

function clearActiveWriterRequest() {
  studio.activeRequestFamily = null;
  studio.activeRequestModelId = null;
  studio.activeRequestOllamaHost = null;
}

async function unloadWriterModelsBeforeQueue(signal) {
  const ollamaHost = vramHandoffOllamaHost();
  const activeRequest = vramHandoffCoordinator.activeWriterRequest();
  const activeFamily = studio?.activeRequestFamily;
  const activeLocal = activeFamily === "gguf"
    || (activeFamily === "external" && studio?.selectedModel?.lifecycle_supported)
    || (activeFamily === "ollama" && isLocalOllamaHost(studio?.activeRequestOllamaHost || ollamaHost));
  const requiredTargets = [];
  if (activeRequest && activeLocal) {
    const target = {
      family: activeFamily,
      model_id: studio.activeRequestModelId,
      ollama_host: activeFamily === "ollama" ? (studio.activeRequestOllamaHost || ollamaHost) : null,
    };
    if(activeFamily === "external") requiredTargets.push(target);
    const result = await unloadModel(target);
    if (result?.unload_requested === false) throw new Error("Prompt Writer could not stop and unload its local model.");
    try { await activeRequest; } catch {}
  }
  signal?.throwIfAborted();
  await unloadWriterModels({
    signal,
    requiredTargets,
    getStatus,
    unloadModel,
    ollamaHost,
    onStatus: (status) => { if (studio) updatePromptResidency(status); },
  });
  if (studio) syncLifecycleActions();
}

function showVramHandoffQueueError(error) {
  const message = error.message || "Prompt Writer could not release its local model.";
  if (studio?.root.classList.contains("is-open")) {
    showToast("Queue continuing without VRAM release", message, error.details);
  } else {
    app.extensionManager?.toast?.add({severity:"warn", summary:"Auto VRAM: Queue continuing", detail:message, life:8000});
  }
}

function lifecycleTargets() {
  const targets = [];
  if (studio.promptResidency.direct) targets.push({ family: "gguf", modelId: studio.promptResidency.direct.modelId });
  studio.promptResidency.ollama.forEach((modelId) => targets.push({ family: "ollama", modelId, endpoint: studio.ollamaHost }));
  const selected = studio.selectedModel;
  const external = (studio.promptResidency.external || []).filter(t => t.writer_owned || t.model_id === selected?.id);
  if (selected?.family === "external" && selected.lifecycle_supported && !external.some(t => t.model_id === selected.id)) {
    external.push({model_id:selected.id, state:"unknown", writer_owned:false});
  }
  external.forEach(target => targets.push({family:"external", modelId:target.model_id, state:target.state, writerOwned:target.writer_owned}));
  return targets;
}

function lifecycleButtonMarkup(target, { stop = false } = {}) {
  const provider = target.family === "external" ? "external" : target.family === "ollama" ? "ollama" : "direct";
  const disabled = target.family === "external" && (["loading","unloading","unloaded"].includes(target.state) || (target.state === "unknown" && !target.writerOwned));
  const label = target.state === "unloading" ? "Unloading…" : target.state === "loading" ? "Loading…" : stop ? "Stop & unload" : target.family === "external" ? "Unload" : target.family === "ollama" ? "Unload Ollama" : "Unload Direct";
  const title = stop
    ? "Cancel the active request and unload its prompt model"
    : `Unload ${target.modelId || (target.family === "ollama" ? "the Ollama model" : "the Direct model")}`;
  return `<button class="h3ps-memory-action h3ps-prompt-lifecycle-action" type="button" data-lifecycle-family="${target.family}" ${disabled ? "disabled" : ""} ${target.modelId ? `data-lifecycle-model="${escapeHtml(target.modelId)}"` : ""} data-lifecycle-stop="${stop}" title="${escapeHtml(title)}"><span class="h3ps-provider-icon" data-provider-icon="${provider}" aria-hidden="true"></span>${label}</button>`;
}

function syncLifecycleActions() {
  const slot = studio.root.querySelector("[data-prompt-lifecycle-actions]");
  const directStatus = studio.root.querySelector("[data-model-lifecycle]");
  if (directStatus) directStatus.hidden = !studio.promptResidency.direct;
  const activeFamily = studio.activeRequestFamily;
  const activeLocal = studio.requestBusy && (["gguf", "ollama"].includes(activeFamily) || (activeFamily === "external" && studio.selectedModel?.lifecycle_supported));
  const activeTarget = activeLocal && activeFamily !== "external" ? { family: activeFamily, modelId: studio.activeRequestModelId } : null;
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

async function releaseComfyVram({ retry = null, requiredFreeMb = null } = {}) {
  if (!HOST_CAPABILITIES.comfyMemory) return;
  const button = studio.root.querySelector("[data-comfy-memory-action]");
  if (button.disabled || studio.comfyVramReleaseInFlight) return;
  let shouldRetry = false;
  studio.comfyVramReleaseInFlight = true;
  button.disabled = true;
  button.innerHTML = `<span class="h3ps-spinner"></span>Releasing…`;
  try {
    const before = await getStatus(studio.ollamaHost);
    const beforeFree = Number(before.gpu_memory?.free_mb);
    const requiredFree = requiredFreeMb == null ? null : Number(requiredFreeMb);
    if (typeof retry !== "function" && requiredFree == null && comfyVramIsAlreadyEmpty(before)) {
      studio.gpuMemory = before.gpu_memory || studio.gpuMemory;
      showToast("No ComfyUI models loaded", "VRAM is already free for Prompt Writer.");
      return;
    }
    await freeComfyVram();

    let latest = before;
    let targetReached = vramReleaseReachedTarget(beforeFree, beforeFree, requiredFree);
    for (let attempt = 0; attempt < 60 && !targetReached; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      latest = await getStatus(studio.ollamaHost);
      const currentFree = Number(latest.gpu_memory?.free_mb);
      targetReached = vramReleaseReachedTarget(beforeFree, currentFree, requiredFree);
    }
    studio.gpuMemory = latest.gpu_memory || studio.gpuMemory;
    const afterFree = Number(latest.gpu_memory?.free_mb);
    const releasedMb = Number.isFinite(beforeFree) && Number.isFinite(afterFree) ? Math.max(0, afterFree - beforeFree) : 0;
    if (typeof retry === "function") {
      shouldRetry = targetReached;
      if (!targetReached) {
        const freeText = Number.isFinite(afterFree) ? `${(afterFree / 1024).toFixed(1)} GB is free.` : "Free VRAM could not be measured.";
        const requiredText = Number.isFinite(requiredFree) ? ` About ${(requiredFree / 1024).toFixed(1)} GB is required.` : "";
        showToast("VRAM release is still completing", `${freeText}${requiredText} Generate again after ComfyUI finishes unloading.`);
      }
    } else if (releasedMb >= 64) {
      showToast("ComfyUI VRAM released", `${(releasedMb / 1024).toFixed(1)} GB freed. Workflow and cached node results were kept.`);
    } else {
      showToast("ComfyUI VRAM release requested", "No immediate VRAM change was detected. No workflow model may be loaded, or an active workflow must finish first.");
    }
  } catch (error) {
    showToast("VRAM release failed", error.message);
  } finally {
    studio.comfyVramReleaseInFlight = false;
    button.disabled = false;
    button.innerHTML = `${icon("memory", 15)}Free ComfyUI VRAM`;
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
  const action = !HOST_CAPABILITIES.comfyMemory || writerAutoVramApplies()
    ? null
    : { label: "Free ComfyUI VRAM & retry", onClick: () => releaseComfyVram({ retry, requiredFreeMb: error.details?.required_free_mb }) };
  showToast("Not enough free VRAM", message, null, action);
}

async function runLifecycleAction(event) {
  const button = event.currentTarget;
  if (button.disabled) return;
  const family = button.dataset.lifecycleFamily;
  const modelId = button.dataset.lifecycleModel || null;
  const stop = button.dataset.lifecycleStop === "true";
  if (stop) setGenerationState("busy", "Stopping & unloading", "Cancelling the request and unloading its prompt model");
  button.disabled = true;
  if (family === "external") {
    const target = studio.promptResidency.external?.find(t => t.model_id === modelId);
    if (target) target.state = "unloading";
    button.textContent = "Unloading…";
  }
  try {
    await unloadModel({ family, model_id: modelId, ollama_host: family === "ollama" ? studio.ollamaHost : null });
    if (family === "gguf") studio.promptResidency.direct = null;
    else if(family === "external" && !stop) studio.promptResidency.external = (studio.promptResidency.external||[]).map(t=>t.model_id===modelId ? {...t,state:"unloaded",writer_owned:false} : t);
    else if(family === "ollama") studio.promptResidency.ollama = studio.promptResidency.ollama.filter((name) => name !== modelId);
    showToast(
      stop ? "Stop & unload requested" : family === "external" ? "External model unloaded" : family === "ollama" ? "Ollama model unloaded" : "Direct model unloaded",
      stop ? "The request will stop and release its model at the next safe point." : "GPU memory used by the prompt model was released.",
    );
  } catch (error) {
    if (family === "external") {
      const target = studio.promptResidency.external?.find(t => t.model_id === modelId);
      if (target) target.state = "unknown";
    }
    showToast(error.code || "Unload failed", error.message, error.details);
  } finally {
    button.disabled = false;
    syncLifecycleActions();
  }
}

async function startGenerationPreview() {
  if (studio.vramHandoffInFlight) return;
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
  if (!generationModeIsAvailable()) return;
  if (!await prepareWriterRequest()) return;
  const modelName = studio.selectedModel.name.split("/").pop();
  const external = studio.selectedModel.family === "external";
  const apiProvider = studio.selectedModel.family === "api";
  const remote = external || apiProvider;
  markActiveWriterRequest();
  const generationDetail = external ? `${modelName} · the server may load its model if idle` : apiProvider ? `${modelName} · ${studio.selectedModel.api_preset}` : modelName;
  setGenerationState("busy", remote ? "Contacting provider" : "Loading model", generationDetail);
  let pollingActive = true;
  studio.statusTimer = setInterval(async () => {
    try {
      const status = await getStatus(studio.ollamaHost);
      if (!pollingActive) return;
      const labels = { loading_model: remote ? "Contacting provider" : "Loading model", processing_media: "Processing references", generating: "Generating", cancelling: "Cancelling" };
      if (labels[status.phase]) setGenerationState("busy", labels[status.phase], generationDetail);
    } catch {}
  }, 650);
  try {
    const result = await vramHandoffCoordinator.trackWriterRequest(generate(buildGeneratePayload(studio, {
      creativeBrief: currentBriefTextarea().value,
      lyrics: studio.mode === "Music3" ? studio.root.querySelector("[data-music-lyrics]").value : "",
      seed: newGenerationSeed(),
    })));
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
      const details = [
        `${result.total_seconds.toFixed(1)}s`,
        `${result.tokens_per_second.toFixed(1)} tok/s`,
        result.api_provider ? "Reasoning provider managed" : external ? null : `Thinking ${result.thinking ? "on" : "off"}`,
      ];
      showToast(studio.mode === "Music3" ? "Caption generated" : "Prompt generated", details.filter(Boolean).join(" · "));
    }
    studio.desktopNotifications.notify("Generation finished. Your prompt is ready.");
    if (result.lifecycle_warning) showToast("Model cleanup", result.lifecycle_warning, null, null, {dismissOnWorkspaceClick:true});
  } catch (error) {
    if (error.code !== "GENERATION_CANCELLED") studio.desktopNotifications.notify("Generation failed. Open Writer for details.");
    if (error.code === "GENERATION_CANCELLED") {
      showToast("Generation cancelled", "The active request stopped.");
    } else if (error.code === "INSUFFICIENT_FREE_VRAM") {
      showVramRetry(error, startGenerationPreview);
    } else if (error.code === "EXTERNAL_VISION_REQUIRED") {
      showToast("Vision model required", `${error.message} ${error.details?.suggestion || ""}`.trim());
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
    pollingActive = false;
    clearInterval(studio.statusTimer);
    studio.statusTimer = null;
    try {
      const status = await getStatus(studio.ollamaHost);
      updatePromptResidency(status);
    } catch {}
    clearActiveWriterRequest();
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
  return studio.modelSetup.map((model, index) => {
    const modelSize = model.vram_gb ? `${model.vram_gb} GB VRAM` : "Large model · measure locally";
    const contextLabel = ({ low: "8K", standard: "16K", extended: "24K", large: "32K", maximum: "48K" })[model.recommended_context] || "Auto";
    const runtimeLabel = model.minimum_runtime ? ` · llama-cpp-python ${model.minimum_runtime}+` : "";
    return `
    <div class="h3ps-model-setup-row ${model.vram_gb === tier ? "fits-detected-vram" : ""}" ${model.vram_gb === tier ? 'title="Fits the detected total VRAM tier"' : ""}>
      <span><strong>${escapeHtml(model.name)}</strong><small>${modelSize} · ${contextLabel}${runtimeLabel}${model.vram_gb === tier ? " · Fits detected VRAM" : ""}</small><small class="h3ps-model-source">${escapeHtml(model.source_label)}</small></span>
      <span class="h3ps-model-files"><button type="button" data-model-files-toggle="${index}">Files ↗</button><span data-model-files-menu="${index}" hidden><a href="${model.model_url}" target="_blank" rel="noopener noreferrer">Model file ↗</a><a href="${model.projector_url}" target="_blank" rel="noopener noreferrer">Projector file ↗</a></span></span>
    </div>`;
  }).join("");
}

function modelDiscoveryDetails() {
  const roots = studio.modelDiscovery?.roots || [];
  if (!roots.length) return "";
  const lines = [];
  for (const root of roots) {
    lines.push(root.path);
    lines.push(`  Model GGUF: ${root.model_files.length}`);
    for (const path of root.model_files) lines.push(`    ${path}`);
    lines.push(`  Vision projector GGUF: ${root.projector_files.length}`);
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
      <p>Keep compatible model GGUFs and their vision projector together. One projector can serve several quant files from the same model family.</p>
    </div>`;
}

function directRuntimeActionCommand() {
  const actions = studio.ggufRuntimeDiagnostics?.actions || {};
  const onboarding = studio.ggufRuntimeDiagnostics?.onboarding || {};
  return typeof actions.install_or_upgrade_command === "string"
    ? actions.install_or_upgrade_command
    : typeof onboarding.install_command === "string"
      ? onboarding.install_command
      : "";
}

function renderDirectRuntimeCommand(command, action = "installation") {
  if (!command) return "";
  return `<div class="h3ps-direct-runtime-command"><code>${escapeHtml(command)}</code><button type="button" data-copy-direct-runtime-command="${escapeHtml(command)}" title="Copy ${escapeHtml(action)} command" aria-label="Copy ${escapeHtml(action)} command">${icon("copy", 13)}</button></div><small>Close ComfyUI, run this from your ComfyUI Portable folder containing <code>python_embeded</code>, then restart ComfyUI.</small>`;
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
    const command = directRuntimeActionCommand();
    return `<section class="h3ps-direct-runtime-state is-missing">
      <header><span><small>Runtime</small><strong>llama-cpp-python is not installed.</strong></span></header>
      <p>Direct GGUF needs an additional native runtime. Ollama and API providers work without it.</p>
      ${renderDirectRuntimeCommand(command)}
      <div class="h3ps-direct-runtime-links"><a href="${INSTALLATION_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Installation guide ↗</a><a href="${TROUBLESHOOTING_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Troubleshooting guide ↗</a></div>
    </section>`;
  }
  const version = diagnostics.package_version ? ` Version ${escapeHtml(diagnostics.package_version)} was detected.` : "";
  return `<section class="h3ps-direct-runtime-state is-broken">
    <header><span><small>Runtime</small><strong>llama-cpp-python is installed, but the runtime is not usable.</strong></span></header>
    <p>The installed package does not match the Direct GGUF runtime requirements.${version}</p>
    <a href="${TROUBLESHOOTING_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Troubleshooting ↗</a>
  </section>`;
}

function localRuntimeLabel() {
  const diagnostics = studio?.ggufRuntimeDiagnostics;
  if (!diagnostics) return "Local GGUF · llama-cpp-python";
  if (diagnostics.status !== "ok") return "Runtime could not be inspected";
  const offload = diagnostics.gpu_offload === true
    ? "GPU offload available"
    : diagnostics.gpu_offload === false
      ? "GPU offload unavailable"
      : "Runtime detected";
  const version = diagnostics.package_version ? ` ${diagnostics.package_version}` : "";
  return `${offload === "Runtime detected" ? `Runtime${version} detected` : `${offload}${version}`}${diagnostics.backend ? ` · ${diagnostics.backend}` : ""}`;
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
      showToast("Runtime could not be inspected", "The package preflight was unavailable. Generation will continue with the existing runtime behavior.", error.details || error.message);
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
  const contextLabel = connected?.context_verified !== false && Number.isFinite(connected?.server_context_tokens)
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
        <label><span>Model ID <em>optional</em></span><input name="model" type="text" value="${escapeHtml(config.model)}" placeholder="Required when the server lists multiple models"></label>
        <label><span>API key <em>optional</em></span><input name="api_key" type="password" autocomplete="off" placeholder="Blank reuses the key held in server memory"></label>
        <small>Localhost only. Context and KV cache stay server-managed. Model lifecycle controls require a llama.cpp router.</small>
        <div><button type="button" data-external-server-disconnect ${connected || studio.externalServerConfig ? "" : "hidden"}>Disconnect</button><span></span><button type="submit">${connected ? "Reconnect" : "Connect"}</button></div>
      </form>
    </div>`;
}

function ollamaModels() {
  return Array.isArray(studio.ollamaStatus?.compatible_models) ? studio.ollamaStatus.compatible_models : [];
}

function ollamaModelForSettings() {
  const models = ollamaModels();
  if (studio.selectedModel?.family === "ollama" && studio.selectedModel.endpoint === studio.ollamaHost) {
    return models.find((model) => model.id === studio.selectedModel.id) || studio.selectedModel;
  }
  return models.find((model) => model.remote_model === studio.ollamaModelName) || models[0] || null;
}

function ollamaHostControlMarkup(hostValue = studio.ollamaHost) {
  const custom = studio.ollamaHost !== DEFAULT_OLLAMA_HOST;
  return `<details class="h3ps-ollama-host-settings" data-ollama-host-settings ${studio.ollamaHostSettingsOpen ? "open" : ""}>
    <summary>${custom ? `Remote host · ${escapeHtml(studio.ollamaHost)}` : "Use Ollama on another computer"}</summary>
    <form data-ollama-host-form>
      <label><span>Host URL</span><input name="host" type="url" value="${escapeHtml(hostValue)}" placeholder="${DEFAULT_OLLAMA_HOST}" required></label>
      <button type="submit">Apply</button>
    </form>
    <small>Keep the default URL for Ollama on this computer. Remote hosts must allow connections from this machine.</small>
  </details>`;
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

function renderOllamaProviderControl(hostValue) {
  const status = studio.ollamaStatus;
  const hostControl = ollamaHostControlMarkup(hostValue);
  const remoteHost = studio.ollamaHost !== DEFAULT_OLLAMA_HOST;
  const serviceLabel = remoteHost ? "Remote service" : "Local service";
  if (!status) {
    return `<header class="h3ps-settings-section-heading"><span><small>${serviceLabel}</small><strong>Ollama</strong></span></header>
      ${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state"><span class="h3ps-spinner"></span><span class="h3ps-ollama-state-copy"><strong>Checking Ollama…</strong><p>${remoteHost ? "Looking for the selected service and installed models." : "Looking for the local service and installed models."}</p></span></div>${hostControl}`;
  }
  const ready = status.state === "ready";
  const refresh = ready ? `<button type="button" data-ollama-refresh>${icon("refresh", 13)} Refresh</button>` : "";
  const header = `<header class="h3ps-settings-section-heading"><span><small>${serviceLabel}</small><strong>Ollama</strong></span>${refresh}</header>`;
  if (status.state === "not_installed") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">1</span><span class="h3ps-ollama-state-copy"><strong>Get Ollama</strong>
      <p>Install the official Ollama app, open it once, then return here. This page will detect it automatically.</p></span>
      <a class="h3ps-ollama-primary" href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">Official download ↗</a>
    </div>${hostControl}`;
  }
  if (status.state === "not_running") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">1</span><span class="h3ps-ollama-state-copy"><strong>Start Ollama</strong>
      <p>${remoteHost ? `The Ollama service at ${escapeHtml(studio.ollamaHost)} is not responding.` : "Ollama is installed, but its local service is not responding. Open the Ollama app; this page checks automatically."}</p></span>
      <button class="h3ps-ollama-primary" type="button" data-ollama-refresh>Check now</button>
    </div>${hostControl}`;
  }
  if (status.state === "error") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state is-error">
      <span class="h3ps-ollama-state-icon">!</span><span class="h3ps-ollama-state-copy"><strong>Ollama could not be inspected</strong>
      <p>${escapeHtml(status.error?.message || "The service returned an unexpected response.")}</p></span>
      <button class="h3ps-ollama-primary" type="button" data-ollama-refresh>Try again</button>
    </div>${hostControl}`;
  }
  const models = ollamaModels();
  if (!models.length) {
    return `${header}${ollamaJourneyMarkup("model")}<div class="h3ps-ollama-state h3ps-ollama-model-state">
      <span class="h3ps-ollama-state-copy"><strong>Add a compatible prompt model</strong>
      <p>Ollama is running, but no installed model reports both vision and text generation support.</p>
      <div class="h3ps-ollama-tier-heading">Choose a model for your GPU</div>
      ${renderOllamaModelTiers(status)}
      <small>Copy a command and run it in Terminal or PowerShell. This page detects the model automatically.</small>
      <details class="h3ps-ollama-storage-help" data-ollama-storage-help ${studio.ollamaStorageHelpOpen ? "open" : ""}><summary>Need models on another drive?</summary><p>Ollama manages one global model store. Set <code>OLLAMA_MODELS</code> before pulling a model, then restart Ollama. <a href="https://docs.ollama.com/windows#changing-model-location" target="_blank" rel="noopener noreferrer">Official instructions ↗</a></p></details></span>
    </div>${hostControl}`;
  }
  const selected = ollamaModelForSettings();
  const tested = selected?.tested_for_h3 === true;
  const addModelOpen = studio.ollamaAddModelOpen === true;
  return `${header}${ollamaJourneyMarkup("ready")}<div class="h3ps-ollama-ready">
    <div class="h3ps-ollama-ready-heading"><span class="h3ps-provider-icon" data-provider-icon="ollama" aria-hidden="true"></span><span><strong>Ollama is ready</strong><small>Version ${escapeHtml(status.version || "unknown")} · ${remoteHost ? escapeHtml(studio.ollamaHost) : "local service"}</small></span><em>Running</em></div>
    <div class="h3ps-ollama-model-heading"><span>Prompt model</span><button class="h3ps-ollama-add-model-toggle" type="button" data-ollama-add-model aria-expanded="${String(addModelOpen)}">${addModelOpen ? "− Hide models" : "+ Add model"}</button></div>
    <label class="h3ps-ollama-model-select"><select data-ollama-model>${models.map((model) => `<option value="${escapeHtml(model.remote_model)}" ${model.remote_model === selected?.remote_model ? "selected" : ""}>${escapeHtml(model.name)}${model.parameter_size ? ` · ${escapeHtml(model.parameter_size)}` : ""}${model.quantization_level ? ` · ${escapeHtml(model.quantization_level)}` : ""}</option>`).join("")}</select></label>
    ${addModelOpen ? `<div class="h3ps-ollama-add-model"><strong>Choose another tested model</strong>${renderOllamaModelTiers(status)}<small>Copy a command and run it in Terminal or PowerShell. Select Refresh after the pull completes.</small></div>` : ""}
    <div class="h3ps-ollama-badges"><span>Vision</span><span>${selected?.thinking_detected ? "Thinking detected" : "Standard generation"}</span><span class="${tested ? "is-tested" : ""}">${tested ? "Tested for H3" : "Compatible · not yet H3-tested"}</span></div>
    <p>${tested ? "This exact Ollama tag passed the focused H3 Generate and Refine smoke test." : "Compatibility comes from Ollama model metadata. It is not a quality guarantee for H3 prompts."}</p>
    <small>Use “Keep model loaded” on the Generate page to control whether Ollama retains this model after each request.</small>
  </div>${hostControl}`;
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
      ${config.preset === "custom" ? `<label><span>API base URL</span><input name="base_url" type="url" value="${escapeHtml(config.base_url)}" placeholder="https://host.example/v1 or http://localhost:8000/v1" required><small>Public endpoints require HTTPS; loopback and private LAN addresses may use HTTP.</small></label>` : ""}
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
  const backdrop = studio.root.querySelector("[data-other-models-backdrop]");
  const trigger = studio.root.querySelector("[data-other-models-toggle]");
  if (!popover) return;
  popover.hidden = !open;
  if (open) popover.setAttribute("aria-modal", "true");
  else popover.removeAttribute("aria-modal");
  if (backdrop) backdrop.hidden = !open;
  trigger?.setAttribute("aria-expanded", String(open));
  if (open) {
    scheduleStudioFocus(() => popover.querySelector("[data-other-models-close]"));
  } else if (popover.contains(document.activeElement)) {
    trigger?.focus();
  }
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
  runtimeSettings.hidden = !["direct", "ollama"].includes(provider);
  runtimeSettings.querySelector('[data-runtime-toggle="context"]').closest(".h3ps-runtime-control").hidden = provider !== "direct";
  runtimeSettings.querySelector('[data-runtime-toggle="kv"]').closest(".h3ps-runtime-control").hidden = provider !== "direct";
  runtimeSettings.querySelector("[data-runtime-management]").textContent = provider === "ollama"
    ? "Ollama context is planned automatically. Generation budget applies to the next request, including thinking."
    : "Direct GGUF runtime settings are applied to the next request.";
}

function directModelRuntimeSuffix(model) {
  const requirement = model.runtime_requirement || {};
  if (requirement.state === "update_required") {
    return `Runtime ${requirement.minimum_version}+ required`;
  }
  if (requirement.state === "missing") return "Runtime required";
  if (requirement.state === "incompatible") return "Runtime incompatible";
  return "";
}

function renderDirectModelRuntimeUpdate(model) {
  const requirement = model.runtime_requirement || {};
  const installed = requirement.installed_version || studio.ggufRuntimeDiagnostics?.package_version || "unknown";
  const minimum = requirement.minimum_version || "a newer version";
  const command = directRuntimeActionCommand();
  return `<section class="h3ps-direct-runtime-state is-missing">
    <header><span><small>Runtime</small><strong>Runtime update required</strong></span></header>
    <p>Installed llama-cpp-python ${escapeHtml(installed)}. ${escapeHtml(model.name)} requires ${escapeHtml(minimum)} or newer.</p>
    ${renderDirectRuntimeCommand(command, "update")}
    ${command ? "" : `<div class="h3ps-direct-runtime-links"><a href="${INSTALLATION_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Installation guide ↗</a><a href="${TROUBLESHOOTING_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Troubleshooting guide ↗</a></div>`}
  </section>`;
}

function projectorChoices() {
  try {
    const value = JSON.parse(localStorage.getItem("h3-writer-projectors") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function renderProjectorChoice(model) {
  const slot = studio.root.querySelector("[data-direct-projector]");
  const choices = model?.projector_candidates || [];
  slot.replaceChildren();
  if (choices.length < 2) return;
  slot.innerHTML = `<label class="h3ps-field"><span>Vision projector</span><select aria-label="Vision projector"><option value="">Choose a compatible projector…</option>${choices.map(path => `<option value="${escapeHtml(path)}" ${path === model.selected_projector ? "selected" : ""}>${escapeHtml(path.split(/[\\/]/).pop())}</option>`).join("")}</select></label><p class="h3ps-direct-model-note">Several projectors match this model. Choose the intended file.</p>`;
  const select = slot.querySelector("select");
  select.addEventListener("change", async () => {
    const revision = studio.modelSelectionRevision;
    const path = select.value;
    if (!path || studio.requestBusy) return;
    select.disabled = true;
    try {
      const result = await selectProjector(model.id, path);
      if (studio.requestBusy || revision !== studio.modelSelectionRevision || directModelForSettings()?.id !== model.id) return;
      const saved = projectorChoices(); saved[model.id] = path;
      localStorage.setItem("h3-writer-projectors", JSON.stringify(saved));
      studio.models = studio.models.map(m => m.id === model.id ? result.model : m);
      selectModel(result.model);
    } catch (error) { showToast("Projector selection", error.message); }
    finally { if (select.isConnected) select.disabled = false; }
  });
}

function renderInferenceSettings() {
  const ollamaHostDraft = studio.root.querySelector('[data-ollama-host-form] input[name="host"]')?.value;
  const models = localModels();
  const directModel = directModelForSettings();
  renderProjectorChoice(directModel);
  const select = studio.root.querySelector("[data-installed-model]");
  select.disabled = !models.length;
  select.innerHTML = models.length
    ? models.map((model) => {
      const modelFileNeedsSetup = model.model_ready === false;
      const suffix = [
        modelVramLabel(model),
        model.format,
        modelFileNeedsSetup ? "Needs setup" : "",
        directModelRuntimeSuffix(model),
        isTextOnlyDirectModel(model) ? "Text only" : "",
      ].filter(Boolean).join(" · ");
      return `<option value="${escapeHtml(model.id)}" ${model.id === directModel?.id ? "selected" : ""}>${escapeHtml(model.name.split("/").pop())}${suffix ? ` — ${escapeHtml(suffix)}` : ""}</option>`;
    }).join("")
    : "<option>No compatible model found</option>";
  studio.root.querySelector("[data-direct-runtime-status]").innerHTML = renderDirectRuntimeStatus();
  const directStatus = studio.root.querySelector("[data-direct-model-status]");
  if (!models.length) {
    directStatus.innerHTML = renderModelSetup();
  } else if (directModel) {
    const runtimeRequirement = directModel.runtime_requirement || {};
    directStatus.innerHTML = directModel.model_ready === false
      ? `<div class="h3ps-direct-model-warning"><strong>Model needs attention</strong><span>${escapeHtml(directModel.setup_message || "The GGUF metadata or architecture is not supported.")}</span></div>`
      : runtimeRequirement.state === "update_required"
        ? renderDirectModelRuntimeUpdate(directModel)
        : isTextOnlyDirectModel(directModel)
          ? `<div class="h3ps-direct-model-note"><strong>Text-only model · T2VA and Music3 available</strong><span>${escapeHtml(directModel.capability_message || "No compatible vision projector is active.")}</span></div>`
          : "";
  } else {
    directStatus.innerHTML = "";
  }
  studio.root.querySelector("[data-model-scan-slot]").innerHTML = renderModelScanDetails();
  studio.root.querySelector("[data-verified-models-slot]").innerHTML = studio.modelSetup.length ? renderOtherModelsTrigger() : "";
  studio.root.querySelector("[data-external-provider-control]").innerHTML = renderExternalServerControl();
  studio.root.querySelector("[data-ollama-provider-control]").innerHTML = renderOllamaProviderControl(ollamaHostDraft);
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
  studio.modelSelectionRevision = (studio.modelSelectionRevision || 0) + 1;
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
  studio.modelSelectionRevision = (studio.modelSelectionRevision || 0) + 1;
  rememberRuntimePreferences();
  selectModelState(studio, model, { preserveSettingsProvider });
  const switchedToT2VA = !isGenerationModeAvailable(model, studio.mode);
  if (switchedToT2VA) {
    stashCurrentModeDraft();
    studio.mode = "T2VA";
    studio.lastVideoMode = "T2VA";
    syncWorkspace();
    restoreModeDraft(studio.mode);
  }
  applyRuntimePreferences(studio.settingsProvider);
  if (model?.family === "gguf") {
    const availableContexts = model.context_profiles || ["low", "standard", "extended"];
    if (studio.contextProfile !== "auto" && studio.contextProfile !== "custom" && !availableContexts.includes(studio.contextProfile)) {
      studio.contextProfile = "auto";
      studio.directContextProfile = "auto";
    }
  }
  if (model?.family === "gguf") studio.preferredDirectModelId = model.id;
  const remote = ["external", "api"].includes(model?.family);
  if (model?.family !== "gguf") {
    studio.contextProfile = "auto";
    studio.kvCache = "auto";
  }
  if (model?.family === "ollama") {
    studio.ollamaModelName = model.remote_model;
    saveOllamaModel(localStorage, model.remote_model, studio.ollamaHost);
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
  const vramHandoff = studio.root.querySelector("[data-vram-handoff]");
  const vramHandoffControl = studio.root.querySelector("[data-vram-handoff-control]");
  keepLoadedControl.hidden = remote && !model?.lifecycle_supported;
  keepLoaded.checked = studio.keepModelLoaded;
  if (vramHandoffControl && vramHandoff) {
    vramHandoffControl.hidden = !selectedModelSupportsVramHandoff();
    vramHandoff.checked = studio.vramHandoff;
  }
  renderInferenceSettings();
  renderMedia(studio.mode);
  setOtherModelsPopover(false);
  syncRuntimeSummary();
  syncThinkingAvailability();
  saveUserPreferences(localStorage, studio);
  if (switchedToT2VA && !studio.preferencesRestoring) {
    showToast(
      "Switched to T2VA",
      model?.capability_message || "The selected Direct GGUF has no compatible vision projector.",
    );
  }
}

function rememberRuntimePreferences(provider = studio.settingsProvider) {
  if (studio.preferencesRestoring) return;
  if (provider === "direct") {
    studio.directContextProfile = studio.contextProfile;
    studio.directContextTokens = studio.contextTokens;
    studio.directKvCache = studio.kvCache;
    studio.directGenerationBudget = studio.generationBudget;
    studio.directGenerationBudgetTokens = studio.generationBudgetTokens;
    studio.directReasoningEffort = studio.reasoningEffort;
  } else if (provider === "ollama") {
    studio.ollamaGenerationBudget = studio.generationBudget;
    studio.ollamaGenerationBudgetTokens = studio.generationBudgetTokens;
  }
}

function applyRuntimePreferences(provider) {
  if (provider === "direct") {
    studio.contextProfile = studio.directContextProfile;
    studio.contextTokens = studio.directContextTokens;
    studio.kvCache = studio.directKvCache;
    studio.generationBudget = studio.directGenerationBudget;
    studio.generationBudgetTokens = studio.directGenerationBudgetTokens;
    studio.reasoningEffort = studio.directReasoningEffort;
  } else {
    studio.contextProfile = "auto";
    studio.contextTokens = null;
    studio.kvCache = "auto";
    studio.generationBudget = provider === "ollama" ? studio.ollamaGenerationBudget : "auto";
    studio.generationBudgetTokens = provider === "ollama" ? studio.ollamaGenerationBudgetTokens : null;
    studio.reasoningEffort = "auto";
  }
}

function syncThinkingAvailability() {
  if (!studio) return;
  const apiManaged = studio.selectedModel?.family === "api";
  const externalManaged = studio.selectedModel?.family === "external";
  const context = studio.contextProfile;
  const resolved = context === "auto" ? (studio.selectedModel?.recommended_context || "standard") : context;
  const input = studio.root.querySelector("[data-thinking]");
  const label = input.closest("label");
  const unsupported = ["ollama", "gguf"].includes(studio.selectedModel?.family)
    && studio.selectedModel.thinking !== true;
  const customTooSmall = context === "custom" && Number(studio.contextTokens || 0) < 16384;
  const disabled = apiManaged || externalManaged || unsupported || (context !== "auto" && (resolved === "low" || customTooSmall));
  if (disabled) input.checked = false;
  if (disabled) studio.thinking = false;
  input.checked = studio.thinking;
  input.disabled = disabled;
  label.hidden = apiManaged;
  label.classList.toggle("is-disabled", disabled);
  label.title = externalManaged
    ? "Thinking is controlled by the external llama.cpp server. Start it with --reasoning on --reasoning-effort low to enable, or --reasoning off to disable."
    : unsupported
    ? "This provider model does not report thinking controls."
    : disabled ? "Thinking needs 16K or larger Context." : "";
}

const CONTEXT_LABELS = { auto: "Auto", low: "8K", standard: "16K", extended: "24K", large: "32K", maximum: "48K", custom: "Custom" };
const KV_LABELS = { auto: "Auto", q8: "Q8", f16: "F16" };
const BUDGET_LABELS = { auto: "Auto", 2048: "2K", 4096: "4K", 8192: "8K", custom: "Custom" };

function syncContextAvailability() {
  const profiles = studio.selectedModel?.family === "gguf"
    ? (studio.selectedModel.context_profiles || ["low", "standard", "extended"])
    : [];
  studio.root.querySelectorAll('[data-runtime-option="context"]').forEach((button) => {
    const unavailable = studio.selectedModel?.family === "gguf"
      && button.dataset.value !== "auto"
      && button.dataset.value !== "custom"
      && !profiles.includes(button.dataset.value);
    button.disabled = unavailable;
    button.setAttribute("aria-disabled", String(unavailable));
    button.title = unavailable ? "This Context tier is not available for the selected Direct model." : "";
  });
}

function syncAdvancedRuntimeControls() {
  const direct = studio.selectedModel?.family === "gguf";
  const advanced = studio.root.querySelector("[data-direct-runtime-advanced]");
  const ollama = studio.settingsProvider === "ollama";
  advanced.hidden = !direct && !ollama;
  const customContext = studio.root.querySelector("[data-custom-context]");
  customContext.hidden = !direct || studio.contextProfile !== "custom";
  const contextInput = studio.root.querySelector("[data-custom-context-input]");
  contextInput.value = studio.contextTokens || "";
  const nativeContext = studio.selectedModel?.native_context_tokens;
  if (Number.isInteger(nativeContext) && nativeContext > 0) contextInput.max = String(nativeContext);
  else contextInput.removeAttribute("max");

  const customBudget = studio.root.querySelector("[data-custom-generation-budget]");
  customBudget.hidden = (!direct && !ollama) || studio.generationBudget !== "custom";
  studio.root.querySelector("[data-custom-generation-budget-input]").value = studio.generationBudgetTokens || "";

  const values = direct ? (studio.selectedModel?.reasoning_effort_values || []) : [];
  if (studio.reasoningEffort !== "auto" && !values.includes(studio.reasoningEffort)) {
    studio.reasoningEffort = "auto";
    studio.directReasoningEffort = "auto";
  }
  const reasoningControl = studio.root.querySelector("[data-reasoning-effort-control]");
  reasoningControl.hidden = values.length === 0;
  const generationBudgetOverride = studio.generationBudget !== "auto"
    && (studio.generationBudget !== "custom"
      || (Number.isInteger(studio.generationBudgetTokens) && studio.generationBudgetTokens > 0));
  const overrideCount = Number(studio.kvCache !== "auto")
    + Number(generationBudgetOverride)
    + Number(studio.reasoningEffort !== "auto" && values.includes(studio.reasoningEffort));
  studio.root.querySelector("[data-direct-advanced-summary]").textContent = overrideCount
    ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}`
    : "Auto";
  const menu = studio.root.querySelector('[data-runtime-menu="reasoning"]');
  menu.innerHTML = ["auto", ...values].map((value) => `<button type="button" data-runtime-option="reasoning" data-value="${escapeHtml(value)}">${value === "auto" ? "Auto" : escapeHtml(value[0].toUpperCase() + value.slice(1))}</button>`).join("");
  menu.querySelectorAll('[data-runtime-option="reasoning"]').forEach((button) => button.addEventListener("click", (event) => applyRuntimeOption(button, event)));
}

function setRuntimeMenuOpen(name, open, restoreFocus = false) {
  if (!studio) return;
  const menu = studio.root.querySelector(`[data-runtime-menu="${name}"]`);
  const toggle = studio.root.querySelector(`[data-runtime-toggle="${name}"]`);
  if (!menu) return;
  menu.hidden = !open;
  toggle?.setAttribute("aria-expanded", String(open));
  if (!open && restoreFocus) toggle?.focus({ preventScroll: true });
}

function closeRuntimeMenus(exceptName = null) {
  if (!studio) return;
  studio.root.querySelectorAll("[data-runtime-menu]").forEach((menu) => {
    if (menu.dataset.runtimeMenu !== exceptName) setRuntimeMenuOpen(menu.dataset.runtimeMenu, false);
  });
}

function applyRuntimeOption(button, event) {
  event.preventDefault();
  if (button.dataset.runtimeOption === "context") studio.contextProfile = button.dataset.value;
  else if (button.dataset.runtimeOption === "kv") studio.kvCache = button.dataset.value;
  else if (button.dataset.runtimeOption === "budget") studio.generationBudget = button.dataset.value;
  else studio.reasoningEffort = button.dataset.value;
  setRuntimeMenuOpen(button.dataset.runtimeOption, false, true);
  syncRuntimeSummary();
  syncThinkingAvailability();
  rememberRuntimePreferences();
  saveUserPreferences(localStorage, studio);
}

function syncRuntimeSummary(result = null) {
  if (!studio) return;
  syncContextAvailability();
  syncAdvancedRuntimeControls();
  const customContextLabel = studio.contextTokens ? `${Number(studio.contextTokens).toLocaleString()}` : "Custom";
  studio.root.querySelector('[data-runtime-label="context"]').textContent = CONTEXT_LABELS[studio.contextProfile];
  studio.root.querySelector('[data-runtime-label="kv"]').textContent = KV_LABELS[studio.kvCache];
  studio.root.querySelector('[data-runtime-label="budget"]').textContent = BUDGET_LABELS[studio.generationBudget];
  studio.root.querySelector('[data-runtime-label="reasoning"]').textContent = studio.reasoningEffort === "auto"
    ? "Auto"
    : studio.reasoningEffort[0].toUpperCase() + studio.reasoningEffort.slice(1);
  let activeSummary;
  if (studio.selectedModel?.family === "external") {
    const tokens = result?.context_tokens || studio.selectedModel.server_context_tokens;
    activeSummary = tokens ? `Server · ${Math.round(tokens / 1024)}K` : "Server managed";
  } else if (studio.selectedModel?.family === "ollama") {
    const tokens = result?.context_tokens || (studio.contextProfile === "auto" ? null : ({ low: 8192, standard: 16384, extended: 24576, large: 32768, maximum: 49152 }[studio.contextProfile]));
    activeSummary = tokens ? `Ollama · ${Math.round(tokens / 1024)}K` : "Ollama · Auto";
  } else if (studio.selectedModel?.family === "api") {
    const tokens = result?.context_limit_known ? result.context_tokens : studio.selectedModel.model_context_limit;
    activeSummary = tokens ? `API · ${Math.round(tokens / 1024)}K` : "API · Provider managed";
  } else if (result && studio.contextProfile === "auto") {
    activeSummary = `Auto → ${Math.round(result.context_tokens / 1024)}K · ${String(result.kv_cache).toUpperCase()}`;
  } else {
    activeSummary = studio.contextProfile === "auto" ? "Runtime · Auto" : `${studio.contextProfile === "custom" ? customContextLabel : CONTEXT_LABELS[studio.contextProfile]} · ${KV_LABELS[studio.kvCache]}`;
  }
  syncActiveModelSummary(activeSummary);
  studio.root.querySelectorAll("[data-runtime-option]").forEach((button) => {
    const selected = button.dataset.runtimeOption === "context"
      ? studio.contextProfile
      : button.dataset.runtimeOption === "kv"
        ? studio.kvCache
        : button.dataset.runtimeOption === "budget"
          ? studio.generationBudget
          : studio.reasoningEffort;
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
  studio.modelSelectionRevision = (studio.modelSelectionRevision || 0) + 1;
  const attempt = (studio.externalConnectionAttempt || 0) + 1;
  studio.externalConnectionAttempt = attempt;
  const selectionRevision = studio.modelSelectionRevision || 0;
  const submit = form.querySelector('[type="submit"]');
  const config = {
    url: form.elements.url.value.trim(),
    model: form.elements.model.value.trim(),
    ...(form.elements.api_key.value.trim() ? {api_key:form.elements.api_key.value.trim()} : {}),
  };
  submit.disabled = true;
  submit.textContent = "Connecting…";
  try {
    const result = await probeExternalServer(config);
    if (studio.externalConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    const saved = { url: result.model.endpoint, model: result.model.remote_model };
    studio.externalServerConfig = saved;
    studio.externalServerError = null;
    studio.externalModel = result.model;
    saveExternalServerConfig(localStorage, saved);
    studio.models = [...studio.models.filter((model) => model.family !== "external"), result.model];
    selectModel(result.model);
    const context = result.model.context_verified !== false
      ? ` · ${Math.round(result.model.server_context_tokens / 1024)}K context` : "";
    showToast("llama.cpp connected", `${result.model.name}${context}`);
  } catch (error) {
    if (studio.externalConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    studio.externalServerError = error;
    showToast(error.code || "Connection failed", error.message, error.details);
    renderInferenceSettings();
  } finally {
    if (studio.externalConnectionAttempt === attempt) {
      submit.disabled = false;
      submit.textContent = "Connect";
    }
  }
}

function disconnectExternalServer() {
  studio.externalConnectionAttempt = (studio.externalConnectionAttempt || 0) + 1;
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
  studio.modelSelectionRevision = (studio.modelSelectionRevision || 0) + 1;
  const attempt = (studio.apiConnectionAttempt || 0) + 1;
  studio.apiConnectionAttempt = attempt;
  const selectionRevision = studio.modelSelectionRevision || 0;
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
    if (studio.apiConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) {
      if (result.connection.id !== studio.apiProviderConnection?.id) {
        await disconnectApiProvider(result.connection.id).catch(() => {});
      }
      return;
    }
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
    if (studio.apiConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    studio.apiProviderError = error;
    showToast(error.code || "API connection failed", error.message, error.details);
    renderInferenceSettings();
  } finally {
    if (studio.apiConnectionAttempt === attempt) {
      submit.disabled = false;
      submit.textContent = "Connect & test";
    }
  }
}

async function disconnectConfiguredApiProvider({ announce = true } = {}) {
  studio.apiConnectionAttempt = (studio.apiConnectionAttempt || 0) + 1;
  const connection = studio.apiProviderConnection;
  const wasSelected = studio.selectedModel?.family === "api";
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
  if (connection?.id) {
    try {
      await disconnectApiProvider(connection.id);
    } catch {}
  }
}

async function chooseApiProviderPreset(preset) {
  if (!API_PROVIDER_UI[preset] || preset === studio.apiProviderConfig.preset) return;
  // Invalidate pending attempts even before the first connection exists.
  void disconnectConfiguredApiProvider({ announce: false });
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
  const attempt = (studio.apiConnectionAttempt || 0) + 1;
  studio.apiConnectionAttempt = attempt;
  const selectionRevision = studio.modelSelectionRevision || 0;
  try {
    const result = await getApiProviderModels(studio.apiProviderConnection.id);
    if (studio.apiConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    const selectedRemote = studio.selectedModel?.family === "api" ? studio.selectedModel.remote_model : studio.apiProviderConfig.model_id;
    studio.apiProviderConnection = result.connection;
    studio.apiProviderModels = result.models || [];
    studio.models = [...studio.models.filter((model) => model.family !== "api"), ...studio.apiProviderModels];
    const model = studio.apiProviderModels.find((item) => item.remote_model === selectedRemote) || apiProviderModelForSettings();
    if (model) selectModel(model);
    else renderInferenceSettings();
    showToast("API models refreshed", `${studio.apiProviderModels.length} model${studio.apiProviderModels.length === 1 ? "" : "s"} reported.`);
  } catch (error) {
    if (studio.apiConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    studio.apiProviderError = error;
    showToast(error.code || "Model refresh failed", error.message, error.details);
  }
}

async function refreshModels() {
  const attempt = (studio.modelDiscoveryAttempt || 0) + 1;
  studio.modelDiscoveryAttempt = attempt;
  const selectionRevision = studio.modelSelectionRevision || 0;
  const externalAttempt = studio.externalConnectionAttempt || 0;
  try {
    const [result, status, ollamaStatus, apiPresets] = await Promise.all([
      getModels(),
      getStatus(studio.ollamaHost),
      getOllamaStatus(studio.ollamaHost).catch((error) => ({ state: "error", running: false, compatible_models: [], error: { code: error.code, message: error.message } })),
      getApiProviderPresets().catch(() => ({ presets: [] })),
    ]);
    if (studio.modelDiscoveryAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    const selectedId = studio.selectedModel?.id;
    const selectedBeforeRefresh = studio.selectedModel;
    const models = [...result.models, ...(ollamaStatus.compatible_models || []), ...studio.apiProviderModels];
    let externalModel = null;
    let externalServerError = null;
    if (studio.externalServerConfig) {
      try {
        const external = await probeExternalServer(studio.externalServerConfig);
        if (studio.modelDiscoveryAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision || (studio.externalConnectionAttempt || 0) !== externalAttempt) return;
        externalModel = external.model;
        models.push(external.model);
      } catch (error) {
        if (studio.modelDiscoveryAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision || (studio.externalConnectionAttempt || 0) !== externalAttempt) return;
        externalServerError = error;
      }
    }
    const savedProjectors = projectorChoices();
    for (let i = 0; i < models.length; i++) {
      const model = models[i], path = savedProjectors[model.id];
      if (!path || !model.projector_candidates?.includes(path)) continue;
      try { models[i] = (await selectProjector(model.id, path)).model; }
      catch { /* The current scan remains usable when a saved file disappears. */ }
      if (studio.modelDiscoveryAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision || (studio.externalConnectionAttempt || 0) !== externalAttempt) return;
    }
    studio.ollamaStatus = ollamaStatus;
    studio.ollamaError = ollamaStatus.error || null;
    studio.apiProviderPresets = apiPresets.presets || [];
    studio.models = models;
    studio.externalModel = externalModel;
    studio.externalServerError = externalServerError;
    studio.modelSetup = result.setup || [];
    studio.modelDiscovery = result.discovery || null;
    studio.modelDirectory = result.model_directory || "ComfyUI/models/LLM/";
    studio.gpuMemory = status.gpu_memory;
    if (!studio.requestBusy) updatePromptResidency(status);
    const restoredModel = !selectedBeforeRefresh ? restoredModelAfterDiscovery(studio) : null;
    selectModel(
      restoredModel
      || studio.models.find((model) => model.id === selectedId)
      || (selectedBeforeRefresh?.family === "ollama" && selectedBeforeRefresh.endpoint === studio.ollamaHost ? selectedBeforeRefresh : null)
      || (selectedBeforeRefresh?.family === "api" ? selectedBeforeRefresh : null)
      || restoredModelAfterDiscovery(studio),
      { preserveSettingsProvider: studio.root.classList.contains("is-settings-open") },
    );
    studio.preferencesRestoring = false;
    if (!studio.requestBusy) setGenerationState("idle", "", "");
    refreshGGUFRuntimeDiagnostics();
  } catch (error) {
    if (studio.modelDiscoveryAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    studio.preferencesRestoring = false;
    showToast(error.code || "Model scan failed", error.message, error.details);
  } finally {
    // A newer selection can invalidate the result, but must not leave startup
    // restoration active. A newer discovery owns its own completion instead.
    if (studio.modelDiscoveryAttempt === attempt) {
      studio.preferencesRestoring = false;
    }
  }
}

async function configureOllamaHost(form) {
  const submit = form.querySelector('[type="submit"]');
  const requestedHost = normalizeOllamaHost(form.elements.host.value);
  submit.disabled = true;
  submit.textContent = "Checking…";
  try {
    const status = await getOllamaStatus(requestedHost);
    const endpoint = normalizeOllamaHost(status.endpoint || requestedHost);
    const changed = endpoint !== studio.ollamaHost;
    const ollamaWasSelected = studio.selectedModel?.family === "ollama";
    studio.ollamaHost = endpoint;
    studio.ollamaModelName = loadOllamaModel(localStorage, endpoint);
    studio.ollamaStatus = status;
    studio.ollamaError = status.error || null;
    studio.ollamaHostSettingsOpen = false;
    studio.ollamaStorageHelpOpen = false;
    saveOllamaHost(localStorage, endpoint);
    form.elements.host.value = endpoint;
    studio.models = [...studio.models.filter((model) => model.family !== "ollama"), ...(status.compatible_models || [])];
    studio.promptResidency.ollama = [];
    const model = ollamaModelForSettings();
    if (studio.settingsProvider === "ollama" && model) {
      selectModel(model);
    } else if (ollamaWasSelected) {
      selectModel(
        studio.models.find((candidate) => candidate.family !== "ollama" && candidate.runtime_ready) || null,
        { preserveSettingsProvider: true },
      );
    } else {
      renderInferenceSettings();
      syncRuntimeSummary();
    }
    syncOllamaAutoDetection();
    showToast(
      changed ? "Ollama host updated" : "Ollama host checked",
      endpoint === DEFAULT_OLLAMA_HOST ? "Using Ollama on this computer." : `Using ${endpoint}.`,
    );
  } catch (error) {
    showToast(error.code || "Invalid Ollama host", error.message, error.details);
    renderInferenceSettings();
  } finally {
    submit.disabled = false;
    submit.textContent = "Apply";
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
    const requestedHost = studio.ollamaHost;
    const status = await getOllamaStatus(requestedHost);
    if (requestedHost !== studio.ollamaHost) return;
    studio.ollamaStatus = status;
    studio.ollamaError = status.error || null;
    studio.models = [...studio.models.filter((model) => model.family !== "ollama"), ...(status.compatible_models || [])];
    const model = ollamaModelForSettings();
    if (model && studio.settingsProvider === "ollama") selectModel(model);
    else renderInferenceSettings();
    if (!automatic && status.state !== "ready") {
      showToast(
        status.state === "not_installed" ? "Ollama is not installed" : "Ollama is not running",
        studio.ollamaHost !== DEFAULT_OLLAMA_HOST
          ? `The Ollama service at ${studio.ollamaHost} is not responding.`
          : status.state === "not_installed"
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
  if (open && studio.mode === "Music3") toggleLyricsRefine(false);
  panel.hidden = !open;
  outputPanel.classList.toggle("is-refining", open);
  if (open) scheduleStudioFocus(() => panel.querySelector("textarea"));
}

function toggleLyricsRefine(open) {
  if (!studio) return;
  const panel = studio.root.querySelector("[data-lyrics-refine-panel]");
  if (open) toggleRefine(false);
  panel.hidden = !open;
  if (open) scheduleStudioFocus(() => panel.querySelector("textarea"));
}

async function cancelLyricsRefinement() {
  if (!studio.lyricsRequestBusy) {
    toggleLyricsRefine(false);
    return;
  }
  const submit = studio.root.querySelector("[data-lyrics-refine-submit]");
  submit.innerHTML = `<span class="h3ps-spinner"></span>Cancelling…`;
  try {
    await cancel();
  } catch (error) {
    showToast(error.code || "Cancel failed", error.message, error.details);
  }
}

async function submitLyricsRefinement() {
  const panel = studio.root.querySelector("[data-lyrics-refine-panel]");
  const submit = panel.querySelector("[data-lyrics-refine-submit]");
  const instruction = panel.querySelector("[data-lyrics-refine-instruction]").value.trim();
  const lyrics = studio.root.querySelector("[data-music-lyrics]");
  const currentLyrics = lyrics.value;
  const useMusicBrief = panel.querySelector("[data-lyrics-use-brief]").checked;
  const musicBrief = studio.root.querySelector("[data-music-brief]").value.trim();
  if (submit.disabled || studio.requestBusy) return;
  if (currentLyrics.trim() && !instruction) {
    showToast("Add a revision note", "Describe how the existing Lyrics should change.");
    return;
  }
  if (!currentLyrics.trim() && !instruction && (!useMusicBrief || !musicBrief)) {
    showToast("Describe the Lyrics", "Add an instruction or include a Music Brief to create new Lyrics.");
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
  if (!generationModeIsAvailable()) return;
  if (!await prepareWriterRequest()) return;

  markActiveWriterRequest();
  studio.lyricsRequestBusy = true;
  submit.disabled = true;
  submit.innerHTML = `<span class="h3ps-spinner"></span>${currentLyrics.trim() ? "Refining…" : "Creating…"}`;
  setGenerationState("busy", currentLyrics.trim() ? "Refining lyrics" : "Creating lyrics", studio.selectedModel.name.split("/").pop());
  try {
    const result = await vramHandoffCoordinator.trackWriterRequest(refine(buildLyricsRefinePayload(studio, {
      currentLyrics,
      instruction,
      useMusicBrief,
      creativeBrief: musicBrief,
      seed: newGenerationSeed(),
    })));
    if (lyrics.value !== currentLyrics) {
      showToast("Lyrics kept", "The rewrite was not applied because you edited the Lyrics.");
      return;
    }
    studio.lyricsRestore = { lyrics: currentLyrics };
    lyrics.value = result.prompt;
    const restore = panel.querySelector("[data-lyrics-refine-restore]");
    restore.textContent = currentLyrics.trim() ? "Restore previous" : "Remove generated";
    restore.hidden = false;
    updateMusicLyricsCount();
    saveCurrentModeDraft();
    studio.desktopNotifications.notify("Lyrics request finished.");
    showToast(
      currentLyrics.trim() ? "Lyrics rewritten" : "Lyrics created",
      `${result.total_seconds.toFixed(1)}s · ${result.tokens_per_second.toFixed(1)} tok/s`,
    );
  } catch (error) {
    if (error.code !== "GENERATION_CANCELLED") studio.desktopNotifications.notify("Lyrics request failed. Open Writer for details.");
    if (error.code === "GENERATION_CANCELLED") showToast("Lyrics request cancelled", "The previous Lyrics were kept.");
    else if (error.code === "INSUFFICIENT_FREE_VRAM") showVramRetry(error, submitLyricsRefinement);
    else showToast(error.code || "Lyrics request failed", error.message, error.details);
  } finally {
    studio.lyricsRequestBusy = false;
    submit.disabled = false;
    submit.innerHTML = `${icon("spark", 13)} Refine`;
    try {
      const status = await getStatus(studio.ollamaHost);
      updatePromptResidency(status);
    } catch {}
    clearActiveWriterRequest();
    setGenerationState("idle", "", "");
  }
}

async function submitRefinement() {
  const panel = studio.root.querySelector("[data-refine-panel]");
  const submit = panel.querySelector("[data-refine-submit]");
  const instruction = panel.querySelector("textarea").value.trim();
  const output = studio.root.querySelector("[data-output]");
  if (submit.disabled || studio.requestBusy) return;
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
  if (!generationModeIsAvailable()) return;
  if (!await prepareWriterRequest()) return;

  const previousPrompt = output.value;
  const previousMeta = studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent;
  markActiveWriterRequest();
  submit.disabled = true;
  submit.innerHTML = `<span class="h3ps-spinner"></span>Refining…`;
  setGenerationState("busy", "Refining prompt", studio.selectedModel.name.split("/").pop());
  try {
    const result = await vramHandoffCoordinator.trackWriterRequest(refine(buildRefinePayload(studio, {
      currentPrompt: previousPrompt,
      instruction,
      creativeBrief: currentBriefTextarea().value.trim(),
      lyrics: studio.mode === "Music3" ? studio.root.querySelector("[data-music-lyrics]").value : "",
      seed: newGenerationSeed(),
    })));
    if (output.value !== previousPrompt) {
      showToast("Prompt kept", "The rewrite was not applied because you edited the prompt.");
      return;
    }
    studio.refineRestore = {
      prompt: previousPrompt,
      meta: previousMeta,
      lastModelPrompt: studio.lastModelPrompt,
      lastModelMeta: studio.lastModelMeta,
    };
    output.value = result.prompt;
    studio.lastModelPrompt = result.prompt;
    renderPromptHighlights();
    if (panel.querySelector("textarea").value.trim() === instruction) {
      panel.querySelector("textarea").value = "";
    }
    panel.querySelector("[data-refine-restore]").hidden = false;
    studio.lastModelMeta = formatGenerationMeta(result);
    syncRuntimeSummary(result);
    studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.lastModelMeta;
    syncModifiedState();
    saveCurrentModeDraft();
    studio.desktopNotifications.notify("Refinement finished. Your prompt is ready.");
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
    if (error.code !== "GENERATION_CANCELLED") studio.desktopNotifications.notify("Refinement failed. Open Writer for details.");
    if (error.code === "INSUFFICIENT_FREE_VRAM") showVramRetry(error, submitRefinement);
    else showToast(error.code || "Refinement failed", error.message, error.details);
  } finally {
    submit.disabled = false;
    submit.innerHTML = `${icon("spark", 13)} Refine`;
    try {
      const status = await getStatus(studio.ollamaHost);
      updatePromptResidency(status);
    } catch {}
    clearActiveWriterRequest();
    setGenerationState("idle", "", "");
  }
}

function musicSystemPromptPanelMarkup(profile, label, description, hidden = false) {
  return `
    <div class="h3ps-system-prompt-panel" data-music-system-prompt-panel="${profile}" ${hidden ? "hidden" : ""}>
      <header class="h3ps-system-prompt-editor-heading">
        <button type="button" data-music-system-prompt-back>${icon("chevron", 12)} Back</button>
        <span><small>System prompt</small><strong>${label}</strong></span>
        <span class="h3ps-system-prompt-panel-status"><em data-system-prompt-status="${profile}">Default</em>${icon("check", 13)}</span>
      </header>
      <p>${description}</p>
      <textarea data-system-prompt="${profile}" maxlength="8000" spellcheck="true" disabled></textarea>
      <footer><small data-system-prompt-count="${profile}">0 / 8,000</small><button type="button" data-system-prompt-reset="${profile}" hidden>Restore default</button></footer>
    </div>`;
}

function syncFullscreenState() {
  if (!studio) return;
  studio.root.classList.toggle("is-fullscreen", studio.fullscreen);
  const button = studio.root.querySelector("[data-fullscreen-toggle]");
  button.setAttribute("aria-pressed", String(studio.fullscreen));
  button.setAttribute("aria-label", studio.fullscreen ? "Exit fullscreen" : "Enter fullscreen");
  button.title = studio.fullscreen ? "Exit fullscreen" : "Enter fullscreen";
  button.innerHTML = icon(studio.fullscreen ? "collapse" : "expand", 17);
}

function syncTheme() {
  if (!studio) return;
  studio.root.dataset.theme = studio.theme;
  studio.floatingMedia?.refresh();
  const button = studio.root.querySelector("[data-theme-toggle]");
  if (!button) return;
  const light = studio.theme === "light";
  button.innerHTML = icon(light ? "moon" : "sun", 17);
  button.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
  button.title = light ? "Switch to dark theme" : "Switch to light theme";
  button.setAttribute("aria-pressed", String(light));
}

function setTheme(theme) {
  if (!studio) return;
  studio.theme = theme === "light" ? "light" : "dark";
  syncTheme();
  saveUserPreferences(localStorage, studio);
}

function syncInterfaceSize() {
  if (!studio) return;
  const size = INTERFACE_SIZES.includes(studio.interfaceSize) ? studio.interfaceSize : "100";
  const index = INTERFACE_SIZES.indexOf(size);
  studio.interfaceSize = size;
  studio.root.dataset.interfaceSize = size;
  studio.floatingMedia?.refresh();
  const slider = studio.root.querySelector("[data-interface-size-range]");
  const output = studio.root.querySelector("[data-interface-size-value]");
  const button = studio.root.querySelector("[data-interface-size-toggle]");
  if (slider) {
    slider.value = String(index);
    slider.setAttribute("aria-valuetext", `${size}%`);
    slider.style.setProperty("--h3ps-range", `${index / (INTERFACE_SIZES.length - 1) * 100}%`);
  }
  if (output) output.textContent = `${size}%`;
  if (button) {
    button.setAttribute("aria-label", `Interface size ${size}%`);
    button.title = `Interface size ${size}%`;
  }
}

function setInterfaceSize(size) {
  if (!studio) return;
  studio.interfaceSize = INTERFACE_SIZES.includes(String(size)) ? String(size) : "100";
  syncInterfaceSize();
  saveUserPreferences(localStorage, studio);
}

function setInterfaceSizeMenuOpen(open, restoreFocus = false) {
  if (!studio) return;
  const menu = studio.root.querySelector("[data-interface-size-menu]");
  const button = studio.root.querySelector("[data-interface-size-toggle]");
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (restoreFocus) button.focus();
}

function setFullscreen(fullscreen) {
  if (!HOST_CAPABILITIES.windowed) fullscreen = true;
  if (!studio || studio.fullscreen === fullscreen) return;
  studio.fullscreen = fullscreen;
  syncFullscreenState();
  requestAnimationFrame(updateBriefLayout);
  saveUserPreferences(localStorage, studio);
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
    <section class="h3ps-modal" role="dialog" aria-label="H3 Prompt Writer" hidden>
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
            <button class="h3ps-guide-button" type="button" aria-expanded="false" data-guide-toggle>Official guides ${icon("chevron", 13)}</button>
            <div class="h3ps-guide-menu" data-guide-menu hidden><span>Loading guides…</span></div>
          </div>
          <button class="h3ps-guide-button" type="button" data-open-settings-header>Settings</button>
          ${supportsWorkflowMedia() ? `<button class="h3ps-icon-button" type="button" data-open-floating-media title="Media panel" aria-label="Media panel">${icon("grid", 17)}</button>` : ""}
          <button class="h3ps-icon-button" type="button" title="Switch to light theme" aria-label="Switch to light theme" aria-pressed="false" data-theme-toggle>${icon("sun", 17)}</button>
          <div class="h3ps-interface-size-picker" data-interface-size-picker>
            <button class="h3ps-icon-button h3ps-interface-size-button" type="button" title="Interface size 100%" aria-label="Interface size 100%" aria-haspopup="true" aria-expanded="false" data-interface-size-toggle>Aa</button>
            <div class="h3ps-interface-size-menu" data-interface-size-menu hidden>
              <header><strong>Interface Size</strong><output data-interface-size-value>100%</output></header>
              <input type="range" min="0" max="3" step="1" value="0" aria-label="Interface size" data-interface-size-range>
              <div class="h3ps-interface-size-marks" aria-hidden="true"><span>100%</span><span>110%</span><span>120%</span><span>125%</span></div>
            </div>
          </div>
          <button class="h3ps-icon-button" type="button" title="Enter fullscreen" aria-label="Enter fullscreen" aria-pressed="false" data-fullscreen-toggle>${icon("expand", 17)}</button>
          <button class="h3ps-icon-button" type="button" title="Close" data-close-studio>${icon("close", 18)}</button>
        </div>
      </header>

      ${settingsMarkup(icon)}

      <div class="h3ps-workspace-toolbar" data-generate-view>
        <nav class="h3ps-modes" role="tablist" aria-label="Generation mode" data-video-modes>
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
            <div class="h3ps-section-actions">
              <div class="h3ps-clear-control" data-clear-control>
                ${splitMenuMarkup(icon, {label: "Actions", primary: "data-actions-menu-toggle", toggle: "data-clear-menu-toggle", menu: "data-clear-menu", ariaLabel: "Media actions", contents: `
                  ${supportsWorkflowMedia() ? `<button type="button" data-open-floating-media data-media-panel-action disabled title="Add media first"><strong>Media panel</strong><small>ADD TO WORKFLOW</small></button>` : ""}
                  <button type="button" data-open-composer disabled><strong>Compose</strong><small>Create collage</small></button>
                  <hr data-compose-separator>
                  <button type="button" data-draft-save><strong>Save text draft</strong><small>Download JSON</small></button>
                  <button type="button" data-draft-load><strong>Load text draft</strong><small>Open JSON</small></button>
                  <input type="file" accept=".json,application/json" data-draft-file hidden>
                  <hr>
                  <button type="button" data-clear-action data-clear-media><strong>Clear media</strong><small>Keep prompts</small></button>
                  <button type="button" data-clear-action data-clear-prompts><strong>Clear prompts</strong><small>Keep media</small></button>
                  <button class="is-destructive" type="button" data-clear-action data-clear-all><strong>Clear all</strong><small>Media and prompts</small></button>
                `})}
              </div>
            </div>
          </div>
          <p class="h3ps-section-hint" data-h3ps-mode-hint></p>
          <div class="h3ps-media" data-h3ps-media></div>

          <div class="h3ps-control-grid">
            <label class="h3ps-field h3ps-duration-field"><span>Duration <b data-duration-label>10 seconds</b></span><div><input type="range" min="1" max="20" step="1" value="10" style="--h3ps-range:47.37%" data-duration-slider><i></i></div></label>
            ${aspectRatioMarkup(icon)}
          </div>

          <label class="h3ps-brief">
            <span><strong>Creative brief</strong><small>Describe what should happen in the video</small></span>
            <textarea spellcheck="true" data-video-brief>Use identity and wardrobe from Picture 1 and the slow lateral camera movement from Video 1. A solitary character waits at a rain-soaked tram stop at blue hour, notices an approaching light and turns into the wind. End on a quiet, unresolved look; keep the shot cinematic, realistic and restrained.</textarea>
            <small class="h3ps-char-count">0 characters</small>
          </label>

          </div>

          <div class="h3ps-music-inputs" data-music-inputs hidden>
            <label class="h3ps-brief">
              <span><strong>Music brief</strong><small>Describe the sound, vocals, mood, arrangement or production</small></span>
              <textarea spellcheck="true" maxlength="2000" data-music-brief>${MUSIC3_DEFAULT_DRAFT.brief}</textarea>
              <small class="h3ps-char-count">0 / 2,000</small>
            </label>
            <label class="h3ps-brief h3ps-lyrics">
              <span><strong>Lyrics</strong><small>Optional</small></span>
              <textarea spellcheck="true" maxlength="4000" data-music-lyrics placeholder="[Verse 1]&#10;...&#10;&#10;[Chorus]&#10;..."></textarea>
              <small class="h3ps-char-count">0 / 4,000</small>
            </label>
            <div class="h3ps-lyrics-refine-tools">
              <button class="h3ps-secondary-button" type="button" title="Refine Lyrics with the selected prompt model" data-lyrics-refine-toggle>${icon("spark", 15)} Refine</button>
            </div>
            <section class="h3ps-refine h3ps-lyrics-refine" data-lyrics-refine-panel hidden>
              <div class="h3ps-refine-heading">
                <span><strong>Refine lyrics</strong><small>Create new Lyrics or rewrite the current text</small></span>
                <label class="h3ps-lyrics-brief-option"><input type="checkbox" data-lyrics-use-brief checked>Use Music Brief</label>
              </div>
              <textarea rows="2" data-lyrics-refine-instruction placeholder="Leave Lyrics empty to create new lyrics, or describe how to rewrite the existing lyrics."></textarea>
              <div class="h3ps-refine-actions">
                <button type="button" class="h3ps-text-button" data-lyrics-refine-restore hidden>Restore previous</button>
                <span></span>
                <button type="button" class="h3ps-text-button" data-lyrics-refine-cancel>Cancel</button>
                <button type="button" class="h3ps-refine-submit" data-lyrics-refine-submit>${icon("spark", 13)} Refine</button>
              </div>
            </section>
            <section class="h3ps-music-system-prompt">
              <button class="h3ps-music-system-prompt-toggle" type="button" data-music-system-prompt-toggle aria-expanded="false">
                <strong>System prompt</strong>
                <span><em data-music-system-prompt-summary>Default</em>${icon("chevron", 12)}</span>
              </button>
              <div data-music-system-prompt-details hidden>
                <div class="h3ps-system-prompt-overview" data-music-system-prompt-overview>
                  <button type="button" data-music-system-prompt-profile="music3">
                    <span><strong>Caption</strong><small>Generated Caption</small></span>
                    <span><em data-system-prompt-summary-status="music3">Default</em><b>Edit</b>${icon("chevron", 12)}</span>
                  </button>
                  <button type="button" data-music-system-prompt-profile="music3_lyrics">
                    <span><strong>Lyrics</strong><small>Create and refine Lyrics</small></span>
                    <span><em data-system-prompt-summary-status="music3_lyrics">Default</em><b>Edit</b>${icon("chevron", 12)}</span>
                  </button>
                </div>
                <div class="h3ps-system-prompt-editor" data-music-system-prompt-editor hidden>
                  ${musicSystemPromptPanelMarkup("music3", "Caption", "Instructions used to create and refine the structured Music 3 caption.")}
                  ${musicSystemPromptPanelMarkup("music3_lyrics", "Lyrics", "Instructions used to create new Lyrics or rewrite the current Lyrics.", true)}
                </div>
              </div>
            </section>
          </div>

          ${generateModelSummaryMarkup(icon)}
        </section>

        <section class="h3ps-output-panel" aria-label="Generated result">
          <div class="h3ps-output-mobile-toolbar" aria-hidden="true"><span data-output-mobile-label>Generated prompt</span></div>
          <div class="h3ps-editor-wrap">
            <div class="h3ps-editor-highlight" data-prompt-highlights aria-hidden="true"></div>
            <textarea class="h3ps-editor" aria-label="Generated prompt" spellcheck="false" data-output>${SAMPLE_PROMPT}</textarea>
            <div class="h3ps-reference-peek" data-reference-peek hidden></div>
            <div class="h3ps-editor-meta"><span>${promptLengthMeta(SAMPLE_PROMPT)}</span></div>
          </div>
          <div class="h3ps-refine" data-refine-panel hidden>
            <div class="h3ps-refine-heading">
              <span><strong data-refine-title>Refine prompt</strong><small><span data-refine-helper>Describe only what should change</span><em data-refine-media-note>No media re-upload</em></small></span>
              <div class="h3ps-refine-heading-actions">
                <button type="button" class="h3ps-text-button" data-refine-restore hidden>Restore original</button>
                <button type="button" class="h3ps-text-button" data-refine-cancel>Cancel</button>
                <button type="button" class="h3ps-refine-submit" data-refine-submit>${icon("spark", 13)} Refine</button>
              </div>
            </div>
            <textarea rows="2" data-refine-instruction placeholder="For example: make the camera movement slower and keep the ending more ambiguous."></textarea>
          </div>
          <div class="h3ps-output-actions">
            <span class="h3ps-output-primary-actions">
              <button class="h3ps-secondary-button" type="button" title="Refine with local LLM" data-refine-toggle>${icon("spark", 15)} Refine</button>
            </span>
            ${copyButtonMarkup(icon, "data-copy", '<span data-copy-label>Copy prompt</span>')}
          </div>
        </section>
      </div>

      <footer class="h3ps-footer" data-generate-view>
        <div class="h3ps-footer-memory-actions">
          <button class="h3ps-memory-action" type="button" data-comfy-memory-action title="Unload models held by ComfyUI without clearing cached workflow results">${icon("memory", 15)}Free ComfyUI VRAM</button>
          <span class="h3ps-prompt-lifecycle-actions" data-prompt-lifecycle-actions></span>
        </div>
        <div class="h3ps-status is-busy" role="status" aria-live="polite" aria-atomic="true" data-status hidden><span><strong></strong><small data-status-detail></small></span></div>
        <div class="h3ps-footer-actions">
          <span class="h3ps-generation-options">
            <label class="h3ps-toggle-control"><input type="checkbox" data-thinking><span></span>Thinking</label>
            <label class="h3ps-toggle-control" data-keep-loaded-control title="Keep the prompt model in VRAM for the next prompt"><input type="checkbox" data-keep-loaded><span></span>Keep model loaded</label>
            ${autoVramControlMarkup(VRAM_HANDOFF_SUPPORTED)}
          </span>
          <button class="h3ps-primary-button" type="button" data-generate>${icon("spark", 16)}<span data-generate-label>Generate prompt</span></button>
        </div>
      </footer>
    </section>

    <div class="h3ps-other-models-backdrop" aria-hidden="true" data-other-models-backdrop hidden></div>
    <section class="h3ps-other-models-popover" role="dialog" aria-label="Other verified models" data-other-models-popover hidden>
      <header><span><strong>Other verified models</strong><small>Recommended GGUF and projector pairs</small></span><button class="h3ps-icon-button" type="button" aria-label="Close verified models" data-other-models-close>${icon("close", 16)}</button></header>
      <div class="h3ps-other-models-catalog" data-other-models-catalog></div>
    </section>

    <div class="h3ps-toast" role="status" aria-live="polite" aria-atomic="true" data-h3ps-toast><span class="h3ps-toast-icon">${icon("info", 17)}</span><span><strong data-toast-title>Notice</strong><span data-toast-message></span><button type="button" class="h3ps-toast-action" data-toast-action hidden></button><details data-toast-details hidden><summary>Technical details</summary><pre></pre></details></span></div>`;
  document.body.appendChild(root);

  studio = { root, ...createStudioState({ sessionId: createSessionId(), storage: localStorage }) };
  root.querySelector("[data-comfy-memory-action]").hidden = !HOST_CAPABILITIES.comfyMemory;
  if (!HOST_CAPABILITIES.windowed) {
    studio.fullscreen = true;
    root.querySelectorAll("[data-close-studio], [data-fullscreen-toggle]").forEach(control => { control.hidden = true; });
  }
  const onMediaToolOpenChange = (open) => {
    const modal = root.querySelector(".h3ps-modal");
    modal.inert = open;
    if (open) modal.removeAttribute("aria-modal");
    else if (root.classList.contains("is-open")) modal.setAttribute("aria-modal", "true");
  };
  const mediaToolUnavailable = (message) => showToast("Media tool unavailable", message);
  studio.mediaComposer = createLazyMediaTool(root, async () => {
    const { createMediaComposer } = await import("./media_composer.js");
    return createMediaComposer({
      root,
      icon,
      onAddPicture: addComposedPicture,
      getAddState: composerAddState,
      notify: (kind, message) => showToast(kind === "error" ? "Composer failed" : "Media Composer", message),
      onOpenChange: onMediaToolOpenChange,
    });
  }, mediaToolUnavailable);
  studio.mediaEditor = createLazyMediaTool(root, async () => {
    const { createMediaEditor } = await import("./media_editor.js");
    return createMediaEditor({
      root,
      icon,
      onAddFrame: async (blob, filename) => {
        const file = new File([blob], filename, { type: "image/png" });
        const result = await uploadMedia(studio.sessionId, "Reference", [file]);
        studio.assets.push(...result.assets);
        showToast("Picture added", result.assets[0].reference);
        renderMedia(studio.mode);
      },
      onAddAudio: async (blob, filename) => {
        const result = await uploadMedia(studio.sessionId, "Reference", [new File([blob], filename, { type: "audio/wav" })]);
        studio.assets.push(...result.assets);
        showToast("Audio added", `${result.assets[0].reference}. Connect the downloaded WAV separately in H3. Writer does not analyze sound; describe its role in the Brief.`);
        renderMedia(studio.mode);
      },
      request: (assetId, options) => editMedia(studio.sessionId, assetId, options),
      onSaved: (result) => {
        showToast("Media applied", "Crop and trim applied. The original source is preserved.");
        acceptMediaAssets(result.assets);
        renderMedia(studio.mode);
      },
      notify: (message) => showToast("Media Editor", message),
      onOpenChange: onMediaToolOpenChange,
    });
  }, mediaToolUnavailable);
  root.querySelector("[data-lyrics-use-brief]").checked = studio.musicLyricsUseBrief;
  const durationSlider = root.querySelector("[data-duration-slider]");
  durationSlider.value = String(studio.durationSeconds);
  durationSlider.style.setProperty("--h3ps-range", `${(studio.durationSeconds - 1) / 19 * 100}%`);
  root.querySelector("[data-duration-label]").textContent = `${studio.durationSeconds} seconds`;
  studio.aspectControl = bindAspectRatio(root.querySelector('[data-choice-toggle="aspect"]').closest(".h3ps-choice"), studio.aspectRatio, value => {
    studio.aspectRatio = value;
    saveUserPreferences(localStorage, studio);
  });
  syncTheme();
  syncInterfaceSize();
  syncFullscreenState();
  root.querySelectorAll("[data-close-studio]").forEach((el) => el.addEventListener("click", closeStudio));
  root.querySelector("[data-fullscreen-toggle]").addEventListener("click", () => setFullscreen(!studio.fullscreen));
  root.querySelector("[data-theme-toggle]").addEventListener("click", () => setTheme(studio.theme === "light" ? "dark" : "light"));
  root.querySelectorAll("[data-open-floating-media]").forEach(button => button.addEventListener("click", openFloatingMedia));
  root.querySelector("[data-open-composer]").addEventListener("click", (event) => openMediaComposer(event.currentTarget));
  root.querySelector("[data-interface-size-toggle]").addEventListener("click", () => {
    const menu = root.querySelector("[data-interface-size-menu]");
    setInterfaceSizeMenuOpen(menu.hidden);
  });
  root.querySelector("[data-interface-size-range]").addEventListener("input", (event) => {
    setInterfaceSize(INTERFACE_SIZES[Number(event.target.value)] || "100");
  });
  root.addEventListener("click", (event) => {
    if (studio.draftDefaultsArmed && !event.target.closest("[data-restore-default-drafts]")) disarmDraftDefaults();
    if (studio.toastDismissOnWorkspaceClick && !event.target.closest("[data-h3ps-toast]")) hideToast();
    if (!event.target.closest("[data-other-models-toggle], [data-other-models-popover]")) setOtherModelsPopover(false);
    if (!isRuntimeMenuInteraction(event.target)) closeRuntimeMenus();
    if (!isChoiceMenuInteraction(event.target)) {
      root.querySelectorAll("[data-choice-menu]").forEach((menu) => { menu.hidden = true; });
      root.querySelectorAll("[data-choice-toggle]").forEach((button) => button.setAttribute("aria-expanded", "false"));
    }
    if (!isGuideMenuInteraction(event.target)) {
      root.querySelectorAll("[data-guide-menu]").forEach((menu) => { menu.hidden = true; });
      root.querySelector("[data-guide-toggle]")?.setAttribute("aria-expanded", "false");
    }
    if (!event.target.closest("[data-interface-size-picker]")) setInterfaceSizeMenuOpen(false);
    if (!event.target.closest("[data-model-files-toggle], [data-model-files-menu]")) {
      root.querySelectorAll("[data-model-files-menu]").forEach((menu) => { menu.hidden = true; });
    }
    if (!event.target.closest("[data-clear-control]")) setClearMenuOpen(false);
  });
  root.querySelectorAll("[data-workspace]").forEach((button) => button.addEventListener("click", () => {
    const nextMode = button.dataset.workspace === "music" ? "Music3" : studio.lastVideoMode;
    if (!isGenerationModeAvailable(studio.selectedModel, nextMode)) return;
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
    if (!isGenerationModeAvailable(studio.selectedModel, button.dataset.mode)) return;
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
  root.querySelector("[data-clear-media]").addEventListener("click", () => {
    setClearMenuOpen(false);
    clearCurrentMedia();
  });
  root.querySelectorAll("[data-clear-menu-toggle], [data-actions-menu-toggle]").forEach(toggle => toggle.addEventListener("click", () => {
    const menu = root.querySelector("[data-clear-menu]");
    setClearMenuOpen(menu.hidden);
  }));
  root.querySelector("[data-clear-prompts]").addEventListener("click", () => {
    setClearMenuOpen(false);
    clearCurrentPrompts();
  });
  root.querySelector("[data-clear-all]").addEventListener("click", () => {
    setClearMenuOpen(false);
    clearEverything();
  });
  root.querySelector("[data-generate]").addEventListener("click", startGenerationPreview);
  studio.desktopNotifications = createDesktopNotifications({ storage: localStorage, document, window });
  const notificationsToggle = root.querySelector("[data-desktop-notifications]");
  const syncNotifications = () => {
    notificationsToggle.checked = studio.desktopNotifications.enabled;
    root.querySelector("[data-desktop-notifications-hint]").textContent = studio.desktopNotifications.hint;
  };
  notificationsToggle.addEventListener("change", async () => {
    notificationsToggle.disabled = true;
    try { await studio.desktopNotifications.setEnabled(notificationsToggle.checked); }
    finally { notificationsToggle.disabled = false; syncNotifications(); }
  });
  syncNotifications();
  root.querySelector("[data-draft-save]").onclick=()=>{ setClearMenuOpen(false); saveTextDraft(); };
  const draftInput=root.querySelector("[data-draft-file]");
  root.querySelector("[data-draft-load]").onclick=()=>{ if(!studio.requestBusy) { setClearMenuOpen(false); draftInput.click(); } };
  draftInput.onchange=async()=>{
    const file=draftInput.files[0]; draftInput.value="";
    if(!file || studio.requestBusy) return;
    try {
      if(file.size>2_000_000) throw Error("Draft file is too large (maximum 2 MB).");
      const value=parseDraft(await file.text());
      showToast("Load text draft?", "This replaces the target draft and clears its current media. Files are not included; reattach the original references after loading.",
        value.media.length ? {references:value.media} : null, {label:"Load draft",onClick:()=>loadTextDraft(value)});
    } catch(error) { showToast("Load draft",error.message); }
  };
  root.querySelector("[data-restore-default-drafts]").addEventListener("click", restoreDefaultDrafts);
  root.querySelector("[data-comfy-memory-action]").addEventListener("click", () => releaseComfyVram());
  root.querySelector("[data-guide-toggle]").addEventListener("click", async () => {
    const menu = root.querySelector("[data-guide-menu]");
    menu.hidden = !menu.hidden;
    root.querySelector("[data-guide-toggle]").setAttribute("aria-expanded", String(!menu.hidden));
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

  root.querySelector("[data-duration-slider]").addEventListener("input", (event) => {
    studio.durationSeconds = Number(event.target.value);
    root.querySelector("[data-duration-label]").textContent = `${studio.durationSeconds} seconds`;
    event.target.style.setProperty("--h3ps-range", `${(studio.durationSeconds - 1) / 19 * 100}%`);
    saveUserPreferences(localStorage, studio);
  });
  root.querySelectorAll("[data-runtime-toggle]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    const name = button.dataset.runtimeToggle;
    const menu = root.querySelector(`[data-runtime-menu="${name}"]`);
    const open = menu.hidden;
    closeRuntimeMenus();
    setRuntimeMenuOpen(name, open);
  }));
  root.querySelectorAll("[data-runtime-option]").forEach((button) => button.addEventListener("click", (event) => applyRuntimeOption(button, event)));
  root.querySelector("[data-custom-context-input]").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    studio.contextTokens = Number.isInteger(value) && value > 0 ? value : null;
    syncRuntimeSummary();
    syncThinkingAvailability();
    rememberRuntimePreferences();
    saveUserPreferences(localStorage, studio);
  });
  root.querySelector("[data-custom-generation-budget-input]").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    studio.generationBudgetTokens = Number.isInteger(value) && value > 0 ? value : null;
    syncRuntimeSummary();
    rememberRuntimePreferences();
    saveUserPreferences(localStorage, studio);
  });
  syncRuntimeSummary();
  root.querySelectorAll("[data-system-prompt-profile]").forEach((button) => button.addEventListener("click", () => {
    setSystemPromptProfile(button.dataset.systemPromptProfile);
    setSystemPromptEditorOpen(true);
  }));
  root.querySelectorAll("[data-system-prompt-back]").forEach((button) => button.addEventListener("click", () => {
    setSystemPromptEditorOpen(false);
  }));
  root.querySelectorAll("[data-music-system-prompt-profile]").forEach((button) => button.addEventListener("click", () => {
    setMusicSystemPromptProfile(button.dataset.musicSystemPromptProfile);
    setMusicSystemPromptEditorOpen(true);
  }));
  root.querySelectorAll("[data-music-system-prompt-back]").forEach((button) => button.addEventListener("click", () => {
    setMusicSystemPromptEditorOpen(false);
  }));
  root.querySelector("[data-music-system-prompt-toggle]").addEventListener("click", () => {
    setMusicSystemPromptExpanded(!studio.musicSystemPromptExpanded);
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
    syncMusicSystemPromptSummary();
  }));
  root.querySelectorAll("[data-system-prompt-reset]").forEach((button) => button.addEventListener("click", () => {
    const profile = button.dataset.systemPromptReset;
    delete studio.customSystemPrompts[profile];
    saveCustomSystemPrompts(localStorage, studio.customSystemPrompts);
    syncSystemPromptEditor(profile);
    showToast("System Prompt reset", profile === "music3"
      ? "Music 3 Caption is using its built-in system prompt."
      : profile === "music3_lyrics"
      ? "Music 3 Lyrics is using its built-in system prompt."
      : `H3 Prompt Writer is using its default ${profile} instructions.`);
  }));
  root.querySelector("[data-thinking]").addEventListener("change", (event) => {
    studio.thinking = event.target.checked;
    syncRuntimeSummary();
  });
  root.querySelector("[data-keep-loaded]").addEventListener("change", (event) => {
    studio.keepModelLoaded = event.target.checked;
  });
  root.querySelector("[data-vram-handoff]")?.addEventListener("change", (event) => {
    studio.vramHandoff = event.target.checked;
    saveUserPreferences(localStorage, studio);
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
  root.querySelector("[data-lyrics-use-brief]").addEventListener("change", (event) => {
    studio.musicLyricsUseBrief = event.target.checked;
    saveUserPreferences(localStorage, studio);
  });

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
    const ollamaHostSummary = event.target.closest("[data-ollama-host-settings] summary");
    if (ollamaHostSummary) {
      studio.ollamaHostSettingsOpen = !ollamaHostSummary.closest("details").open;
      return;
    }
    const ollamaStorageSummary = event.target.closest("[data-ollama-storage-help] summary");
    if (ollamaStorageSummary) {
      studio.ollamaStorageHelpOpen = !ollamaStorageSummary.closest("details").open;
      return;
    }
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
    const ollamaHostForm = event.target.closest("[data-ollama-host-form]");
    if (ollamaHostForm) {
      event.preventDefault();
      configureOllamaHost(ollamaHostForm);
      return;
    }
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
  });
  root.querySelector("[data-refine-toggle]").addEventListener("click", () => toggleRefine(root.querySelector("[data-refine-panel]").hidden));
  root.querySelector("[data-refine-cancel]").addEventListener("click", () => toggleRefine(false));
  root.querySelector("[data-refine-submit]").addEventListener("click", submitRefinement);
  root.querySelector("[data-lyrics-refine-toggle]").addEventListener("click", () => {
    toggleLyricsRefine(root.querySelector("[data-lyrics-refine-panel]").hidden);
  });
  root.querySelector("[data-lyrics-refine-cancel]").addEventListener("click", cancelLyricsRefinement);
  root.querySelector("[data-lyrics-refine-submit]").addEventListener("click", submitLyricsRefinement);
  root.querySelector("[data-lyrics-refine-restore]").addEventListener("click", () => {
    if (studio.lyricsRestore == null) return;
    const lyrics = root.querySelector("[data-music-lyrics]");
    const previousLyrics = studio.lyricsRestore.lyrics;
    lyrics.value = previousLyrics;
    studio.lyricsRestore = null;
    root.querySelector("[data-lyrics-refine-restore]").hidden = true;
    updateMusicLyricsCount();
    saveCurrentModeDraft();
    showToast(
      previousLyrics.trim() ? "Previous Lyrics restored" : "Generated Lyrics removed",
      "The AI Lyrics change was discarded.",
    );
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
  root.querySelector("[data-copy]").addEventListener("click", () => copyPromptText(root.querySelector("[data-output]").value, studio.mode === "Music3"));
  root.querySelector("[data-output]").addEventListener("input", () => {
    syncModifiedState();
    renderPromptHighlights();
    syncOutputLengthMeta();
    saveCurrentModeDraft();

  });
  root.querySelector("[data-output]").addEventListener("scroll", renderPromptHighlights);
  const editor = root.querySelector("[data-output]");
  new ResizeObserver(renderPromptHighlights).observe(editor);
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
  studio.sequence = createSequenceWorkspace({
    root, icon, storage: localStorage, assets: () => studio.assets,
    isBusy: () => studio.requestBusy,
    snapshot: () => {
      if (!studio.selectedModel?.runtime_ready) throw new Error("Select a ready prompt model in Settings.");
      studio.modelSelectionRevision = (studio.modelSelectionRevision || 0) + 1;
      return buildGeneratePayload(studio, { creativeBrief: "", seed: newGenerationSeed() });
    },
    prepare: prepareWriterRequest,
    run: (payload, onEvent) => vramHandoffCoordinator.trackWriterRequest(generateSequence(payload, onEvent)),
    cancel: (operationId) => cancelSequence(operationId, studio.sessionId),
    busy: (busy) => {
      if (busy) markActiveWriterRequest(); else clearActiveWriterRequest();
      setGenerationState(busy ? "busy" : "idle", "Generating sequence", "Completed prompts are kept as each chunk finishes");
      root.querySelector(".h3ps-generation-options").inert = busy;
      root.querySelector("[data-settings-view]").inert = busy;
    },
    refresh: () => { syncWorkspace(); renderMedia(studio.mode); },
    clearMedia: () => clearCurrentMedia(),
    settled: (status) => studio.desktopNotifications.notify(status === "complete" ? "Sequence generation finished." : "Sequence needs attention. Open Writer for details."),
    error: (error) => showToast("Sequence", error.message, error.details || null, null, sequenceNotificationOptions(error)),
    copy: (text) => copyPromptText(text),
    insert: (editor, reference) => insertReferenceAtCaret(editor, reference, editor.selectionStart),
  });
  syncWorkspace();
  restoreModeDraft(studio.mode);
  renderMedia(studio.mode);
  renderPromptHighlights();
  syncSystemPromptEditors();
  setMusicSystemPromptProfile(studio.musicSystemPromptProfile);
  refreshModels();
  return studio;
}

function supportsWorkflowMedia() {
  return HOST_CAPABILITIES.workflowMedia && !!(app.canvas?.graph && window.LiteGraph?.createNode && app.clientPosToCanvasPos);
}

async function openFloatingMedia() {
  const current = createStudio();
  const hasMedia = () => current.assets.some(asset => ["image", "video", "audio"].includes(asset.type) && asset.content_url);
  if (!hasMedia()) { openStudio(); showToast("Add media first", ""); return; }
  if (!supportsWorkflowMedia()) { openStudio(); showToast("Workflow canvas unavailable", ""); return; }
  const request = ++mediaPanelRequest;
  try {
    if (!current.floatingMedia) {
      current.floatingMediaPending ||= Promise.all([
        import("./floating_media.js"), import("./workflow_media.js"), import("/scripts/api.js"),
      ]).then(([{ createFloatingMediaPanel }, { createWorkflowMediaTransfer, createMediaMaterializer }, { api }]) => {
        current.floatingMedia = createFloatingMediaPanel({
          app, getState: () => current, icon, openWriter: openStudio,
          transfer: createWorkflowMediaTransfer({ app, liteGraph: window.LiteGraph,
            getWorkflowRevision: () => workflowRevision,
            materialize: createMediaMaterializer((...args) => api.fetchApi(...args)) }),
        });
      }).finally(() => { current.floatingMediaPending = null; });
      await current.floatingMediaPending;
    }
    if (request !== mediaPanelRequest) return;
    if (!hasMedia()) { openStudio(); showToast("Add media first", ""); return; }
    if (closeStudio() === false) return;
    current.floatingMedia.open();
  } catch (error) { showToast("Media panel unavailable", error.message); }
}

function focusAvailableControl(element) {
  if (
    !element?.isConnected ||
    element.disabled ||
    element.closest('[hidden], [inert], [aria-hidden="true"]') ||
    !element.getClientRects().length
  ) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function scheduleStudioFocus(target) {
  const current = studio;
  const epoch = studioFocusEpoch;
  requestAnimationFrame(() => {
    if (
      studio !== current ||
      epoch !== studioFocusEpoch ||
      !current.root.classList.contains("is-open")
    ) return;
    focusAvailableControl(target());
  });
}

function openStudio() {
  mediaPanelRequest++;
  const current = createStudio();
  if (current.root.classList.contains("is-open")) return;
  studioFocusEpoch++;
  current.floatingMedia?.suspend(true);
  const modal = current.root.querySelector(".h3ps-modal");
  const opener = document.activeElement;
  studioReturnFocus = opener instanceof HTMLElement && !current.root.contains(opener) ? opener : null;
  setMusicSystemPromptExpanded(false);
  syncMusicSystemPromptSummary();
  modal.hidden = false;
  modal.inert = false;
  modal.setAttribute("aria-modal", "true");
  current.root.classList.add("is-open");
  current.root.setAttribute("aria-hidden", "false");
  document.body.classList.add("h3ps-modal-open");
  modal.tabIndex = -1;
  updateBriefLayout();
  scheduleStudioFocus(() => modal.querySelector("button[data-close-studio]:not([hidden])") || modal);
}

function closeStudio() {
  if (!HOST_CAPABILITIES.windowed) return false;
  mediaPanelRequest++;
  if (!studio?.root.classList.contains("is-open")) return;
  const modal = studio.root.querySelector(".h3ps-modal");
  if (studio.mediaEditor?.close() === false) return false;
  if (studio.mediaComposer?.close() === false) return false;
  studio.sequence?.leave();
  studioFocusEpoch++;
  setSettingsOpen(false);
  setOtherModelsPopover(false);

  modal.removeAttribute("aria-modal");
  modal.hidden = true;
  modal.inert = true;
  studio.root.classList.remove("is-open");
  studio.root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("h3ps-modal-open");
  studio.floatingMedia?.suspend(false);
  if (studio.root.contains(document.activeElement)) document.activeElement.blur();
  if (!focusAvailableControl(studioReturnFocus)) focusAvailableControl(app.canvas?.canvas);
  studioReturnFocus = null;
}

function installLauncher() {
  if (!HOST_CAPABILITIES.windowed) return;
  const existingLauncher = document.querySelector("[data-h3ps-launcher]");
  if (existingLauncher?.dataset.h3psLauncherVersion === LAUNCHER_SCHEMA_VERSION) return;
  existingLauncher?.remove();
  document.querySelector("[data-h3ps-launcher-group]")?.remove();
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "h3ps-floating-launcher";
  launcher.dataset.h3psLauncher = "true";
  launcher.dataset.h3psLauncherVersion = LAUNCHER_SCHEMA_VERSION;
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
  const openComposer = studio.root.querySelector(".h3ps-composer.is-open");
  const openEditor = studio.root.querySelector(".h3ps-media-editor.is-open");
  if (event.key === "Tab") {
    const openPopover = studio.root.querySelector("[data-other-models-popover]:not([hidden])");
    const focusScope = openEditor?.querySelector(".h3ps-ed-dialog") || openComposer?.querySelector(".h3ps-cmp-dialog") || openPopover || studio.root.querySelector(".h3ps-modal");
    const focusable = Array.from(focusScope.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.getClientRects().length && !element.closest("[hidden]"));
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  if (openComposer || openEditor) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (!studio.root.querySelector("[data-clear-menu]").hidden) {
      setClearMenuOpen(false);
      return;
    }
    const guideMenu = studio.root.querySelector("[data-guide-menu]");
    const interfaceSizeMenu = studio.root.querySelector("[data-interface-size-menu]");
    const choiceMenu = Array.from(studio.root.querySelectorAll("[data-choice-menu]")).find((menu) => !menu.hidden);
    const runtimeMenu = Array.from(studio.root.querySelectorAll("[data-runtime-menu]")).find((menu) => !menu.hidden);
    if (!interfaceSizeMenu.hidden) {
      setInterfaceSizeMenuOpen(false, true);
    } else if (!guideMenu.hidden) {
      guideMenu.hidden = true;
      const toggle = studio.root.querySelector("[data-guide-toggle]");
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    } else if (choiceMenu) {
      choiceMenu.hidden = true;
      const toggle = studio.root.querySelector(`[data-choice-toggle="${choiceMenu.dataset.choiceMenu}"]`);
      toggle?.setAttribute("aria-expanded", "false");
      toggle?.focus();
    } else if (runtimeMenu) setRuntimeMenuOpen(runtimeMenu.dataset.runtimeMenu, false, true);
    else if (!studio.root.querySelector("[data-other-models-popover]").hidden) setOtherModelsPopover(false);
    else if (studio.fullscreen) setFullscreen(false);
    else closeStudio();
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (event.target.closest("[data-lyrics-refine-panel]")) submitLyricsRefinement();
    else if (event.target.closest("[data-refine-panel]")) submitRefinement();
    else startGenerationPreview();
  }
});

app.registerExtension({
  name: EXTENSION_NAME,
  beforeConfigureGraph() { workflowRevision++; },
  commands: [{ id: "h3-prompt-studio.open", label: "Open H3 Prompt Writer", function: openStudio },
    { id: "h3-prompt-studio.media", label: "Prompt Writer media over workflow", function: openFloatingMedia }],
  menuCommands: [{ path: ["Extensions", "H3 Prompt Writer"], commands: ["h3-prompt-studio.open", "h3-prompt-studio.media"] }],
  async setup() {
    injectStyles();
    installVramHandoff(app, {
      isEnabled: vramHandoffIsEnabled,
      onQueueRequested: () => vramHandoffCoordinator.invalidateWriterAttempts(),
      beforeQueue: unloadWriterModelsBeforeQueue,
      onError: showVramHandoffQueueError,
      onQueueHandoffEnd: () => vramHandoffCoordinator.finishQueueHandoff(),
    });
    installLauncher();
  },
});
