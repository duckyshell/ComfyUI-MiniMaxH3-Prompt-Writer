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
  configureI18n,
  getLanguagePreference,
  getLocale,
  hasTranslation,
  messageText,
  msg,
  normalizeLanguagePreference,
  onLocaleChange,
  setLanguagePreference,
  t,
  translateDom,
  localizedError,
} from "./i18n.js";
import { writeToastContent } from "./toast.js";
import { writeStatusContent } from "./status.js";
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
  T2VA: { titleKey: "mode.T2VA.title", hintKey: "mode.T2VA.hint", assets: [] },
  I2VA: { titleKey: "mode.I2VA.title", hintKey: "mode.I2VA.hint", assets: [], limit: 1 },
  FL2VA: { titleKey: "mode.FL2VA.title", hintKey: "mode.FL2VA.hint", assets: [], limit: 2 },
  L2VA: { titleKey: "mode.L2VA.title", hintKey: "mode.L2VA.hint", assets: [], limit: 1 },
  Reference: { titleKey: "mode.Reference.title", tabTitle: "", hintKey: "mode.Reference.hint", assets: [] },
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
  return t("meta.prompt_length", {
    characters: value.length.toLocaleString(),
    words: countWords(value).toLocaleString(),
  });
}

function formatGenerationMeta(result) {
  const peakVram = result.peak_vram_mb
    ? ` · ${t("meta.peak_vram", { gb: (result.peak_vram_mb / 1024).toFixed(1) })}`
    : "";
  const load = Number(result.model_load_seconds || 0).toFixed(1);
  const media = Number(result.media_processing_seconds || 0).toFixed(1);
  const llm = Number(result.generation_seconds || 0).toFixed(1);
  const fallback = result.thinking_fallback ? ` · ${t("meta.thinking_fallback")}` : "";
  const memory = result.context_tokens
    ? ` · ${Math.round(result.context_tokens / 1024)}K/${String(result.kv_cache).toUpperCase()}`
    : "";
  const total = result.total_seconds.toFixed(1);
  const timing = result.api_provider
    ? t("meta.timing.api", { total, media, llm })
    : result.external_server
    ? t("meta.timing.server", { total, media, llm })
    : t("meta.timing.local", { total, load, media, llm });
  const speed = Number.isFinite(result.tokens_per_second)
    ? ` · ${t("meta.tokens_per_second", { value: result.tokens_per_second.toFixed(1) })}`
    : "";
  const requests = result.provider_request_count || 1;
  const apiRequests = result.api_provider
    ? ` · ${t(requests === 1 ? "meta.api_request.one" : "meta.api_request.other", { count: requests })}`
    : "";
  const cost = Number.isFinite(result.provider_cost_usd)
    ? ` · ${t("meta.cost", { value: result.provider_cost_usd.toFixed(4) })}`
    : "";
  const usage = result.api_provider && result.usage_source
    ? ` · ${t("meta.usage", { source: result.usage_source })}`
    : "";
  return `${promptLengthMeta(result.prompt)} · ${timing}${speed}${apiRequests}${cost}${usage}${peakVram}${memory}${fallback}`;
}

function syncOutputLengthMeta() {
  if (!studio) return;
  const output = studio.root.querySelector("[data-output]");
  const meta = studio.root.querySelector(".h3ps-editor-meta span:last-child");
  const suffix = meta.textContent.split(" · ").slice(2).join(" · ");
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
    ? t("settings.custom")
    : t("system_prompt.status");
}

function setSystemPromptStatus(element, custom) {
  if (!element) return;
  const key = custom ? "settings.custom" : "system_prompt.status";
  element.dataset.i18n = key;
  element.textContent = t(key);
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
  if (!studio.systemPromptDefaults[profile]) {
    if (studio.localeRefreshing) return;
    textarea.disabled = true;
    try {
      const result = await getSystemPrompt(requestMode);
      studio.systemPromptDefaults[result.profile] = result.system_prompt;
    } catch (error) {
      textarea.value = "";
      if (status) status.textContent = t("system_prompt.unavailable");
      if (summaryStatus) summaryStatus.textContent = t("system_prompt.unavailable");
      showErrorToast("toast.system_prompt.failed.title", error);
      return;
    }
  }
  const custom = Object.hasOwn(studio.customSystemPrompts, profile);
  if (!studio.localeRefreshing) {
    textarea.value = custom ? studio.customSystemPrompts[profile] : studio.systemPromptDefaults[profile];
    textarea.disabled = false;
    resizeSystemPromptEditor(textarea);
  }
  setSystemPromptStatus(status, custom);
  setSystemPromptStatus(summaryStatus, custom);
  reset.hidden = !custom;
  const text = custom ? studio.customSystemPrompts[profile] : studio.systemPromptDefaults[profile] || "";
  count.textContent = `${text.length.toLocaleString()} / 8,000`;
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
    chat: '<path d="M20 12a8 8 0 0 1-8 8H4l2-3.2A8 8 0 1 1 20 12Z"/><path d="M8 11h8m-8 3h5"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="--h3ps-icon-size:${size}px" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}

function renderAsset(asset, index) {
  const destructiveDisabled = studio.requestBusy ? "disabled" : "";
  const tagDisabled = studio.requestBusy ? "disabled" : "";
  const draggable = studio.requestBusy ? "false" : "true";
  const assetName = escapeHtml(asset.reference || asset.filename);
  const visual = asset.type === "audio"
    ? `<div class="h3ps-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>`
    : asset.preview_url
      ? `<span class="h3ps-thumb-backdrop" style="background-image:url('${asset.preview_url}')"></span><img class="h3ps-real-thumb" src="${asset.preview_url}" alt="">`
      : `<div class="h3ps-thumb-art h3ps-tone-${asset.tone || "blue"}"><span></span></div>`;
  const overlay = asset.type === "video" ? `<span class="h3ps-play">${icon("play", 18)}</span>` : "";
  const duration = formatDuration(asset.duration);
  return `
    <div class="h3ps-asset" tabindex="0" role="group" aria-label="${t("media.inspector")}" draggable="${draggable}" data-asset-index="${index}" data-asset-id="${asset.id}" data-replace-label="${t("media.replace", { name: assetName })}">
      <span class="h3ps-asset-preview h3ps-${asset.type}">${visual}${overlay}</span>
      <span class="h3ps-asset-copy">
        <strong>${asset.reference ? `<button type="button" class="h3ps-media-tag is-${asset.type}" data-media-tag="${escapeHtml(asset.reference)}" ${tagDisabled} title="${t("media.insert_reference")}" data-i18n-title="media.insert_reference">${escapeHtml(asset.reference || asset.filename)}</button>` : t("media.trim_required")}</strong>
        <small>${escapeHtml(asset.filename)}</small>
      </span>
      ${duration ? `<span class="h3ps-duration">${duration}</span>` : ""}
      <button class="h3ps-replace-asset" type="button" data-replace-asset="${asset.id}" title="${t("media.replace", { name: assetName })}" aria-label="${t("media.replace", { name: assetName })}" ${destructiveDisabled}>${icon("refresh", 12)}</button>
      <button class="h3ps-remove-asset" type="button" data-remove-asset="${asset.id}" title="${t("media.remove", { name: assetName })}" aria-label="${t("media.remove", { name: assetName })}" ${destructiveDisabled}>${icon("close", 12)}</button>
    </div>`;
}

function referenceComposerAssets() {
  return studio.assets.filter((asset) => asset.mode === "Reference" && mediaVisualDescriptor(asset));
}

function composerAddState() {
  const assets = studio.assets.filter((asset) => asset.mode === "Reference");
  const pictureCount = assets.filter((asset) => asset.type === "image").length;
  if (studio.requestBusy) return { allowed: false, message: t("composer.wait_request") };
  if (pictureCount >= 9) return { allowed: false, message: t("composer.remove_picture") };
  if (assets.length >= 12) return { allowed: false, message: t("composer.remove_reference") };
  return { allowed: true, reference: `<Picture ${pictureCount + 1}>` };
}

function syncComposerControl(mode = studio.mode) {
  const panel = studio.root.querySelector("[data-media-panel-action]");
  if (panel) {
    panel.disabled = !studio.assets.some(asset => ["image", "video", "audio"].includes(asset.type) && asset.content_url);
    panel.title = panel.disabled ? t("media.add_first") : t("media.open_panel");
  }
  const button = studio.root.querySelector("[data-open-composer]");
  if (!button) return;
  const sources = mode === "Reference" ? referenceComposerAssets() : [];
  button.disabled = studio.requestBusy || !sources.length;
  button.title = mode !== "Reference" ? t("media.switch_reference")
    : studio.requestBusy ? t("media.wait_request")
    : sources.length ? t(sources.length === 1 ? "media.compose_sources.one" : "media.compose_sources.other", { count: sources.length })
    : t("media.add_picture_or_video");
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
    msg("toast.media.composed.title", { reference: added.reference }),
    msg(sources.length === 1 ? "toast.media.composed.one" : "toast.media.composed.other", {
      count: sources.length,
      width,
      height,
    }),
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
  if(pending.length)messages.push(t("toast.media.trim_hint"));
  if(total>15)messages.push(t("toast.media.total_hint"));
  if(messages.length)showToast(msg("toast.media.compatibility.title"),messages.join(" "),null,null,{dismissOnWorkspaceClick:true});
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
  studio.root.querySelector("[data-h3ps-mode-title]").textContent = t(data.titleKey);
  studio.root.querySelector("[data-h3ps-mode-hint]").textContent = t(data.hintKey);
  studio.root.querySelectorAll("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });

  if (mode === "T2VA") {
    media.innerHTML = `
      <div class="h3ps-empty-drop is-static">
        <span class="h3ps-empty-icon">${icon("spark", 20)}</span>
        <strong data-i18n="media.empty_t2va_title">${t("media.empty_t2va_title")}</strong>
        <small data-i18n="media.empty_t2va_hint">${t("media.empty_t2va_hint")}</small>
      </div>`;
  } else {
    const isReference = mode === "Reference";
    const filter = isReference ? studio.mediaFilter : "all";
    const visibleAssets = filter === "all" ? assets : assets.filter((asset) => asset.type === filter);
    const counts = assets.reduce((result, asset) => ({ ...result, [asset.type]: (result[asset.type] || 0) + 1 }), {});
    const filters = isReference ? `
      <div class="h3ps-media-filters" aria-label="${t("media.reference_type")}" data-i18n-aria-label="media.reference_type">
        <button type="button" data-media-filter="all" class="${filter === "all" ? "is-active" : ""}"><span data-i18n="media.filter_all">${t("media.filter_all")}</span> <b>${assets.length}/12</b></button>
        <button type="button" data-media-filter="image" class="${filter === "image" ? "is-active" : ""}">${icon("image", 13)} <span data-i18n="media.filter_images">${t("media.filter_images")}</span> <b>${counts.image || 0}/9</b></button>
        <button type="button" data-media-filter="video" class="${filter === "video" ? "is-active" : ""}">${icon("video", 13)} <span data-i18n="media.filter_video">${t("media.filter_video")}</span> <b>${counts.video || 0}/3</b></button>
        <button type="button" data-media-filter="audio" class="${filter === "audio" ? "is-active" : ""}">${icon("audio", 13)} <span data-i18n="media.filter_audio">${t("media.filter_audio")}</span> <b>${counts.audio || 0}/3</b></button>
      </div>` : "";
    const addLabelKey = !isReference || filter === "image"
      ? "media.add_image"
      : filter === "video" ? "media.add_video" : filter === "audio" ? "media.add_audio" : "media.add_media";
    const canAdd = isReference || assets.length < data.limit;
    media.innerHTML = `
      ${filters}
      <div class="h3ps-assets ${isReference ? "is-reference" : ""}">${visibleAssets.map((asset) => renderAsset(asset, assets.indexOf(asset))).join("")}
        ${canAdd ? `<button class="${assets.length ? "h3ps-add-asset" : "h3ps-empty-drop"}" type="button" data-add-media ${studio.requestBusy ? "disabled" : ""}>${icon("plus", 18)}<span data-i18n="${addLabelKey}">${t(addLabelKey)}</span><small data-i18n="media.drop_files">${t("media.drop_files")}</small></button>` : ""}
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
  if (missing) showToast(msg("toast.media.reference_removed.title"), msg("toast.media.reference_removed.message"));
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
        showErrorToast("toast.media.remove_failed.title", error);
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
        showErrorToast("toast.media.reorder_failed.title", error);
      }
      return;
    }
    const files = [...event.dataTransfer.files];
    uploadFiles(mode, files, replacementTargetForFileDrop(targetId, files.length));
  });
}

function previewAsset(asset) {
  if (!asset) return;
  showToast(asset.reference, msg("toast.media.audio_loaded", { duration: formatDuration(asset.duration) }));
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
    showToast(msg("toast.media.slot_full.title"), msg("toast.media.slot_full.message"));
    return;
  }
  showToast(msg("toast.media.processing.title"), msg("toast.media.processing.message"));
  const previousAssets = [...studio.assets];
  try {
    const result = await uploadMedia(studio.sessionId, mode, files, replaceAssetId);
    studio.sessionId = result.session_id;
    hideToast();
    if (replaceAssetId) acceptMediaAssets(result.assets);
    else studio.assets = [...studio.assets, ...result.assets];
    if (audioWasAdded(previousAssets, studio.assets)) {
      showToast(
        msg("toast.media.audio_added.title"),
        msg("toast.media.audio_added.message"),
        null,
        null,
        { durationMs: 6000 },
      );
    }
    renderMedia(studio.mode);
  } catch (error) {
    renderMedia(studio.mode);
    showErrorToast("toast.media.upload_failed.title", error);
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
  studio.toastSnapshot = { title, message, details, action };
  writeToastContent(toast, studio.toastSnapshot);
  const technical = toast.querySelector("[data-toast-details]");
  technical.open = false;
  toast.classList.toggle("has-details", details != null);
  const actionButton = toast.querySelector("[data-toast-action]");
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

function showErrorToast(titleKey, error, options = {}) {
  console.error(`[H3 Writer] error code=${error?.code || "UNKNOWN"}`, error);
  const localized = localizedError(error, "errors.UNKNOWN");
  showToast(msg(titleKey), msg(localized.key, error?.params || {}), localized.technical, null, options);
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
    showToast(
      msg(music ? "toast.copy.caption.title" : "toast.copy.prompt.title"),
      msg(music ? "toast.copy.caption.message" : "toast.copy.prompt.message"),
    );
  } catch (error) {
    showToast(msg("toast.copy.failed.title"), msg("toast.copy.failed.message"), error.message);
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
      ? msg("toast.clear.prompts.music")
      : msg("toast.clear.prompts.video");
    showToast(msg("toast.clear.prompts.title"), detail);
  }
  return true;
}

async function clearCurrentMedia({ notify = true } = {}) {
  if (!studio || studio.requestBusy) return false;
  try {
    const result = await clearMedia(studio.sessionId, studio.sequence?.mediaMode(studio.mode) ?? studio.mode);
    studio.assets = result.assets;


    renderMedia(studio.mode);
    if (notify) showToast(msg("toast.clear.media.title"), msg("toast.clear.media.message"));
    return true;
  } catch (error) {
    showErrorToast("toast.clear.failed.title", error);
    return false;
  }
}

async function clearEverything() {
  const mode = studio.mode;
  const submittedDraft = currentDraftFields();
  if (!await clearCurrentMedia({ notify: false })) return;
  const currentDraft = currentDraftFields();
  if (studio.mode !== mode || currentDraft.brief !== submittedDraft.brief || currentDraft.prompt !== submittedDraft.prompt) {
    showToast(msg("toast.clear.media.title"), msg("toast.clear.media_workspace_changed.message"));
    return;
  }
  clearCurrentPrompts({ notify: false });
  const detail = studio.mode === "Music3"
    ? msg("toast.clear.all.music")
    : msg("toast.clear.all.video");
  showToast(msg("toast.clear.all.title"), detail);
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
  } catch(error) { showErrorToast("toast.draft.save_failed.title", error); }
}

async function loadTextDraft(value) {
  if (studio.requestBusy) return;
  const owner = studio;
  let loaded = false;
  const mode = value.kind === "sequence" ? "Reference" : value.content.mode;
  setGenerationState("busy", msg("status.loading_draft"), "");
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
    showToast(msg("toast.draft.loaded.title"), msg("toast.draft.loaded.message"), value.media.length ? {references:value.media} : null);
  } catch(error) { showErrorToast("toast.draft.load_failed.title", error); }
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
  counter.textContent = studio.mode === "Music3"
    ? t("workspace.character_count_limit", { count: brief.value.length.toLocaleString(), limit: "2,000" })
    : t("workspace.character_count", { count: brief.value.length.toLocaleString() });
  fitTextarea(brief, minimumHeight, 2);
  brief.style.overflowY = "hidden";
}

function updateMusicLyricsCount() {
  if (!studio) return;
  const lyrics = studio.root.querySelector("[data-music-lyrics]");
  lyrics.closest(".h3ps-brief").querySelector(".h3ps-char-count").textContent =
    t("workspace.character_count_limit", { count: lyrics.value.length.toLocaleString(), limit: "4,000" });
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

function syncGenerateLabel() {
  if (!studio) return;
  const label = studio.root.querySelector("[data-generate-label]");
  if (!label) return;
  // While a request runs, generationButtonMarkup + translateDom own the cancel
  // label and its data-i18n marker; rewriting them here desynchronizes the two.
  if (studio.requestBusy) return;
  delete label.dataset.i18n;
  label.textContent = studio.mode === "Music3" ? t("generation.generate_caption") : t("generation.generate_prompt");
}

function syncWorkspace() {
  if (!studio) return;
  const chat = Boolean(studio.chatOpen);
  const music = !chat && studio.mode === "Music3";
  studio.root.classList.toggle("is-chat", chat);
  studio.root.classList.toggle("is-music", music);
  studio.root.querySelectorAll("[data-workspace]").forEach((button) => {
    const selected = button.dataset.workspace === (chat ? "chat" : music ? "music" : "video");
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const chatView = studio.root.querySelector("[data-chat-view]");
  if (chatView) chatView.hidden = !chat || studio.root.classList.contains("is-settings-open");
  studio.root.querySelector("[data-video-modes]").hidden = music;
  studio.root.querySelector("[data-video-inputs]").hidden = music;
  studio.root.querySelector("[data-music-inputs]").hidden = !music;
  const outputLabel = music ? t("workspace.generated_caption") : t("workspace.generated_prompt");
  studio.root.querySelector("[data-output-label]").textContent = outputLabel;
  studio.root.querySelector("[data-output-mobile-label]").textContent = outputLabel;
  studio.root.querySelector("[data-output]").setAttribute("aria-label", outputLabel);
  studio.root.querySelector("[data-copy-label]").textContent = music ? t("workspace.copy_caption") : t("workspace.copy_prompt");
  syncGenerateLabel();
  studio.root.querySelector("[data-refine-media-note]").textContent = music ? t("workspace.lyrics_stay_separate") : t("workspace.no_media_reupload");
  studio.root.querySelector("[data-refine-title]").textContent = music ? t("workspace.refine_caption") : t("workspace.refine_prompt");
  studio.root.querySelector("[data-refine-helper]").textContent = music ? t("workspace.describe_musical_change") : t("workspace.describe_change");
  studio.root.querySelector("[data-refine-instruction]").placeholder = music
    ? t("workspace.lyrics_refine_placeholder_example")
    : t("workspace.refine_placeholder");
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
      ? t("workspace.text_only_mode_title")
      : "";
  });
  studio.root.querySelectorAll("[data-workspace]").forEach((control) => {
    const chatTab = control.dataset.workspace === "chat";
    control.disabled = !chatTab && studio.requestBusy;
    control.setAttribute("aria-disabled", String(control.disabled));
    if (!chatTab) control.title = "";
  });
}

function generationModeIsAvailable() {
  if (isGenerationModeAvailable(studio.selectedModel, studio.mode)) return true;
  showToast(msg("toast.generation.text_only.title"), msg("toast.generation.text_only.message"));
  return false;
}

function disarmDraftDefaults() {
  if (!studio) return;
  clearTimeout(studio.draftDefaultsTimer);
  studio.draftDefaultsArmed = false;
  const label = studio.root.querySelector("[data-restore-default-drafts-label]");
  if (label) {
    label.dataset.i18n = "toast.drafts.restore_label";
    label.textContent = t("toast.drafts.restore_label");
  }
}

function restoreDefaultDrafts(event) {
  event.stopPropagation();
  if (!studio.draftDefaultsArmed) {
    studio.draftDefaultsArmed = true;
    const label = studio.root.querySelector("[data-restore-default-drafts-label]");
    label.dataset.i18n = "toast.drafts.confirm_label";
    label.textContent = t("toast.drafts.confirm_label");
    clearTimeout(studio.draftDefaultsTimer);
    studio.draftDefaultsTimer = setTimeout(disarmDraftDefaults, 5000);
    return;
  }
  disarmDraftDefaults();
  studio.modeDrafts = {};
  saveModeDrafts(localStorage, studio.modeDrafts);
  restoreModeDraft(studio.mode);
  showToast(msg("toast.drafts.restored.title"), msg("toast.drafts.restored.message"));
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
  studio.toastSnapshot = null;
  toast.classList.remove("is-visible", "is-persistent", "has-action");
}

function thinkingFallbackMessage(result, output) {
  const contextBound = result.thinking_budget_reduced
    && studio.selectedModel?.family === "gguf"
    && Number(result.context_tokens || 0) < 24_576;
  return msg(`thinking.fallback.${contextBound ? "context" : "budget"}.${output}`);
}

function setGenerationState(state, label, detail) {
  const button = studio.root.querySelector("[data-generate]");
  const status = studio.root.querySelector("[data-status]");
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
    ? t("generation.free_vram_busy")
    : t("generation.free_vram_tooltip");
  button.classList.toggle("is-cancel", busy);
  if (!busy || !wasBusy) button.innerHTML = generationButtonMarkup(icon, busy, msg(studio.mode === "Music3" ? "generation.generate_caption" : "generation.generate_prompt"));
  renderMedia(studio.mode);
  syncLifecycleActions();
  status.hidden = !busy;
  status.classList.toggle("is-busy", busy);
  if (busy) {
    const generating = typeof label === "object" ? label?.key === "status.generating" : label === "Generating";
    if (generating) {
      studio.generationDotCount = ((studio.generationDotCount || 0) % 3) + 1;
    } else {
      studio.generationDotCount = 0;
    }
    studio.generationSnapshot = { state, label, detail, dots: studio.generationDotCount };
    writeStatusContent(status, studio.generationSnapshot);
  } else {
    studio.generationDotCount = 0;
    studio.generationSnapshot = null;
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
  return preferences?.vram_handoff !== false;
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
  setGenerationState("busy", msg("status.freeing_vram"), msg("status.detail.freeing_vram"));
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
      showErrorToast("toast.vram.preparing_failed.title", error);
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
  if (writerAttemptIsCurrent(token)) {
    warnUnmeasuredVram(studio.selectedModel);
    return true;
  }
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
  console.error(`[H3 Writer] error code=${error?.code || "UNKNOWN"}`, error);
  const localized = localizedError(error, "errors.UNKNOWN");
  if (studio?.root.classList.contains("is-open")) {
    showToast(msg("toast.vram.queue.title"), localized.message, localized.technical);
  } else {
    app.extensionManager?.toast?.add({severity:"warn", summary:t("toast.vram.queue.comfy_summary"), detail:localized.message, life:8000});
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
  const label = target.state === "unloading" ? msg("lifecycle.unloading")
    : target.state === "loading" ? msg("lifecycle.loading")
    : stop ? msg("lifecycle.stop_unload")
    : target.family === "external" ? msg("lifecycle.unload")
    : target.family === "ollama" ? msg("lifecycle.unload_ollama")
    : msg("lifecycle.unload_direct");
  const title = stop
    ? msg("lifecycle.stop_title")
    : msg("lifecycle.unload_title", {
        model: target.modelId || t(target.family === "ollama" ? "lifecycle.ollama_model" : "lifecycle.direct_model"),
      });
  return `<button class="h3ps-memory-action h3ps-prompt-lifecycle-action" type="button" data-lifecycle-family="${target.family}" ${disabled ? "disabled" : ""} ${target.modelId ? `data-lifecycle-model="${escapeHtml(target.modelId)}"` : ""} data-lifecycle-stop="${stop}" title="${escapeHtml(messageText(title))}"><span class="h3ps-provider-icon" data-provider-icon="${provider}" aria-hidden="true"></span>${escapeHtml(messageText(label))}</button>`;
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
    ? `<details class="h3ps-prompt-models-menu"><summary class="h3ps-memory-action">${icon("memory", 15)}${t("lifecycle.prompt_models", { count: background.length })}</summary><span>${background.map((target) => lifecycleButtonMarkup(target)).join("")}</span></details>`
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
  button.innerHTML = `<span class="h3ps-spinner"></span>${t("vram.releasing")}`;
  try {
    const before = await getStatus(studio.ollamaHost);
    const beforeFree = Number(before.gpu_memory?.free_mb);
    const requiredFree = requiredFreeMb == null ? null : Number(requiredFreeMb);
    if (typeof retry !== "function" && requiredFree == null && comfyVramIsAlreadyEmpty(before)) {
      studio.gpuMemory = before.gpu_memory || studio.gpuMemory;
      showToast(msg("toast.vram.already_free.title"), msg("toast.vram.already_free.message"));
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
        const freeGbText = (afterFree / 1024).toFixed(1);
        const requiredGbText = (requiredFree / 1024).toFixed(1);
        const message = Number.isFinite(afterFree) && Number.isFinite(requiredFree)
          ? msg("toast.vram.still_releasing.measured", { free: freeGbText, required: requiredGbText })
          : Number.isFinite(afterFree)
          ? msg("toast.vram.still_releasing.free_only", { free: freeGbText })
          : msg("toast.vram.still_releasing.unknown");
        showToast(msg("toast.vram.still_releasing.title"), message);
      }
    } else if (releasedMb >= 64) {
      showToast(msg("toast.vram.released.title"), msg("toast.vram.released.message", { gb: (releasedMb / 1024).toFixed(1) }));
    } else {
      showToast(msg("toast.vram.requested.title"), msg("toast.vram.requested.message"));
    }
  } catch (error) {
    showErrorToast("toast.vram.failed.title", error);
  } finally {
    studio.comfyVramReleaseInFlight = false;
    button.disabled = false;
    button.innerHTML = `${icon("memory", 15)}<span data-i18n="workspace.free_comfy_vram">${t("workspace.free_comfy_vram")}</span>`;
    syncLifecycleActions();
  }
  if (shouldRetry) await retry();
}

function showVramRetry(error, retry) {
  const freeGb = Number(error.details?.free_mb) / 1024;
  const requiredGb = Number(error.details?.required_free_mb) / 1024;
  const message = Number.isFinite(freeGb) && Number.isFinite(requiredGb)
    ? msg("toast.vram.retry.message", { free: freeGb.toFixed(1), required: requiredGb.toFixed(1) })
    : localizedError(error, "errors.UNKNOWN").message;
  const action = !HOST_CAPABILITIES.comfyMemory || writerAutoVramApplies()
    ? null
    : { label: msg("toast.vram.retry.action"), onClick: () => releaseComfyVram({ retry, requiredFreeMb: error.details?.required_free_mb }) };
  showToast(msg("toast.vram.retry.title"), message, null, action);
}

function warnUnmeasuredVram(model) {
  if (!model || model.family !== "gguf" || model.estimated_free_vram_mb) return;
  if (studio.vramEstimateWarnedModel === model.id) return;
  studio.vramEstimateWarnedModel = model.id;
  const freeMb = Number(studio.gpuMemory?.free_mb);
  const message = Number.isFinite(freeMb)
    ? msg("toast.vram.unmeasured.message", { free: (freeMb / 1024).toFixed(1) })
    : msg("toast.vram.unmeasured.unknown_free");
  showToast(msg("toast.vram.unmeasured.title"), message, null, null, { dismissOnWorkspaceClick: true });
}

async function runLifecycleAction(event) {
  const button = event.currentTarget;
  if (button.disabled) return;
  const family = button.dataset.lifecycleFamily;
  const modelId = button.dataset.lifecycleModel || null;
  const stop = button.dataset.lifecycleStop === "true";
  if (stop) setGenerationState("busy", msg("status.stopping_unloading"), msg("status.detail.stopping_unloading"));
  button.disabled = true;
  if (family === "external") {
    const target = studio.promptResidency.external?.find(t => t.model_id === modelId);
    if (target) target.state = "unloading";
    button.textContent = t("lifecycle.unloading");
  }
  try {
    await unloadModel({ family, model_id: modelId, ollama_host: family === "ollama" ? studio.ollamaHost : null });
    if (family === "gguf") studio.promptResidency.direct = null;
    else if(family === "external" && !stop) studio.promptResidency.external = (studio.promptResidency.external||[]).map(t=>t.model_id===modelId ? {...t,state:"unloaded",writer_owned:false} : t);
    else if(family === "ollama") studio.promptResidency.ollama = studio.promptResidency.ollama.filter((name) => name !== modelId);
    showToast(
      msg(stop ? "toast.lifecycle.stopped.title" : family === "external" ? "toast.lifecycle.external.title" : family === "ollama" ? "toast.lifecycle.ollama.title" : "toast.lifecycle.direct.title"),
      msg(stop ? "toast.lifecycle.stopped.message" : "toast.lifecycle.unloaded.message"),
    );
  } catch (error) {
    if (family === "external") {
      const target = studio.promptResidency.external?.find(t => t.model_id === modelId);
      if (target) target.state = "unknown";
    }
    showErrorToast("toast.lifecycle.failed.title", error);
  } finally {
    button.disabled = false;
    syncLifecycleActions();
  }
}

async function startGenerationPreview() {
  if (studio.vramHandoffInFlight) return;
  if (studio.requestBusy) {
    setGenerationState("busy", msg("status.cancelling"), msg("status.detail.cancel_token"));
    await cancel();
    return;
  }
  if (!studio.selectedModel) {
    showToast(msg("toast.generation.no_model.title"), msg("toast.generation.no_model.message"));
    return;
  }
  if (!studio.selectedModel.runtime_ready) {
    showToast(
      msg("toast.generation.setup_incomplete.title"),
      studio.selectedModel.setup_message
        || msg("toast.generation.setup_incomplete.message", { missing: studio.selectedModel.missing_dependencies.join(", ") }),
    );
    return;
  }
  if (!generationModeIsAvailable()) return;
  if (!await prepareWriterRequest()) return;
  const modelName = studio.selectedModel.name.split("/").pop();
  const external = studio.selectedModel.family === "external";
  const apiProvider = studio.selectedModel.family === "api";
  const remote = external || apiProvider;
  markActiveWriterRequest();
  const generationDetail = external
    ? msg("status.detail.external_idle", { model: modelName })
    : apiProvider ? msg("status.detail.api", { model: modelName, preset: studio.selectedModel.api_preset }) : modelName;
  setGenerationState("busy", remote ? msg("status.contacting_provider") : msg("status.loading_model"), generationDetail);
  let pollingActive = true;
  studio.statusTimer = setInterval(async () => {
    try {
      const status = await getStatus(studio.ollamaHost);
      if (!pollingActive) return;
      const labels = {
        loading_model: remote ? msg("status.contacting_provider") : msg("status.loading_model"),
        processing_media: msg("status.processing_references"),
        generating: msg("status.generating"),
        cancelling: msg("status.cancelling"),
      };
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
      showToast(msg("toast.generation.completed.title"), thinkingFallbackMessage(result, "final_prompt"), null, null, { dismissOnWorkspaceClick: true });
    } else if (result.format_repair_applied) {
      const repairDetail = result.format_repair_multimodal
        ? "the existing uploaded references were checked again and the prompt was corrected"
        : `${result.format_repair_method} corrected it without re-uploading media`;
      showToast(
        msg("toast.generation.prompt_generated.title"),
        msg("toast.generation.repair_applied.message"),
        `The first draft failed ${result.format_repair_reason}; ${repairDetail}.`,
        null,
        { dismissOnWorkspaceClick: true },
      );
    } else if (result.format_repair_failure) {
      showToast(
        msg("toast.generation.format_warning.title"),
        msg("toast.generation.repair_failed.message"),
        `The first draft failed ${result.format_repair_reason}; the safe repair was rejected because ${result.format_repair_failure}.`,
        null,
        { dismissOnWorkspaceClick: true },
      );
    } else {
      const metrics = msg("toast.generation.metrics", {
        total: result.total_seconds.toFixed(1),
        tps: result.tokens_per_second.toFixed(1),
      });
      const details = [
        metrics,
        result.api_provider
          ? msg("toast.generation.reasoning_managed")
          : external ? null : msg("toast.generation.thinking", {
              state: t(result.thinking ? "toast.generation.thinking_on" : "toast.generation.thinking_off"),
            }),
      ].filter(Boolean);
      showToast(
        msg(studio.mode === "Music3" ? "toast.generation.caption_generated.title" : "toast.generation.prompt_generated.title"),
        details.map((item) => messageText(item)).join(" · "),
      );
    }
    studio.desktopNotifications.notify(t("notification.generation_ready"));
    if (result.lifecycle_warning) showToast(msg("toast.generation.cleanup.title"), result.lifecycle_warning, null, null, {dismissOnWorkspaceClick:true});
  } catch (error) {
    if (error.code !== "GENERATION_CANCELLED") studio.desktopNotifications.notify(t("notification.generation_failed"));
    if (error.code === "GENERATION_CANCELLED") {
      showToast(msg("toast.generation.cancelled.title"), msg("toast.generation.cancelled.message"));
    } else if (error.code === "INSUFFICIENT_FREE_VRAM") {
      showVramRetry(error, startGenerationPreview);
    } else if (error.code === "EXTERNAL_VISION_REQUIRED") {
      showErrorToast("toast.generation.vision_required.title", error);
    } else if (error.code === "CONTEXT_BUDGET_EXCEEDED" && error.details?.suggested_context_profile && studio.selectedModel?.family === "gguf") {
      const target = error.details.suggested_context_profile;
      const targetLabel = contextLabel(target);
      showToast(
        msg("toast.generation.more_context.title"),
        msg("toast.generation.more_context.message", {
          target: targetLabel,
          current: contextLabel(studio.contextProfile),
        }),
        null,
        { label: msg("toast.generation.more_context.action", { context: targetLabel }), onClick: () => {
          studio.contextProfile = target;
          rememberRuntimePreferences();
          saveUserPreferences(localStorage, studio);
          syncRuntimeSummary();
          syncThinkingAvailability();
        } },
      );
    } else {
      showErrorToast("toast.generation.failed.title", error);
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
  if (/e4b/.test(name)) return t("models.vram", { gb: 8 });
  if (/12b/.test(name) && /q4/.test(name)) return t("models.vram", { gb: 12 });
  if (/12b/.test(name)) return t("models.vram", { gb: 16 });
  if (/26b/.test(name)) return t("models.vram", { gb: 24 });
  if (/31b/.test(name)) return t("models.vram", { gb: 32 });
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
  const fits = t("models.fits_vram_title");
  return studio.modelSetup.map((model, index) => {
    const modelSize = model.vram_gb ? t("models.vram", { gb: model.vram_gb }) : t("models.large_measure");
    const runtimeLabel = model.minimum_runtime ? ` · ${t("models.minimum_runtime", { version: model.minimum_runtime })}` : "";
    return `
    <div class="h3ps-model-setup-row ${model.vram_gb === tier ? "fits-detected-vram" : ""}" ${model.vram_gb === tier ? `title="${escapeHtml(fits)}"` : ""}>
      <span><strong>${escapeHtml(model.name)}</strong><small>${modelSize} · ${contextLabel(model.recommended_context)}${runtimeLabel}${model.vram_gb === tier ? ` · ${t("models.fits_vram")}` : ""}</small><small class="h3ps-model-source">${escapeHtml(model.source_label)}</small></span>
      <span class="h3ps-model-files"><button type="button" data-model-files-toggle="${index}">${t("models.files")}</button><span data-model-files-menu="${index}" hidden><a href="${model.model_url}" target="_blank" rel="noopener noreferrer">${t("models.model_file")}</a><a href="${model.projector_url}" target="_blank" rel="noopener noreferrer">${t("models.projector_file")}</a></span></span>
    </div>`;
  }).join("");
}

function modelDiscoveryDetails() {
  const roots = studio.modelDiscovery?.roots || [];
  if (!roots.length) return "";
  const lines = [];
  for (const root of roots) {
    lines.push(root.path);
    lines.push(`  ${t("models.scan_model_gguf", { count: root.model_files.length })}`);
    for (const path of root.model_files) lines.push(`    ${path}`);
    lines.push(`  ${t("models.scan_projector_gguf", { count: root.projector_files.length })}`);
    for (const path of root.projector_files) lines.push(`    ${path}`);
    for (const issue of root.issues) lines.push(`  ${t("models.scan_issue", { issue })}`);
  }
  return lines.join("\n");
}

function renderModelScanDetails() {
  const discovery = modelDiscoveryDetails();
  return discovery ? `<details class="h3ps-model-scan"><summary>${t("models.scan_details")}</summary><pre>${escapeHtml(discovery)}</pre></details>` : "";
}

function renderModelSetup() {
  const directory = studio.modelDirectory || "ComfyUI/models/LLM/";
  return `
    <div class="h3ps-model-setup h3ps-direct-model-empty">
      <strong>${t("models.none_title")}</strong>
      <p>${t("models.none_body")}</p>
      <button type="button" class="h3ps-model-path" data-copy-model-path><code>${escapeHtml(directory)}</code>${icon("copy", 13)}</button>
      <p>${t("models.keep_together")}</p>
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
  const title = t("models.copy_command_title", { action: t(`models.action.${action}`) });
  return `<div class="h3ps-direct-runtime-command"><code>${escapeHtml(command)}</code><button type="button" data-copy-direct-runtime-command="${escapeHtml(command)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${icon("copy", 13)}</button></div><small>${t("models.restart_before")} <code>python_embeded</code>${t("models.restart_after")}</small>`;
}

function renderDirectRuntimeStatus() {
  const diagnostics = studio.ggufRuntimeDiagnostics;
  if (!diagnostics) {
    return studio.ggufRuntimeDiagnosticsLoading
      ? `<section class="h3ps-direct-runtime-state is-checking"><header><span><small>${t("models.runtime")}</small><strong>${t("models.checking_runtime")}</strong></span></header></section>`
      : "";
  }
  const onboarding = diagnostics.onboarding || {};
  if (onboarding.state === "ready") return "";
  if (onboarding.state === "missing") {
    const command = directRuntimeActionCommand();
    return `<section class="h3ps-direct-runtime-state is-missing">
      <header><span><small>${t("models.runtime")}</small><strong>${t("models.runtime_missing_title")}</strong></span></header>
      <p>${t("models.runtime_missing_body")}</p>
      ${renderDirectRuntimeCommand(command)}
      <div class="h3ps-direct-runtime-links"><a href="${INSTALLATION_GUIDE_URL}" target="_blank" rel="noopener noreferrer">${t("models.installation_guide")}</a><a href="${TROUBLESHOOTING_GUIDE_URL}" target="_blank" rel="noopener noreferrer">${t("models.troubleshooting_guide")}</a></div>
    </section>`;
  }
  const version = diagnostics.package_version ? t("models.version_detected", { version: escapeHtml(diagnostics.package_version) }) : "";
  return `<section class="h3ps-direct-runtime-state is-broken">
    <header><span><small>${t("models.runtime")}</small><strong>${t("models.runtime_broken_title")}</strong></span></header>
    <p>${t("models.runtime_broken_body", { version })}</p>
    <a href="${TROUBLESHOOTING_GUIDE_URL}" target="_blank" rel="noopener noreferrer">${t("models.troubleshooting")}</a>
  </section>`;
}

function localRuntimeLabel() {
  const diagnostics = studio?.ggufRuntimeDiagnostics;
  if (!diagnostics) return t("settings.local_runtime");
  if (diagnostics.status !== "ok") return t("models.runtime_inspect_failed");
  const runtime = diagnostics.gpu_offload === true
    ? t("models.gpu_offload_available")
    : diagnostics.gpu_offload === false
      ? t("models.gpu_offload_unavailable")
      : t("models.runtime_detected");
  const version = diagnostics.package_version ? ` ${diagnostics.package_version}` : "";
  const base = diagnostics.gpu_offload == null
    ? t("models.runtime_version_detected", { version })
    : `${runtime}${version}`;
  return `${base}${diagnostics.backend ? ` · ${diagnostics.backend}` : ""}`;
}

function selectedModelCategoryLabel(model) {
  if (model?.family === "gguf") return t("settings.direct");
  if (model?.family === "external") return t("settings.external");
  if (model?.family === "ollama") return t("settings.ollama");
  if (model?.family === "api") return t("models.api_provider", { preset: model.api_preset });
  return t("models.no_model");
}

function syncSelectedModelSourceLabel() {
  if (!studio) return;
  const localModel = studio.selectedModel?.family === "gguf"
    ? studio.selectedModel
    : studio.models.find((model) => model.family === "gguf" && model.runtime_ready) || studio.models.find((model) => model.family === "gguf");
  studio.root.querySelector("[data-model-source-label]").textContent = localModel ? localRuntimeLabel() : t("models.no_direct_model");
  studio.root.querySelector("[data-active-model-source]").textContent = selectedModelCategoryLabel(studio.selectedModel);
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
  studio.root.querySelector("[data-active-model-name]").textContent = model ? model.name.split("/").pop() : t("models.no_prompt_model");
  studio.root.querySelector("[data-active-model-source]").textContent = selectedModelCategoryLabel(model);
  if (runtimeSummary != null) studio.root.querySelector("[data-active-runtime-summary]").textContent = runtimeSummary;
}

async function inspectDirectRuntime() {
  if (studio.selectedModel?.family !== "gguf") return true;
  if (!studio.ggufRuntimeDiagnostics) {
    try {
      await loadGGUFRuntimeDiagnostics();
    } catch (error) {
      showToast(msg("models.runtime_inspect_failed"), msg("models.preflight_unavailable"), error.details || error.message);
      return true;
    }
    syncSelectedModelSourceLabel();
  }

  const diagnostics = studio.ggufRuntimeDiagnostics;
  const blocking = diagnostics.onboarding?.state === "broken" || diagnostics.status === "crashed" || diagnostics.status === "unavailable";
  if (blocking) {
    const warning = diagnostics.warnings?.[0];
    showToast(
      msg(warning ? "models.runtime_config_issue" : "models.runtime_check_failed"),
      warning?.message || diagnostics.message,
      diagnostics,
    );
    return false;
  }
  if (diagnostics.status !== "ok" && !studio.runtimeWarningShown) {
    studio.runtimeWarningShown = true;
    showToast(msg("models.runtime_inspect_failed"), diagnostics.message, diagnostics);
  } else if (diagnostics.gpu_offload === false && !studio.runtimeWarningShown) {
    studio.runtimeWarningShown = true;
    showToast(msg("models.gpu_offload_title"), msg("models.gpu_offload_body"), diagnostics);
  }
  return true;
}

function renderOtherModelsTrigger() {
  return `
    <button class="h3ps-other-models-trigger" type="button" data-other-models-toggle aria-expanded="false">
      <span><strong>${t("models.browse_verified")}</strong><small>${t("models.browse_verified_subtitle")}</small></span>${icon("chevron", 14)}
    </button>`;
}

function renderExternalServerControl() {
  const connected = studio.externalModel;
  const config = studio.externalServerConfig || { url: "http://127.0.0.1:8080", model: "" };
  const title = connected ? connected.name.split("/").pop() : t("providers.external.title");
  const contextSuffix = connected?.context_verified !== false && Number.isFinite(connected?.server_context_tokens)
    ? ` · ${t("providers.external.context", { tokens: Math.round(connected.server_context_tokens / 1024) })}`
    : "";
  const state = connected
    ? `${connected.endpoint}${contextSuffix}`
    : studio.externalServerError
      ? t("providers.external.offline_saved")
      : t("providers.external.connect_hint");
  const statusKey = connected
    ? "providers.status.connected"
    : studio.externalServerError ? "providers.status.offline" : "providers.status.not_connected";
  return `
    <div class="h3ps-external-connection ${connected ? "is-connected" : ""}">
      <div class="h3ps-external-connection-status">
        <span class="h3ps-provider-icon" data-provider-icon="external" aria-hidden="true"></span>
        <span><strong${connected ? "" : ' data-i18n="providers.external.title"'}>${escapeHtml(title)}</strong><small data-provider-dynamic="external-state">${escapeHtml(state)}</small></span>
        <em data-external-server-status data-i18n="${statusKey}">${t(statusKey)}</em>
      </div>
      <form data-external-server-form>
        <label><span data-i18n="providers.external.url">${t("providers.external.url")}</span><input name="url" type="url" value="${escapeHtml(config.url)}" placeholder="http://127.0.0.1:8080" required></label>
        <label><span><span data-i18n="providers.external.model_id">${t("providers.external.model_id")}</span> <em data-i18n="providers.optional">${t("providers.optional")}</em></span><input name="model" type="text" value="${escapeHtml(config.model)}" placeholder="${escapeHtml(t("providers.external.model_placeholder"))}" data-i18n-placeholder="providers.external.model_placeholder"></label>
        <label><span><span data-i18n="providers.external.api_key">${t("providers.external.api_key")}</span> <em data-i18n="providers.optional">${t("providers.optional")}</em></span><input name="api_key" type="password" autocomplete="off" placeholder="${escapeHtml(t("providers.external.key_placeholder"))}" data-i18n-placeholder="providers.external.key_placeholder"></label>
        <small data-i18n="providers.external.note">${t("providers.external.note")}</small>
        <div><button type="button" data-external-server-disconnect ${connected || studio.externalServerConfig ? "" : "hidden"} data-i18n="providers.external.disconnect">${t("providers.external.disconnect")}</button><span></span><button type="submit" data-i18n="${connected ? "providers.external.reconnect" : "providers.external.connect"}">${connected ? t("providers.external.reconnect") : t("providers.external.connect")}</button></div>
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
  const summary = custom
    ? t("providers.ollama.remote_host", { host: escapeHtml(studio.ollamaHost) })
    : t("providers.ollama.use_remote");
  return `<details class="h3ps-ollama-host-settings" data-ollama-host-settings ${studio.ollamaHostSettingsOpen ? "open" : ""}>
    <summary data-provider-dynamic="ollama-host-summary">${summary}</summary>
    <form data-ollama-host-form>
      <label><span data-i18n="providers.ollama.host_url">${t("providers.ollama.host_url")}</span><input name="host" type="url" value="${escapeHtml(hostValue)}" placeholder="${DEFAULT_OLLAMA_HOST}" required></label>
      <button type="submit" data-i18n="providers.ollama.apply">${t("providers.ollama.apply")}</button>
    </form>
    <small data-i18n="providers.ollama.host_note">${t("providers.ollama.host_note")}</small>
  </details>`;
}

function ollamaJourneyMarkup(step) {
  const steps = [["service", "providers.ollama.title"], ["model", "models.prompt_model"], ["ready", "providers.ollama.step_ready"]];
  const current = steps.findIndex(([name]) => name === step);
  return `<ol class="h3ps-ollama-journey">${steps.map(([name, key], index) => `
    <li class="${index < current ? "is-complete" : index === current ? "is-current" : ""}"><span>${index + 1}</span><em data-i18n="${key}">${t(key)}</em></li>`).join("")}</ol>`;
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
      ${isDetected ? `<em data-i18n="providers.ollama.detected">${t("providers.ollama.detected")}</em>` : "<span></span>"}
      <button type="button" data-copy-ollama-command="${escapeHtml(command)}" data-provider-dynamic="ollama-copy-command" data-command="${escapeHtml(command)}" title="${escapeHtml(t("providers.ollama.copy_command_title", { command }))}" aria-label="${escapeHtml(t("providers.ollama.copy_command_title", { command }))}">${icon("copy", 13)}</button>
    </div>`;
  }).join("")}</div>`;
}

function renderOllamaProviderControl(hostValue) {
  const status = studio.ollamaStatus;
  const hostControl = ollamaHostControlMarkup(hostValue);
  const remoteHost = studio.ollamaHost !== DEFAULT_OLLAMA_HOST;
  const serviceKey = remoteHost ? "providers.ollama.remote_service" : "providers.ollama.local_service";
  const serviceLabel = t(serviceKey);
  if (!status) {
    return `<header class="h3ps-settings-section-heading"><span><small data-i18n="${serviceKey}">${serviceLabel}</small><strong data-i18n="providers.ollama.title">${t("providers.ollama.title")}</strong></span></header>
      ${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state"><span class="h3ps-spinner"></span><span class="h3ps-ollama-state-copy"><strong data-i18n="providers.ollama.checking">${t("providers.ollama.checking")}</strong><p data-i18n="${remoteHost ? "providers.ollama.looking_remote" : "providers.ollama.looking_local"}">${remoteHost ? t("providers.ollama.looking_remote") : t("providers.ollama.looking_local")}</p></span></div>${hostControl}`;
  }
  const ready = status.state === "ready";
  const refresh = ready ? `<button type="button" data-ollama-refresh>${icon("refresh", 13)} <span data-i18n="providers.ollama.refresh">${t("providers.ollama.refresh")}</span></button>` : "";
  const header = `<header class="h3ps-settings-section-heading"><span><small data-i18n="${serviceKey}">${serviceLabel}</small><strong data-i18n="providers.ollama.title">${t("providers.ollama.title")}</strong></span>${refresh}</header>`;
  if (status.state === "not_installed") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">1</span><span class="h3ps-ollama-state-copy"><strong data-i18n="providers.ollama.get_title">${t("providers.ollama.get_title")}</strong>
      <p data-i18n="providers.ollama.get_body">${t("providers.ollama.get_body")}</p></span>
      <a class="h3ps-ollama-primary" href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" data-i18n="providers.ollama.official_download">${t("providers.ollama.official_download")}</a>
    </div>${hostControl}`;
  }
  if (status.state === "not_running") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">1</span><span class="h3ps-ollama-state-copy"><strong data-i18n="providers.ollama.start_title">${t("providers.ollama.start_title")}</strong>
      <p ${remoteHost ? 'data-provider-dynamic="ollama-remote-not-responding"' : 'data-i18n="providers.ollama.not_responding"'}>${remoteHost ? t("providers.ollama.remote_not_responding", { host: escapeHtml(studio.ollamaHost) }) : t("providers.ollama.not_responding")}</p></span>
      <button class="h3ps-ollama-primary" type="button" data-ollama-refresh data-i18n="providers.ollama.check_now">${t("providers.ollama.check_now")}</button>
    </div>${hostControl}`;
  }
  if (status.state === "error") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state is-error">
      <span class="h3ps-ollama-state-icon">!</span><span class="h3ps-ollama-state-copy"><strong data-i18n="providers.ollama.inspect_failed">${t("providers.ollama.inspect_failed")}</strong>
      <p data-provider-dynamic="ollama-error-message">${escapeHtml(status.error?.message || t("providers.ollama.unexpected"))}</p></span>
      <button class="h3ps-ollama-primary" type="button" data-ollama-refresh data-i18n="providers.ollama.try_again">${t("providers.ollama.try_again")}</button>
    </div>${hostControl}`;
  }
  const models = ollamaModels();
  if (!models.length) {
    return `${header}${ollamaJourneyMarkup("model")}<div class="h3ps-ollama-state h3ps-ollama-model-state">
      <span class="h3ps-ollama-state-copy"><strong data-i18n="providers.ollama.add_title">${t("providers.ollama.add_title")}</strong>
      <p data-i18n="providers.ollama.add_body">${t("providers.ollama.add_body")}</p>
      <div class="h3ps-ollama-tier-heading" data-i18n="providers.ollama.choose_gpu">${t("providers.ollama.choose_gpu")}</div>
      ${renderOllamaModelTiers(status)}
      <small data-i18n="providers.ollama.copy_hint">${t("providers.ollama.copy_hint")}</small>
      <details class="h3ps-ollama-storage-help" data-ollama-storage-help ${studio.ollamaStorageHelpOpen ? "open" : ""}><summary data-i18n="providers.ollama.storage_title">${t("providers.ollama.storage_title")}</summary><p><span data-i18n="providers.ollama.storage_before">${t("providers.ollama.storage_before")}</span> <code>OLLAMA_MODELS</code><span data-i18n="providers.ollama.storage_after">${t("providers.ollama.storage_after")}</span> <a href="https://docs.ollama.com/windows#changing-model-location" target="_blank" rel="noopener noreferrer" data-i18n="providers.ollama.official_instructions">${t("providers.ollama.official_instructions")}</a></p></details></span>
    </div>${hostControl}`;
  }
  const selected = ollamaModelForSettings();
  const tested = selected?.tested_for_h3 === true;
  const addModelOpen = studio.ollamaAddModelOpen === true;
  return `${header}${ollamaJourneyMarkup("ready")}<div class="h3ps-ollama-ready">
    <div class="h3ps-ollama-ready-heading"><span class="h3ps-provider-icon" data-provider-icon="ollama" aria-hidden="true"></span><span><strong data-i18n="providers.ollama.ready">${t("providers.ollama.ready")}</strong><small data-provider-dynamic="ollama-version">${t("providers.ollama.version", { version: escapeHtml(status.version || t("models.unknown")), host: remoteHost ? escapeHtml(studio.ollamaHost) : t("providers.ollama.local_service_lower") })}</small></span><em data-i18n="providers.ollama.running">${t("providers.ollama.running")}</em></div>
    <div class="h3ps-ollama-model-heading"><span data-i18n="models.prompt_model">${t("models.prompt_model")}</span><button class="h3ps-ollama-add-model-toggle" type="button" data-ollama-add-model aria-expanded="${String(addModelOpen)}" data-i18n="${addModelOpen ? "providers.ollama.hide_models" : "providers.ollama.add_model"}">${addModelOpen ? t("providers.ollama.hide_models") : t("providers.ollama.add_model")}</button></div>
    <label class="h3ps-ollama-model-select"><select data-ollama-model>${models.map((model) => `<option value="${escapeHtml(model.remote_model)}" ${model.remote_model === selected?.remote_model ? "selected" : ""}>${escapeHtml(model.name)}${model.parameter_size ? ` · ${escapeHtml(model.parameter_size)}` : ""}${model.quantization_level ? ` · ${escapeHtml(model.quantization_level)}` : ""}</option>`).join("")}</select></label>
    ${addModelOpen ? `<div class="h3ps-ollama-add-model"><strong data-i18n="providers.ollama.choose_another">${t("providers.ollama.choose_another")}</strong>${renderOllamaModelTiers(status)}<small data-i18n="providers.ollama.copy_after">${t("providers.ollama.copy_after")}</small></div>` : ""}
    <div class="h3ps-ollama-badges"><span data-i18n="providers.ollama.vision">${t("providers.ollama.vision")}</span><span data-i18n="${selected?.thinking_detected ? "providers.ollama.thinking_detected" : "providers.ollama.standard"}">${selected?.thinking_detected ? t("providers.ollama.thinking_detected") : t("providers.ollama.standard")}</span><span class="${tested ? "is-tested" : ""}" data-i18n="${tested ? "providers.ollama.tested" : "providers.ollama.not_tested"}">${tested ? t("providers.ollama.tested") : t("providers.ollama.not_tested")}</span></div>
    <p data-i18n="${tested ? "providers.ollama.tested_body" : "providers.ollama.untested_body"}">${tested ? t("providers.ollama.tested_body") : t("providers.ollama.untested_body")}</p>
    <small data-i18n="providers.ollama.keep_loaded">${t("providers.ollama.keep_loaded")}</small>
  </div>${hostControl}`;
}

const API_PROVIDER_UI = {
  gemini: { name: "Gemini", icon: "api-gemini", noteKey: "providers.api.note.gemini", keyUrl: "https://aistudio.google.com/api-keys" },
  openai: { name: "OpenAI", icon: "api-openai", noteKey: "providers.api.note.openai", keyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { name: "OpenRouter", icon: "api-openrouter", noteKey: "providers.api.note.openrouter", keyUrl: "https://openrouter.ai/settings/keys" },
  custom: { nameKey: "providers.api.name.custom", icon: "api-custom", noteKey: "providers.api.note.custom", keyUrl: null },
};
function apiProviderName(provider) {
  return provider.nameKey ? t(provider.nameKey) : provider.name;
}

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

function renderApiProviderError() {
  const error = studio.apiProviderError;
  if (!error) return "";
  return `<div class="h3ps-api-error"><strong ${error.code ? "" : 'data-provider-dynamic="api-error-code"'}>${escapeHtml(error.code || t("providers.api.connection_failed"))}</strong><span>${escapeHtml(error.message)}</span></div>`;
}

function renderApiProviderControl() {
  const config = studio.apiProviderConfig;
  const selectedPreset = API_PROVIDER_UI[config.preset] || API_PROVIDER_UI.gemini;
  const providerMetadata = studio.apiProviderPresets.find((provider) => provider.id === config.preset) || {};
  const connection = studio.apiProviderConnection;
  const model = apiProviderModelForSettings();
  const providerChoices = Object.entries(API_PROVIDER_UI).map(([id, provider]) => `
    <button type="button" class="h3ps-api-preset ${id === config.preset ? "is-selected" : ""}" data-api-preset="${id}">
      <span class="h3ps-provider-icon" data-provider-icon="${provider.icon}" aria-hidden="true"></span><span><strong${provider.nameKey ? ` data-i18n="${provider.nameKey}"` : ""}>${apiProviderName(provider)}</strong><small data-i18n="${provider.noteKey}">${t(provider.noteKey)}</small></span>${icon("check", 13)}
    </button>`).join("");
  const header = `<header class="h3ps-settings-section-heading"><span><small data-i18n="providers.api.kicker">${t("providers.api.kicker")}</small><strong data-i18n="settings.api">${t("settings.api")}</strong></span></header>`;
  const disclosure = `<div class="h3ps-api-disclosure"><strong data-i18n="providers.api.disclosure_title">${t("providers.api.disclosure_title")}</strong><p data-i18n="providers.api.disclosure_body">${t("providers.api.disclosure_body")}</p>${config.preset === "openrouter" ? `<small data-i18n="providers.api.disclosure_openrouter">${t("providers.api.disclosure_openrouter")}</small>` : ""}</div>`;
  const policyLinks = [
    providerMetadata.pricing_url ? `<a href="${escapeHtml(providerMetadata.pricing_url)}" target="_blank" rel="noopener noreferrer" data-i18n="providers.api.pricing">${t("providers.api.pricing")}</a>` : "",
    providerMetadata.privacy_url ? `<a href="${escapeHtml(providerMetadata.privacy_url)}" target="_blank" rel="noopener noreferrer" data-i18n="providers.api.privacy">${t("providers.api.privacy")}</a>` : "",
  ].filter(Boolean).join("");
  if (connection) {
    const models = studio.apiProviderModels.length ? studio.apiProviderModels : model ? [model] : [];
    return `${header}<div class="h3ps-api-layout">
      <div class="h3ps-api-preset-list">${providerChoices}</div>
      <div class="h3ps-api-setup">
        <div class="h3ps-api-connected">
          <span class="h3ps-provider-icon" data-provider-icon="${selectedPreset.icon}" aria-hidden="true"></span>
          <span><strong>${escapeHtml(connection.provider_name)}</strong><small data-provider-dynamic="api-connected-meta">${escapeHtml(connection.base_url)} · ${escapeHtml(connection.key_hint || t("providers.api.no_key"))}${connection.compatibility_profile === "lm_studio" ? ` · ${t("providers.api.lm_studio")}` : ""}</small></span>
          <em data-i18n="${connection.connection_verified ? "providers.status.connected" : "providers.api.configured"}">${connection.connection_verified ? t("providers.status.connected") : t("providers.api.configured")}</em>
        </div>
        <label class="h3ps-api-model-select"><span data-i18n="settings.model">${t("settings.model")}</span><select data-api-model>${models.map((item) => `<option value="${escapeHtml(item.remote_model)}" ${item.remote_model === model?.remote_model ? "selected" : ""}>${escapeHtml(item.name)}${item.model_context_limit ? ` · ${Math.round(item.model_context_limit / 1024)}K` : ""}</option>`).join("")}</select></label>
        <div class="h3ps-api-badges"><span class="${model?.capabilities?.images ? "is-ready" : ""}" data-i18n="${model?.capabilities?.images ? "providers.ollama.vision" : "providers.api.text_unknown"}">${model?.capabilities?.images ? t("providers.ollama.vision") : t("providers.api.text_unknown")}</span><span data-provider-dynamic="api-thinking">${config.preset === "gemini" ? t("providers.api.thinking", { level: escapeHtml(connection.reasoning_effort || "minimal") }) : t("toast.generation.reasoning_managed")}</span><span data-i18n="providers.api.provider_managed">${t("providers.api.provider_managed")}</span></div>
        <div class="h3ps-api-actions"><span>${policyLinks}</span><button type="button" data-api-model-refresh>${icon("refresh", 13)} <span data-i18n="providers.api.refresh_models">${t("providers.api.refresh_models")}</span></button><button type="button" data-api-disconnect data-i18n="providers.external.disconnect">${t("providers.external.disconnect")}</button></div>
        ${disclosure}
        <p class="h3ps-api-cancel-note" data-i18n="providers.api.stop_note">${t("providers.api.stop_note")}</p>
      </div>
    </div>`;
  }
  return `${header}<div class="h3ps-api-layout">
    <div class="h3ps-api-preset-list">${providerChoices}</div>
    <form class="h3ps-api-setup" data-api-provider-form>
      <div class="h3ps-api-intro"><strong data-provider-dynamic="api-connect-title">${t("providers.api.connect_title", { provider: apiProviderName(selectedPreset) })}</strong><p data-i18n="providers.api.intro">${t("providers.api.intro")}</p></div>
      ${config.preset === "custom" ? `<label><span data-i18n="providers.api.base_url">${t("providers.api.base_url")}</span><input name="base_url" type="url" value="${escapeHtml(config.base_url)}" placeholder="${escapeHtml(t("providers.api.base_placeholder"))}" data-i18n-placeholder="providers.api.base_placeholder" required><small data-i18n="providers.api.base_hint">${t("providers.api.base_hint")}</small></label>` : ""}
      <label><span><span data-i18n="providers.api.key">${t("providers.api.key")}</span> ${config.preset === "custom" ? `<em data-i18n="providers.optional">${t("providers.optional")}</em>` : ""}</span><input name="api_key" type="password" value="" placeholder="${escapeHtml(t("providers.api.key_placeholder"))}" data-i18n-placeholder="providers.api.key_placeholder" autocomplete="off" spellcheck="false" ${config.preset === "custom" ? "" : "required"}><small data-i18n="providers.api.key_hint">${t("providers.api.key_hint")}</small></label>
      <label><span><span data-i18n="providers.api.model_id">${t("providers.api.model_id")}</span> <em data-i18n="providers.api.optional_before_connect">${t("providers.api.optional_before_connect")}</em></span><input name="model_id" type="text" value="${escapeHtml(config.model_id)}" placeholder="${escapeHtml(t("providers.api.model_placeholder"))}" data-i18n-placeholder="providers.api.model_placeholder" spellcheck="false"></label>
      ${config.preset === "gemini" ? `<label><span data-i18n="providers.api.thinking_level">${t("providers.api.thinking_level")}</span><select name="gemini_reasoning_effort"><option value="minimal" ${config.gemini_reasoning_effort === "minimal" ? "selected" : ""} data-i18n="providers.api.thinking_minimal">${t("providers.api.thinking_minimal")}</option><option value="low" ${config.gemini_reasoning_effort === "low" ? "selected" : ""} data-i18n="runtime.reasoning.low">${reasoningLabel("low")}</option><option value="medium" ${config.gemini_reasoning_effort === "medium" ? "selected" : ""} data-i18n="runtime.reasoning.medium">${reasoningLabel("medium")}</option><option value="high" ${config.gemini_reasoning_effort === "high" ? "selected" : ""} data-i18n="runtime.reasoning.high">${reasoningLabel("high")}</option></select><small data-i18n="providers.api.thinking_hint">${t("providers.api.thinking_hint")}</small></label>` : ""}
      ${config.preset === "custom" ? `<div class="h3ps-api-custom-options"><label><input name="custom_images" type="checkbox" ${config.custom_images ? "checked" : ""}><span data-i18n="providers.api.images_option">${t("providers.api.images_option")}</span></label><label><span><span data-i18n="providers.api.known_context">${t("providers.api.known_context")}</span> <em data-i18n="providers.optional">${t("providers.optional")}</em></span><input name="custom_context_tokens" type="number" min="4096" step="1024" value="${config.custom_context_tokens || ""}" placeholder="32768"></label></div>` : ""}
      <div data-api-provider-error>${renderApiProviderError()}</div>
      ${disclosure}
      <div class="h3ps-api-actions"><span>${selectedPreset.keyUrl ? `<a href="${selectedPreset.keyUrl}" target="_blank" rel="noopener noreferrer" data-i18n="providers.api.manage_key">${t("providers.api.manage_key")}</a>` : ""}${policyLinks}</span><button class="h3ps-api-primary" type="submit" data-i18n="providers.api.connect_test">${t("providers.api.connect_test")}</button></div>
    </form>
  </div>`;
}

function syncProviderPanelCopy(root = studio.root) {
  if (!root) return;
  root.querySelectorAll("[data-provider-dynamic]").forEach((element) => {
    const kind = element.dataset.providerDynamic;
    if (kind === "external-state") {
      const connected = studio.externalModel;
      const contextSuffix = connected?.context_verified !== false && Number.isFinite(connected?.server_context_tokens)
        ? ` · ${t("providers.external.context", { tokens: Math.round(connected.server_context_tokens / 1024) })}`
        : "";
      element.textContent = connected
        ? `${connected.endpoint}${contextSuffix}`
        : studio.externalServerError
          ? t("providers.external.offline_saved")
          : t("providers.external.connect_hint");
    } else if (kind === "ollama-host-summary") {
      element.textContent = studio.ollamaHost !== DEFAULT_OLLAMA_HOST
        ? t("providers.ollama.remote_host", { host: studio.ollamaHost })
        : t("providers.ollama.use_remote");
    } else if (kind === "ollama-copy-command") {
      const command = element.dataset.command || "";
      const label = t("providers.ollama.copy_command_title", { command });
      element.title = label;
      element.setAttribute("aria-label", label);
    } else if (kind === "ollama-version") {
      if (!studio.ollamaStatus) return;
      element.textContent = t("providers.ollama.version", {
        version: studio.ollamaStatus.version || t("models.unknown"),
        host: studio.ollamaHost !== DEFAULT_OLLAMA_HOST ? studio.ollamaHost : t("providers.ollama.local_service_lower"),
      });
    } else if (kind === "ollama-remote-not-responding") {
      element.textContent = t("providers.ollama.remote_not_responding", { host: studio.ollamaHost });
    } else if (kind === "ollama-error-message") {
      if (!studio.ollamaStatus?.error?.message) element.textContent = t("providers.ollama.unexpected");
    } else if (kind === "api-connect-title") {
      const preset = API_PROVIDER_UI[studio.apiProviderConfig?.preset] || API_PROVIDER_UI.gemini;
      element.textContent = t("providers.api.connect_title", { provider: apiProviderName(preset) });
    } else if (kind === "api-connected-meta") {
      const connection = studio.apiProviderConnection;
      if (!connection) return;
      element.textContent = `${connection.base_url} · ${connection.key_hint || t("providers.api.no_key")}${connection.compatibility_profile === "lm_studio" ? ` · ${t("providers.api.lm_studio")}` : ""}`;
    } else if (kind === "api-thinking") {
      if (!studio.apiProviderConnection) return;
      element.textContent = studio.apiProviderConfig?.preset === "gemini"
        ? t("providers.api.thinking", { level: studio.apiProviderConnection.reasoning_effort || "minimal" })
        : t("toast.generation.reasoning_managed");
    } else if (kind === "api-error-code") {
      if (!studio.apiProviderError?.code) element.textContent = t("providers.api.connection_failed");
    }
  });
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
    ? t("models.ollama_context_note")
    : t("settings.runtime_note");
}

function directModelRuntimeSuffix(model) {
  const requirement = model.runtime_requirement || {};
  if (requirement.state === "update_required") {
    return t("models.update_suffix", { version: requirement.minimum_version });
  }
  if (requirement.state === "missing") return t("models.runtime_required");
  if (requirement.state === "incompatible") return t("models.runtime_incompatible");
  return "";
}

function renderDirectModelRuntimeUpdate(model) {
  const requirement = model.runtime_requirement || {};
  const installed = requirement.installed_version || studio.ggufRuntimeDiagnostics?.package_version || t("models.unknown");
  const minimum = requirement.minimum_version || t("models.newer");
  const command = directRuntimeActionCommand();
  return `<section class="h3ps-direct-runtime-state is-missing">
    <header><span><small>${t("models.runtime")}</small><strong>${t("models.runtime_update_required")}</strong></span></header>
    <p>${t("models.installed_requires", { installed: escapeHtml(installed), model: escapeHtml(model.name), minimum: escapeHtml(minimum) })}</p>
    ${renderDirectRuntimeCommand(command, "update")}
    ${command ? "" : `<div class="h3ps-direct-runtime-links"><a href="${INSTALLATION_GUIDE_URL}" target="_blank" rel="noopener noreferrer">${t("models.installation_guide")}</a><a href="${TROUBLESHOOTING_GUIDE_URL}" target="_blank" rel="noopener noreferrer">${t("models.troubleshooting_guide")}</a></div>`}
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
  slot.innerHTML = `<label class="h3ps-field"><span>${t("models.vision_projector")}</span><select aria-label="${t("models.vision_projector")}"><option value="">${t("models.choose_projector")}</option>${choices.map(path => `<option value="${escapeHtml(path)}" ${path === model.selected_projector ? "selected" : ""}>${escapeHtml(path.split(/[\\/]/).pop())}</option>`).join("")}</select></label><p class="h3ps-direct-model-note">${t("models.multiple_projectors")}</p>`;
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
    } catch (error) { showErrorToast("models.projector_selection", error); }
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
        modelFileNeedsSetup ? t("models.needs_setup") : "",
        directModelRuntimeSuffix(model),
        isTextOnlyDirectModel(model) ? t("models.text_only") : "",
      ].filter(Boolean).join(" · ");
      return `<option value="${escapeHtml(model.id)}" ${model.id === directModel?.id ? "selected" : ""}>${escapeHtml(model.name.split("/").pop())}${suffix ? ` — ${escapeHtml(suffix)}` : ""}</option>`;
    }).join("")
    : `<option>${t("models.none_found")}</option>`;
  studio.root.querySelector("[data-direct-runtime-status]").innerHTML = renderDirectRuntimeStatus();
  const directStatus = studio.root.querySelector("[data-direct-model-status]");
  if (!models.length) {
    directStatus.innerHTML = renderModelSetup();
  } else if (directModel) {
    const runtimeRequirement = directModel.runtime_requirement || {};
    directStatus.innerHTML = directModel.model_ready === false
      ? `<div class="h3ps-direct-model-warning"><strong>${t("models.needs_attention")}</strong><span>${escapeHtml(directModel.setup_message || t("models.unsupported"))}</span></div>`
      : runtimeRequirement.state === "update_required"
        ? renderDirectModelRuntimeUpdate(directModel)
        : isTextOnlyDirectModel(directModel)
          ? `<div class="h3ps-direct-model-note"><strong>${t("models.text_only_note")}</strong><span>${escapeHtml(directModel.capability_message || t("models.no_projector"))}</span></div>`
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
  keepLoadedControl.hidden = model?.family !== "gguf";
  keepLoaded.checked = model?.family === "gguf" && studio.keepModelLoaded;
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
      msg("toast.mode.switched_t2va.title"),
      model?.capability_message || msg("toast.mode.switched_t2va.message"),
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

const CONTEXT_LABELS = { auto: "settings.auto", low: "8K", standard: "16K", extended: "24K", large: "32K", maximum: "48K", custom: "settings.custom" };
const KV_LABELS = { auto: "settings.auto", q8: "Q8", f16: "F16" };
const BUDGET_LABELS = { auto: "settings.auto", 2048: "2K", 4096: "4K", 8192: "8K", custom: "settings.custom" };
const labelText = (value) => String(value).startsWith("settings.") ? t(value) : String(value);
function contextLabel(value) {
  return labelText(CONTEXT_LABELS[value] ?? (value || "settings.auto"));
}
const kvLabel = (value) => labelText(KV_LABELS[value] ?? value);
const budgetLabel = (value) => labelText(BUDGET_LABELS[value] ?? value);
function reasoningLabel(value) {
  if (value === "auto") return t("settings.auto");
  return hasTranslation(`runtime.reasoning.${value}`)
    ? t(`runtime.reasoning.${value}`)
    : value[0].toUpperCase() + value.slice(1);
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
    ? t("runtime.thinking_external")
    : unsupported
    ? t("runtime.thinking_unsupported")
    : disabled ? t("runtime.thinking_needs_context") : "";
}

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
    button.title = unavailable ? t("runtime.context_unavailable") : "";
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
  if (!studio.localeRefreshing) {
    contextInput.value = studio.contextTokens || "";
  }
  const nativeContext = studio.selectedModel?.native_context_tokens;
  if (Number.isInteger(nativeContext) && nativeContext > 0) contextInput.max = String(nativeContext);
  else contextInput.removeAttribute("max");

  const customBudget = studio.root.querySelector("[data-custom-generation-budget]");
  customBudget.hidden = (!direct && !ollama) || studio.generationBudget !== "custom";
  if (!studio.localeRefreshing) {
    studio.root.querySelector("[data-custom-generation-budget-input]").value = studio.generationBudgetTokens || "";
  }

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
    ? t(overrideCount === 1 ? "runtime.overrides.one" : "runtime.overrides.other", { count: overrideCount })
    : t("settings.auto");
  const menu = studio.root.querySelector('[data-runtime-menu="reasoning"]');
  menu.innerHTML = ["auto", ...values].map((value) => `<button type="button" data-runtime-option="reasoning" data-value="${escapeHtml(value)}">${reasoningLabel(value)}</button>`).join("");
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

function syncChatLauncher() {
  if (!studio) return;
  const tab = studio.root.querySelector('[data-workspace="chat"]');
  if (!tab) return;
  const configured = Boolean(studio.externalServerConfig?.url);
  const activated = Boolean(studio.externalModel);
  const available = configured && activated;
  if (tab.hidden === available) {
    console.log(
      `[H3 Writer chat] chat tab ${available ? "shown" : "hidden"} ` +
      `configured=${configured} activated=${activated} ` +
      `error=${studio.externalServerError?.code || "none"}`,
    );
  }
  tab.hidden = !available;
  if (!available && studio.chatOpen) {
    console.log(
      `[H3 Writer chat] leaving the chat tab because llama.cpp is not active ` +
      `configured=${configured} activated=${activated}`,
    );
    studio.chatOpen = false;
    syncWorkspace();
  }
}

function releaseComfyResources(reason) {
  console.log(`[H3 Writer] releasing ComfyUI models and memory reason=${reason}`);
  freeComfyVram({ freeMemory: true })
    .then(() => {
      console.log(`[H3 Writer] ComfyUI models and memory released reason=${reason}`);
    })
    .catch((error) => {
      console.warn(
        `[H3 Writer] ComfyUI models and memory release failed reason=${reason} ` +
        `code=${error?.code || ""} message=${error?.message || error}`,
      );
    });
}

let llamaReleaseInFlight = false;

async function releaseLlamaResources(reason) {
  const config = studio?.externalServerConfig;
  if (!config?.url) {
    console.log(`[H3 Writer] llama cleanup skipped reason=${reason} configured=false`);
    return;
  }
  if (llamaReleaseInFlight) {
    console.log(`[H3 Writer] llama cleanup skipped reason=${reason} already_running=true`);
    return;
  }
  llamaReleaseInFlight = true;
  const endpoint = config.url;
  const requestedModel = config.model || "";
  console.log(
    `[H3 Writer] checking llama server for cleanup reason=${reason} ` +
    `endpoint=${endpoint} model=${requestedModel || "(any)"}`,
  );
  try {
    let model = null;
    try {
      const result = await probeExternalServer(config);
      model = result?.model || null;
    } catch (error) {
      const offline = error?.code === "EXTERNAL_SERVER_UNAVAILABLE";
      console.warn(
        `[H3 Writer] llama cleanup skipped reason=${reason} ` +
        `${offline ? "online=false" : "probe_failed=true"} ` +
        `endpoint=${endpoint} code=${error?.code || ""} message=${error?.message || error}`,
      );
      return;
    }
    console.log(
      `[H3 Writer] llama server online reason=${reason} endpoint=${endpoint} ` +
      `model=${model?.remote_model || ""} lifecycle_supported=${Boolean(model?.lifecycle_supported)}`,
    );
    if (!model?.lifecycle_supported || !model?.id) {
      console.warn(
        `[H3 Writer] llama cleanup skipped reason=${reason} lifecycle_supported=false ` +
        `endpoint=${endpoint}; this llama.cpp server manages its own model lifecycle`,
      );
      return;
    }
    try {
      const result = await unloadModel({ family: "external", model_id: model.id });
      console.log(
        `[H3 Writer] llama model unload requested reason=${reason} model=${model.id} ` +
        `deferred=${result?.deferred === true}`,
      );
    } catch (error) {
      console.warn(
        `[H3 Writer] llama model unload failed reason=${reason} model=${model.id} ` +
        `code=${error?.code || ""} message=${error?.message || error}`,
      );
    }
  } finally {
    llamaReleaseInFlight = false;
  }
}

function releaseStudioResources(reason) {
  releaseComfyResources(reason);
  releaseLlamaResources(reason).catch((error) => {
    console.warn(
      `[H3 Writer] llama cleanup failed unexpectedly reason=${reason} ` +
      `message=${error?.message || error}`,
    );
  });
}

function activateLlamaChatTab() {
  if (!studio?.externalServerConfig?.url) return;
  const frame = studio.root.querySelector("[data-chat-frame]");
  if (frame && !frame.getAttribute("src")) {
    frame.src = new URL("./llama_chat.html", import.meta.url).href;
    console.log(`[H3 Writer chat] mounted ${frame.src}`);
  }
  if (studio.chatOpen) return;
  studio.chatOpen = true;
  syncWorkspace();
  console.log("[H3 Writer chat] chat tab activated");
}

function postLocaleToChat() {
  const frame = studio?.root?.querySelector("[data-chat-frame]");
  if (!frame?.contentWindow) return;
  const locale = getLocale();
  try {
    frame.contentWindow.postMessage({ type: "h3ps-locale", locale }, window.location.origin);
    console.log(`[H3 Writer chat] sent locale=${locale} to the chat tab`);
  } catch (error) {
    console.warn(`[H3 Writer chat] could not send the locale to the chat tab: ${error?.message || error}`);
  }
}

function postThemeToChat() {
  const frame = studio?.root?.querySelector("[data-chat-frame]");
  if (!frame?.contentWindow) return;
  const theme = studio.theme === "light" ? "light" : "dark";
  try {
    frame.contentWindow.postMessage({ type: "h3ps-theme", theme }, window.location.origin);
    console.log(`[H3 Writer chat] sent theme=${theme} to the chat tab`);
  } catch (error) {
    console.warn(`[H3 Writer chat] could not send the theme to the chat tab: ${error?.message || error}`);
  }
}

function syncChatFramePreferences() {
  postLocaleToChat();
  postThemeToChat();
}

function syncRuntimeSummary(result = null) {
  if (!studio) return;
  syncContextAvailability();
  syncAdvancedRuntimeControls();
  const customContextLabel = studio.contextTokens ? `${Number(studio.contextTokens).toLocaleString()}` : t("settings.custom");
  studio.root.querySelector('[data-runtime-label="context"]').textContent = contextLabel(studio.contextProfile);
  studio.root.querySelector('[data-runtime-label="kv"]').textContent = kvLabel(studio.kvCache);
  studio.root.querySelector('[data-runtime-label="budget"]').textContent = budgetLabel(studio.generationBudget);
  studio.root.querySelector('[data-runtime-label="reasoning"]').textContent = reasoningLabel(studio.reasoningEffort);
  let activeSummary;
  if (studio.selectedModel?.family === "external") {
    const tokens = result?.context_tokens || studio.selectedModel.server_context_tokens;
    activeSummary = tokens ? t("runtime.server_context", { tokens: Math.round(tokens / 1024) }) : t("runtime.server_managed");
  } else if (studio.selectedModel?.family === "ollama") {
    const tokens = result?.context_tokens || (studio.contextProfile === "auto" ? null : ({ low: 8192, standard: 16384, extended: 24576, large: 32768, maximum: 49152 }[studio.contextProfile]));
    activeSummary = tokens ? t("runtime.ollama_context", { tokens: Math.round(tokens / 1024) }) : t("runtime.ollama_auto");
  } else if (studio.selectedModel?.family === "api") {
    const tokens = result?.context_limit_known ? result.context_tokens : studio.selectedModel.model_context_limit;
    activeSummary = tokens ? t("runtime.api_context", { tokens: Math.round(tokens / 1024) }) : t("runtime.api_managed");
  } else if (result && studio.contextProfile === "auto") {
    activeSummary = t("runtime.auto_result", { tokens: Math.round(result.context_tokens / 1024), kv: String(result.kv_cache).toUpperCase() });
  } else {
    activeSummary = studio.contextProfile === "auto" ? t("models.runtime_summary") : `${studio.contextProfile === "custom" ? customContextLabel : contextLabel(studio.contextProfile)} · ${kvLabel(studio.kvCache)}`;
  }
  syncActiveModelSummary(activeSummary);
  syncChatLauncher();
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
  const chatView = studio.root.querySelector("[data-chat-view]");
  if (chatView) chatView.hidden = open || !studio.chatOpen;
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

function externalConnectedContextTokens(model) {
  return model?.context_verified !== false && Number.isFinite(model?.server_context_tokens)
    ? Math.round(model.server_context_tokens / 1024)
    : null;
}

function syncExternalServerStatus() {
  const status = studio.root?.querySelector?.("[data-external-provider-control] [data-external-server-status]");
  if (status) {
    const statusKey = studio.externalModel
      ? "providers.status.connected"
      : studio.externalServerError ? "providers.status.offline" : "providers.status.not_connected";
    status.dataset.i18n = statusKey;
    status.textContent = t(statusKey);
  }
  syncProviderPanelCopy();
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
  submit.textContent = t("providers.external.connecting");
  submit.dataset.i18n = "providers.external.connecting";
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
    const connectedContextTokens = externalConnectedContextTokens(result.model);
    showToast(
      msg("toast.external.connected.title"),
      connectedContextTokens !== null
        ? msg("toast.external.connected.message_context", {
            model: result.model.name,
            tokens: connectedContextTokens,
          })
        : msg("toast.external.connected.message", { model: result.model.name }),
    );
  } catch (error) {
    if (studio.externalConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    studio.externalServerError = error;
    showErrorToast("toast.external.failed.title", error);
    syncExternalServerStatus();
  } finally {
    if (studio.externalConnectionAttempt === attempt) {
      const labelKey = studio.externalModel ? "providers.external.reconnect" : "providers.external.connect";
      submit.disabled = false;
      submit.textContent = t(labelKey);
      submit.dataset.i18n = labelKey;
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
  showToast(msg("toast.external.disconnected.title"), msg("toast.external.disconnected.message"));
}

function syncApiProviderError() {
  const slot = studio.root?.querySelector?.("[data-api-provider-control] [data-api-provider-error]");
  if (slot) slot.innerHTML = renderApiProviderError();
  syncProviderPanelCopy();
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
  submit.textContent = t("providers.external.connecting");
  submit.dataset.i18n = "providers.external.connecting";
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
    const messageKey = model
      ? `toast.api.connected.message.${model.capabilities?.images ? "vision" : "text"}_${result.connection.connection_verified ? "verified" : "unverified"}`
      : null;
    showToast(
      msg("toast.api.connected.title", { provider: result.connection.provider_name }),
      messageKey ? msg(messageKey, { model: model.name }) : msg("toast.api.connected.no_model"),
    );
  } catch (error) {
    if (studio.apiConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    studio.apiProviderError = error;
    showErrorToast("toast.api.failed.title", error);
    syncApiProviderError();
  } finally {
    if (studio.apiConnectionAttempt === attempt) {
      submit.disabled = false;
      submit.textContent = t("providers.api.connect_test");
      submit.dataset.i18n = "providers.api.connect_test";
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
  if (announce) showToast(msg("toast.api.disconnected.title"), msg("toast.api.disconnected.message"));
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
    const count = studio.apiProviderModels.length;
    showToast(
      msg("toast.api.models_refreshed.title"),
      msg(count === 1 ? "toast.api.models_refreshed.one" : "toast.api.models_refreshed.other", { count }),
    );
  } catch (error) {
    if (studio.apiConnectionAttempt !== attempt || (studio.modelSelectionRevision || 0) !== selectionRevision) return;
    studio.apiProviderError = error;
    showErrorToast("toast.api.refresh_failed.title", error);
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
    showErrorToast("toast.models.scan_failed.title", error);
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
  submit.textContent = t("providers.ollama.checking");
  submit.dataset.i18n = "providers.ollama.checking";
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
      msg(changed ? "toast.ollama.host_updated" : "toast.ollama.host_checked"),
      endpoint === DEFAULT_OLLAMA_HOST
        ? msg("toast.ollama.host_local")
        : msg("toast.ollama.host_using", { endpoint }),
    );
  } catch (error) {
    showErrorToast("toast.ollama.invalid_host", error);
    renderInferenceSettings();
  } finally {
    submit.disabled = false;
    submit.textContent = t("providers.ollama.apply");
    submit.dataset.i18n = "providers.ollama.apply";
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
    refreshButton.textContent = t("providers.ollama.checking");
    refreshButton.dataset.i18n = "providers.ollama.checking";
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
      const bodyKey = studio.ollamaHost !== DEFAULT_OLLAMA_HOST
        ? "providers.ollama.remote_not_responding"
        : status.state === "not_installed"
          ? "toast.ollama.install_hint"
          : "toast.ollama.start_hint";
      showToast(
        msg(status.state === "not_installed" ? "toast.ollama.not_installed" : "toast.ollama.not_running"),
        msg(bodyKey, { host: studio.ollamaHost }),
      );
    }
  } catch (error) {
    studio.ollamaStatus = { state: "error", running: false, compatible_models: [], error: { code: error.code, message: error.message } };
    studio.ollamaError = error;
    renderInferenceSettings();
    if (!automatic) showErrorToast("toast.ollama.failed.title", error);
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
  submit.innerHTML = `<span class="h3ps-spinner"></span>${t("toast.lyrics.cancelling")}`;
  try {
    await cancel();
  } catch (error) {
    showErrorToast("toast.lyrics.cancel_failed.title", error);
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
    showToast(msg("toast.lyrics.add_note.title"), msg("toast.lyrics.add_note.message"));
    return;
  }
  if (!currentLyrics.trim() && !instruction && (!useMusicBrief || !musicBrief)) {
    showToast(msg("toast.lyrics.describe.title"), msg("toast.lyrics.describe.message"));
    return;
  }
  if (!studio.selectedModel) {
    showToast(msg("toast.generation.no_model.title"), msg("toast.generation.no_model.message"));
    return;
  }
  if (!studio.selectedModel.runtime_ready) {
    showToast(
      msg("toast.generation.setup_incomplete.title"),
      studio.selectedModel.setup_message || msg("toast.generation.setup_incomplete.short", { missing: studio.selectedModel.missing_dependencies.join(", ") }),
    );
    return;
  }
  if (!generationModeIsAvailable()) return;
  if (!await prepareWriterRequest()) return;

  markActiveWriterRequest();
  studio.lyricsRequestBusy = true;
  submit.disabled = true;
  submit.innerHTML = `<span class="h3ps-spinner"></span>${t(currentLyrics.trim() ? "toast.lyrics.refining" : "toast.lyrics.creating")}`;
  setGenerationState(
    "busy",
    msg(currentLyrics.trim() ? "status.refining_lyrics" : "status.creating_lyrics"),
    studio.selectedModel.name.split("/").pop(),
  );
  try {
    const result = await vramHandoffCoordinator.trackWriterRequest(refine(buildLyricsRefinePayload(studio, {
      currentLyrics,
      instruction,
      useMusicBrief,
      creativeBrief: musicBrief,
      seed: newGenerationSeed(),
    })));
    if (lyrics.value !== currentLyrics) {
      showToast(msg("toast.lyrics.kept.title"), msg("toast.lyrics.kept.message"));
      return;
    }
    studio.lyricsRestore = { lyrics: currentLyrics };
    lyrics.value = result.prompt;
    const restore = panel.querySelector("[data-lyrics-refine-restore]");
    restore.dataset.i18n = currentLyrics.trim() ? "workspace.restore_previous" : "toast.lyrics.remove_generated";
    restore.textContent = currentLyrics.trim() ? t("toast.lyrics.restore_previous") : t("toast.lyrics.remove_generated");
    restore.hidden = false;
    updateMusicLyricsCount();
    saveCurrentModeDraft();
    studio.desktopNotifications.notify(t("toast.lyrics.finished_notification"));
    showToast(
      msg(currentLyrics.trim() ? "toast.lyrics.rewritten.title" : "toast.lyrics.created.title"),
      msg("toast.lyrics.metrics", { total: result.total_seconds.toFixed(1), tps: result.tokens_per_second.toFixed(1) }),
    );
  } catch (error) {
    if (error.code !== "GENERATION_CANCELLED") studio.desktopNotifications.notify(t("toast.lyrics.failed_notification"));
    if (error.code === "GENERATION_CANCELLED") showToast(msg("toast.lyrics.cancelled.title"), msg("toast.lyrics.cancelled.message"));
    else if (error.code === "INSUFFICIENT_FREE_VRAM") showVramRetry(error, submitLyricsRefinement);
    else showErrorToast("toast.lyrics.failed.title", error);
  } finally {
    studio.lyricsRequestBusy = false;
    submit.disabled = false;
    submit.innerHTML = `${icon("spark", 13)} <span data-i18n="workspace.refine">${t("workspace.refine")}</span>`;
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
    showToast(msg("toast.refine.add_note.title"), msg("toast.refine.add_note.message"));
    return;
  }
  if (!studio.selectedModel) {
    showToast(msg("toast.generation.no_model.title"), msg("toast.generation.no_model.message"));
    return;
  }
  if (!studio.selectedModel.runtime_ready) {
    showToast(
      msg("toast.generation.setup_incomplete.title"),
      studio.selectedModel.setup_message || msg("toast.generation.setup_incomplete.short", { missing: studio.selectedModel.missing_dependencies.join(", ") }),
    );
    return;
  }
  if (!generationModeIsAvailable()) return;
  if (!await prepareWriterRequest()) return;

  const previousPrompt = output.value;
  const previousMeta = studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent;
  markActiveWriterRequest();
  submit.disabled = true;
  submit.innerHTML = `<span class="h3ps-spinner"></span>${t("toast.refine.refining")}`;
  setGenerationState("busy", msg("status.refining_prompt"), studio.selectedModel.name.split("/").pop());
  try {
    const result = await vramHandoffCoordinator.trackWriterRequest(refine(buildRefinePayload(studio, {
      currentPrompt: previousPrompt,
      instruction,
      creativeBrief: currentBriefTextarea().value.trim(),
      lyrics: studio.mode === "Music3" ? studio.root.querySelector("[data-music-lyrics]").value : "",
      seed: newGenerationSeed(),
    })));
    if (output.value !== previousPrompt) {
      showToast(msg("toast.refine.kept.title"), msg("toast.refine.kept.message"));
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
    studio.desktopNotifications.notify(t("toast.refine.ready_notification"));
    showToast(
      msg(result.thinking_fallback ? "toast.refine.completed.title" : "toast.refine.rewritten.title"),
      result.thinking_fallback
        ? thinkingFallbackMessage(result, "rewrite")
        : result.format_repair_applied
          ? msg("toast.refine.repair_applied.message")
        : result.format_repair_failure
          ? msg("toast.refine.repair_failed.message")
        : msg("toast.refine.metrics", { total: result.total_seconds.toFixed(1), tps: result.tokens_per_second.toFixed(1) }),
      result.format_repair_applied
        ? (result.format_repair_multimodal
            ? `The first draft failed ${result.format_repair_reason}; the existing references were checked again and repaired once.`
            : `The first draft failed ${result.format_repair_reason}; its format was repaired once without media.`)
        : result.format_repair_failure
          ? `Format warning: ${result.format_repair_reason}; safe repair rejected because ${result.format_repair_failure}.`
          : null,
    );
  } catch (error) {
    if (error.code !== "GENERATION_CANCELLED") studio.desktopNotifications.notify(t("toast.refine.failed_notification"));
    if (error.code === "INSUFFICIENT_FREE_VRAM") showVramRetry(error, submitRefinement);
    else showErrorToast("toast.refine.failed.title", error);
  } finally {
    submit.disabled = false;
    submit.innerHTML = `${icon("spark", 13)} <span data-i18n="workspace.refine">${t("workspace.refine")}</span>`;
    try {
      const status = await getStatus(studio.ollamaHost);
      updatePromptResidency(status);
    } catch {}
    clearActiveWriterRequest();
    setGenerationState("idle", "", "");
  }
}

function musicSystemPromptPanelMarkup(profile, labelKey, descriptionKey, hidden = false) {
  return `
    <div class="h3ps-system-prompt-panel" data-music-system-prompt-panel="${profile}" ${hidden ? "hidden" : ""}>
      <header class="h3ps-system-prompt-editor-heading">
        <button type="button" data-music-system-prompt-back>${icon("chevron", 12)} <span data-i18n="system_prompt.back">Back</span></button>
        <span><small data-i18n="system_prompt.title">System Prompt</small><strong data-i18n="${labelKey}">${t(labelKey)}</strong></span>
        <span class="h3ps-system-prompt-panel-status"><em data-system-prompt-status="${profile}" data-i18n="system_prompt.status">Default</em>${icon("check", 13)}</span>
      </header>
      <p data-i18n="${descriptionKey}">${t(descriptionKey)}</p>
      <textarea data-system-prompt="${profile}" maxlength="8000" spellcheck="true" disabled></textarea>
      <footer><small data-system-prompt-count="${profile}">0 / 8,000</small><button type="button" data-system-prompt-reset="${profile}" hidden data-i18n="system_prompt.restore_default">Restore default</button></footer>
    </div>`;
}

function syncFullscreenState() {
  if (!studio) return;
  studio.root.classList.toggle("is-fullscreen", studio.fullscreen);
  const button = studio.root.querySelector("[data-fullscreen-toggle]");
  const label = t(studio.fullscreen ? "header.exit_fullscreen" : "header.enter_fullscreen");
  button.setAttribute("aria-pressed", String(studio.fullscreen));
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon(studio.fullscreen ? "collapse" : "expand", 17);
}

function syncTheme() {
  if (!studio) return;
  studio.root.dataset.theme = studio.theme;
  studio.floatingMedia?.refresh();
  postThemeToChat();
  const button = studio.root.querySelector("[data-theme-toggle]");
  if (!button) return;
  const light = studio.theme === "light";
  const label = t(light ? "header.theme_dark" : "header.theme_light");
  button.innerHTML = icon(light ? "moon" : "sun", 17);
  button.setAttribute("aria-label", label);
  button.title = label;
  button.setAttribute("aria-pressed", String(light));
}

function syncDurationLabel() {
  if (!studio) return;
  const label = studio.root.querySelector("[data-duration-label]");
  if (label) label.textContent = t("workspace.duration_seconds", { seconds: studio.durationSeconds });
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
    const label = t("header.interface_size", { size });
    button.setAttribute("aria-label", label);
    button.title = label;
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
  const initialPreferences = loadUserPreferences(localStorage);
  configureI18n({
    preference: initialPreferences?.language || "auto",
    app,
    navigatorLanguage: globalThis.navigator?.language || "",
  });
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
        <nav class="h3ps-workspaces" aria-label="${t("header.workspace_nav")}" data-i18n-aria-label="header.workspace_nav">
          <button type="button" data-workspace="video" data-i18n="header.video_workspace">H3 Video</button>
          <button type="button" data-workspace="music" data-i18n="header.music_workspace">Music 3</button>
          <button type="button" data-workspace="chat" class="h3ps-chat-workspace" hidden title="${t("chat.open_title")}" data-i18n-title="chat.open_title">${icon("chat", 14)}<span data-i18n="chat.open">${t("chat.open")}</span></button>
        </nav>
        <div class="h3ps-header-meta">
          <div class="h3ps-guide-picker">
            <button class="h3ps-guide-button" type="button" aria-expanded="false" data-guide-toggle><span data-i18n="header.official_guides">Official guides</span> ${icon("chevron", 13)}</button>
            <div class="h3ps-guide-menu" data-guide-menu hidden><span data-i18n="header.loading_guides">Loading guides…</span></div>
          </div>
          <button class="h3ps-guide-button" type="button" data-open-settings-header data-i18n="settings.title">Settings</button>
          ${supportsWorkflowMedia() ? `<button class="h3ps-icon-button" type="button" data-open-floating-media title="${t("header.media_panel")}" aria-label="${t("header.media_panel")}" data-i18n-title="header.media_panel" data-i18n-aria-label="header.media_panel">${icon("grid", 17)}</button>` : ""}
          <select class="h3ps-language-select" data-language
            title="${t("common.language")}" aria-label="${t("common.language")}"
            data-i18n-title="common.language" data-i18n-aria-label="common.language">
            <option value="auto">Auto</option>
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
          <button class="h3ps-icon-button" type="button" title="Switch to light theme" aria-label="Switch to light theme" aria-pressed="false" data-theme-toggle>${icon("sun", 17)}</button>
          <div class="h3ps-interface-size-picker" data-interface-size-picker>
            <button class="h3ps-icon-button h3ps-interface-size-button" type="button" title="Interface size 100%" aria-label="Interface size 100%" aria-haspopup="true" aria-expanded="false" data-interface-size-toggle>Aa</button>
            <div class="h3ps-interface-size-menu" data-interface-size-menu hidden>
              <header><strong data-i18n="header.interface_size_title">Interface Size</strong><output data-interface-size-value>100%</output></header>
              <input type="range" min="0" max="3" step="1" value="0" aria-label="Interface size" data-i18n-aria-label="header.interface_size_range" data-interface-size-range>
              <div class="h3ps-interface-size-marks" aria-hidden="true"><span>100%</span><span>110%</span><span>120%</span><span>125%</span></div>
            </div>
          </div>
          <button class="h3ps-icon-button" type="button" title="Enter fullscreen" aria-label="Enter fullscreen" aria-pressed="false" data-fullscreen-toggle>${icon("expand", 17)}</button>
          <button class="h3ps-icon-button" type="button" title="Close" data-i18n-title="common.close" data-close-studio>${icon("close", 18)}</button>
        </div>
      </header>

      ${settingsMarkup(icon)}

      <div class="h3ps-workspace-toolbar" data-generate-view>
        <nav class="h3ps-modes" role="tablist" aria-label="${t("workspace.mode_nav")}" data-i18n-aria-label="workspace.mode_nav" data-video-modes>
          ${Object.keys(MODES).map((mode) => `<button type="button" role="tab" data-mode="${mode}">${mode}</button>`).join("")}
        </nav>
        <div class="h3ps-output-toolbar">
          <span data-output-label>Generated prompt</span>
          <div class="h3ps-output-badges"><button type="button" data-undo-edits data-i18n="workspace.undo" hidden>Undo</button></div>
        </div>
      </div>

      <div class="h3ps-workspace" data-generate-view>
        <section class="h3ps-input-panel">
          ${generateModelSummaryMarkup(icon)}
          <div data-video-inputs>
          <div class="h3ps-section-heading">
            <span><small data-i18n="workspace.media_section">Media</small><strong data-h3ps-mode-title></strong></span>
            <div class="h3ps-section-actions">
              <div class="h3ps-clear-control" data-clear-control>
                ${splitMenuMarkup(icon, {label: '<span data-i18n="workspace.actions">Actions</span>', primary: "data-actions-menu-toggle", toggle: "data-clear-menu-toggle", menu: "data-clear-menu", ariaLabel: "Media actions", ariaLabelKey: "workspace.media_actions", contents: `
                  ${supportsWorkflowMedia() ? `<button type="button" data-open-floating-media data-media-panel-action disabled title="${t("header.media_panel")}"><strong data-i18n="header.media_panel">Media panel</strong><small data-i18n="workspace.add_to_workflow">ADD TO WORKFLOW</small></button>` : ""}
                  <button type="button" data-open-composer disabled><strong data-i18n="workspace.compose">Compose</strong><small data-i18n="workspace.create_collage">Create collage</small></button>
                  <hr data-compose-separator>
                  <button type="button" data-draft-save><strong data-i18n="workspace.save_draft">Save text draft</strong><small data-i18n="workspace.download_json">Download JSON</small></button>
                  <button type="button" data-draft-load><strong data-i18n="workspace.load_draft">Load text draft</strong><small data-i18n="workspace.open_json">Open JSON</small></button>
                  <input type="file" accept=".json,application/json" data-draft-file hidden>
                  <hr>
                  <button type="button" data-clear-action data-clear-media><strong data-i18n="workspace.clear_media">Clear media</strong><small data-i18n="workspace.keep_prompts">Keep prompts</small></button>
                  <button type="button" data-clear-action data-clear-prompts><strong data-i18n="workspace.clear_prompts">Clear prompts</strong><small data-i18n="workspace.keep_media">Keep media</small></button>
                  <button class="is-destructive" type="button" data-clear-action data-clear-all><strong data-i18n="workspace.clear_all">Clear all</strong><small data-i18n="workspace.clear_all_note">Media and prompts</small></button>
                `})}
              </div>
            </div>
          </div>
          <p class="h3ps-section-hint" data-h3ps-mode-hint></p>
          <div class="h3ps-media" data-h3ps-media></div>

          <div class="h3ps-control-grid">
            <label class="h3ps-field h3ps-duration-field"><span><span data-i18n="workspace.duration">Duration</span> <b data-duration-label>10 seconds</b></span><div><input type="range" min="1" max="20" step="1" value="10" style="--h3ps-range:47.37%" data-duration-slider><i></i></div></label>
            ${aspectRatioMarkup(icon)}
          </div>

          <label class="h3ps-brief">
            <span><strong data-i18n="workspace.creative_brief">Creative brief</strong><small data-i18n="workspace.creative_brief_hint">Describe what should happen in the video</small></span>
            <textarea spellcheck="true" data-video-brief>Use identity and wardrobe from Picture 1 and the slow lateral camera movement from Video 1. A solitary character waits at a rain-soaked tram stop at blue hour, notices an approaching light and turns into the wind. End on a quiet, unresolved look; keep the shot cinematic, realistic and restrained.</textarea>
            <small class="h3ps-char-count">0 characters</small>
          </label>

          </div>

          <div class="h3ps-music-inputs" data-music-inputs hidden>
            <label class="h3ps-brief">
              <span><strong data-i18n="workspace.music_brief">Music brief</strong><small data-i18n="workspace.music_brief_hint">Describe the sound, vocals, mood, arrangement or production</small></span>
              <textarea spellcheck="true" maxlength="2000" data-music-brief>${MUSIC3_DEFAULT_DRAFT.brief}</textarea>
              <small class="h3ps-char-count">0 / 2,000</small>
            </label>
            <label class="h3ps-brief h3ps-lyrics">
              <span><strong data-i18n="workspace.lyrics">Lyrics</strong><small data-i18n="workspace.optional">Optional</small></span>
              <textarea spellcheck="true" maxlength="4000" data-music-lyrics placeholder="[Verse 1]&#10;...&#10;&#10;[Chorus]&#10;..."></textarea>
              <small class="h3ps-char-count">0 / 4,000</small>
            </label>
            <div class="h3ps-lyrics-refine-tools">
              <button class="h3ps-secondary-button" type="button" title="${t("workspace.refine_lyrics_tooltip")}" data-i18n-title="workspace.refine_lyrics_tooltip" data-lyrics-refine-toggle>${icon("spark", 15)} <span data-i18n="workspace.refine">Refine</span></button>
            </div>
            <section class="h3ps-refine h3ps-lyrics-refine" data-lyrics-refine-panel hidden>
              <div class="h3ps-refine-heading">
                <span><strong data-i18n="workspace.refine_lyrics">Refine lyrics</strong><small data-i18n="workspace.refine_lyrics_hint">Create new Lyrics or rewrite the current text</small></span>
                <label class="h3ps-lyrics-brief-option"><input type="checkbox" data-lyrics-use-brief checked><span data-i18n="workspace.use_music_brief">Use Music Brief</span></label>
              </div>
              <textarea rows="2" data-lyrics-refine-instruction placeholder="Leave Lyrics empty to create new lyrics, or describe how to rewrite the existing lyrics." data-i18n-placeholder="workspace.lyrics_refine_placeholder"></textarea>
              <div class="h3ps-refine-actions">
                <button type="button" class="h3ps-text-button" data-lyrics-refine-restore hidden data-i18n="workspace.restore_previous">Restore previous</button>
                <span></span>
                <button type="button" class="h3ps-text-button" data-lyrics-refine-cancel data-i18n="common.cancel">Cancel</button>
                <button type="button" class="h3ps-refine-submit" data-lyrics-refine-submit>${icon("spark", 13)} <span data-i18n="workspace.refine">Refine</span></button>
              </div>
            </section>
            <section class="h3ps-music-system-prompt">
              <button class="h3ps-music-system-prompt-toggle" type="button" data-music-system-prompt-toggle aria-expanded="false">
                <strong data-i18n="system_prompt.title">System Prompt</strong>
                <span><em data-music-system-prompt-summary>Default</em>${icon("chevron", 12)}</span>
              </button>
              <div data-music-system-prompt-details hidden>
                <div class="h3ps-system-prompt-overview" data-music-system-prompt-overview>
                  <button type="button" data-music-system-prompt-profile="music3">
                    <span><strong data-i18n="workspace.caption">Caption</strong><small data-i18n="workspace.generated_caption_note">Generated Caption</small></span>
                    <span><em data-system-prompt-summary-status="music3">Default</em><b data-i18n="common.edit">Edit</b>${icon("chevron", 12)}</span>
                  </button>
                  <button type="button" data-music-system-prompt-profile="music3_lyrics">
                    <span><strong data-i18n="workspace.lyrics">Lyrics</strong><small data-i18n="workspace.create_refine_lyrics_note">Create and refine Lyrics</small></span>
                    <span><em data-system-prompt-summary-status="music3_lyrics">Default</em><b data-i18n="common.edit">Edit</b>${icon("chevron", 12)}</span>
                  </button>
                </div>
                <div class="h3ps-system-prompt-editor" data-music-system-prompt-editor hidden>
                  ${musicSystemPromptPanelMarkup("music3", "workspace.caption", "system_prompt.music3_description")}
                  ${musicSystemPromptPanelMarkup("music3_lyrics", "workspace.lyrics", "system_prompt.music3_lyrics_description", true)}
                </div>
              </div>
            </section>
          </div>
        </section>

        <section class="h3ps-output-panel" aria-label="${t("workspace.generated_result")}" data-i18n-aria-label="workspace.generated_result">
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
                <button type="button" class="h3ps-text-button" data-refine-restore hidden data-i18n="workspace.restore_original">Restore original</button>
                <button type="button" class="h3ps-text-button" data-refine-cancel data-i18n="common.cancel">Cancel</button>
                <button type="button" class="h3ps-refine-submit" data-refine-submit>${icon("spark", 13)} <span data-i18n="workspace.refine">Refine</span></button>
              </div>
            </div>
            <textarea rows="2" data-refine-instruction placeholder="For example: make the camera movement slower and keep the ending more ambiguous." data-i18n-placeholder="workspace.refine_placeholder"></textarea>
          </div>
          <div class="h3ps-output-actions">
            <span class="h3ps-output-primary-actions">
              <button class="h3ps-secondary-button" type="button" title="${t("workspace.refine_tooltip")}" data-i18n-title="workspace.refine_tooltip" data-refine-toggle>${icon("spark", 15)} <span data-i18n="workspace.refine">Refine</span></button>
            </span>
            ${copyButtonMarkup(icon, "data-copy", '<span data-copy-label>Copy prompt</span>')}
          </div>
        </section>
      </div>

      <div class="h3ps-chat-view" data-chat-view hidden>
        <iframe class="h3ps-chat-frame" data-chat-frame title="${t("chat.title")}" data-i18n-title="chat.title"></iframe>
      </div>

      <footer class="h3ps-footer" data-generate-view>
        <div class="h3ps-footer-memory-actions">
          <button class="h3ps-memory-action" type="button" data-comfy-memory-action title="${t("generation.free_vram_tooltip")}" data-i18n-title="generation.free_vram_tooltip">${icon("memory", 15)}<span data-i18n="workspace.free_comfy_vram">Free ComfyUI VRAM</span></button>
          <span class="h3ps-prompt-lifecycle-actions" data-prompt-lifecycle-actions></span>
        </div>
        <div class="h3ps-status is-busy" role="status" aria-live="polite" aria-atomic="true" data-status hidden><span><strong></strong><small data-status-detail></small></span></div>
        <div class="h3ps-footer-actions">
          <span class="h3ps-generation-options">
            <label class="h3ps-toggle-control"><input type="checkbox" data-thinking><span></span>Thinking</label>
            <label class="h3ps-toggle-control" data-keep-loaded-control title="${t("workspace.keep_model_loaded_tooltip")}" data-i18n-title="workspace.keep_model_loaded_tooltip" hidden><input type="checkbox" data-keep-loaded><span></span><span class="h3ps-toggle-label" data-i18n="workspace.keep_model_loaded">Keep model loaded</span></label>
            ${autoVramControlMarkup(VRAM_HANDOFF_SUPPORTED)}
          </span>
          <button class="h3ps-primary-button" type="button" data-generate>${icon("spark", 16)}<span data-generate-label>Generate prompt</span></button>
        </div>
      </footer>
    </section>

    <div class="h3ps-other-models-backdrop" aria-hidden="true" data-other-models-backdrop hidden></div>
    <section class="h3ps-other-models-popover" role="dialog" aria-label="${t("workspace.other_models")}" data-i18n-aria-label="workspace.other_models" data-other-models-popover hidden>
      <header><span><strong data-i18n="workspace.other_models">Other verified models</strong><small data-i18n="workspace.recommended_pairs">Recommended GGUF and projector pairs</small></span><button class="h3ps-icon-button" type="button" aria-label="${t("workspace.close_other_models")}" data-i18n-aria-label="workspace.close_other_models" data-other-models-close>${icon("close", 16)}</button></header>
      <div class="h3ps-other-models-catalog" data-other-models-catalog></div>
    </section>

    <div class="h3ps-toast" role="status" aria-live="polite" aria-atomic="true" data-h3ps-toast><span class="h3ps-toast-icon">${icon("info", 17)}</span><span><strong data-toast-title>Notice</strong><span data-toast-message></span><button type="button" class="h3ps-toast-action" data-toast-action hidden></button><details data-toast-details hidden><summary data-i18n="common.technical_details">Technical details</summary><pre></pre></details></span></div>`;
  document.body.appendChild(root);
  configureI18n({
    preference: initialPreferences?.language || "auto",
    app,
    navigatorLanguage: globalThis.navigator?.language || "",
    root,
  });
  translateDom(root);
  studio = { root, ...createStudioState({ sessionId: createSessionId(), storage: localStorage }) };
  root.querySelector("[data-language]").value = getLanguagePreference();
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
  const mediaToolUnavailable = (message) => showToast(msg("toast.media_tool.unavailable.title"), message);
  studio.mediaComposer = createLazyMediaTool(root, async () => {
    const { createMediaComposer } = await import("./media_composer.js");
    return createMediaComposer({
      root,
      icon,
      onAddPicture: addComposedPicture,
      getAddState: composerAddState,
      notify: (kind, message) => showToast(msg(kind === "error" ? "toast.composer.failed.title" : "toast.composer.title"), message),
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
        showToast(msg("toast.media.picture_added.title"), result.assets[0].reference);
        renderMedia(studio.mode);
      },
      onAddAudio: async (blob, filename) => {
        const result = await uploadMedia(studio.sessionId, "Reference", [new File([blob], filename, { type: "audio/wav" })]);
        studio.assets.push(...result.assets);
        showToast(
          msg("toast.media.audio_added.title"),
          msg("toast.media.editor_audio.message", { reference: result.assets[0].reference }),
        );
        renderMedia(studio.mode);
      },
      request: (assetId, options) => editMedia(studio.sessionId, assetId, options),
      onSaved: (result) => {
        showToast(msg("toast.media.applied.title"), msg("toast.media.applied.message"));
        acceptMediaAssets(result.assets);
        renderMedia(studio.mode);
      },
      notify: (message) => showToast(msg("toast.media_editor.title"), message),
      onOpenChange: onMediaToolOpenChange,
    });
  }, mediaToolUnavailable);
  root.querySelector("[data-lyrics-use-brief]").checked = studio.musicLyricsUseBrief;
  const durationSlider = root.querySelector("[data-duration-slider]");
  durationSlider.value = String(studio.durationSeconds);
  durationSlider.style.setProperty("--h3ps-range", `${(studio.durationSeconds - 1) / 19 * 100}%`);
  syncDurationLabel();
  studio.aspectControl = bindAspectRatio(root.querySelector('[data-choice-toggle="aspect"]').closest(".h3ps-choice"), studio.aspectRatio, value => {
    studio.aspectRatio = value;
    saveUserPreferences(localStorage, studio);
  });
  syncTheme();
  syncInterfaceSize();
  syncFullscreenState();
  root.querySelectorAll("[data-close-studio]").forEach((el) => el.addEventListener("click", closeStudio));
  root.querySelector("[data-fullscreen-toggle]").addEventListener("click", () => setFullscreen(!studio.fullscreen));
  root.querySelector("[data-language]").addEventListener("change", (event) => {
    const language = normalizeLanguagePreference(event.target.value);
    studio.language = language;
    studio.languageChosen = true;
    setLanguagePreference(event.target.value);
    saveUserPreferences(localStorage, studio);
    console.log(`[H3 Writer i18n] preference=${language} locale=${getLocale()}`);
  });
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
    if (button.dataset.workspace === "chat") {
      activateLlamaChatTab();
      return;
    }
    const nextMode = button.dataset.workspace === "music" ? "Music3" : studio.lastVideoMode;
    if (!isGenerationModeAvailable(studio.selectedModel, nextMode)) return;
    if (nextMode === studio.mode && !studio.chatOpen) return;
    const modeChanged = nextMode !== studio.mode;
    if (modeChanged) {
      stashCurrentModeDraft();
      if (studio.mode !== "Music3") studio.lastVideoMode = studio.mode;
      studio.mode = nextMode;
    }
    studio.chatOpen = false;
    syncWorkspace();
    if (modeChanged) {
      restoreModeDraft(studio.mode);
      renderMedia(studio.mode);
    }
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
  const chatFrame = root.querySelector("[data-chat-frame]");
  chatFrame?.addEventListener("load", () => {
    if (studio?.chatBusy) {
      console.log("[H3 Writer chat] chat page reloaded; clearing the stale busy flag");
    }
    if (studio) studio.chatBusy = false;
    syncChatFramePreferences();
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || !studio) return;
    if (event.source && event.source !== chatFrame?.contentWindow) return;
    if (event.data?.type === "h3ps-chat-busy") {
      const busy = event.data.busy === true;
      if (studio.chatBusy !== busy) {
        studio.chatBusy = busy;
        console.log(`[H3 Writer chat] reply generating=${busy} reported by the chat tab`);
      }
      return;
    }
    if (event.data?.type === "h3ps-close-chat") {
      studio.chatOpen = false;
      syncWorkspace();
      console.log("[H3 Writer chat] closed from the chat tab");
      return;
    }
    if (event.data?.type !== "h3ps-open-settings") return;
    setSettingsOpen(true);
    studio.settingsProvider = "external";
    renderInferenceSettings();
    window.focus();
  });
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
      if(file.size>2_000_000) {
        throw Object.assign(Error("Draft file is too large (maximum 2 MB)."), { code: "DRAFT_TOO_LARGE" });
      }
      const value=parseDraft(await file.text());
      showToast(
        msg("toast.draft.confirm.title"),
        msg("toast.draft.confirm.message"),
        value.media.length ? {references:value.media} : null,
        {label:msg("toast.draft.confirm.action"),onClick:()=>loadTextDraft(value)},
      );
    } catch(error) { showErrorToast("toast.draft.load_failed.title", error); }
  };
  root.querySelector("[data-restore-default-drafts]").addEventListener("click", restoreDefaultDrafts);
  root.querySelector("[data-comfy-memory-action]").addEventListener("click", () => releaseComfyVram());
  root.querySelector("[data-guide-toggle]").addEventListener("click", async () => {
    const menu = root.querySelector("[data-guide-menu]");
    menu.hidden = !menu.hidden;
    root.querySelector("[data-guide-toggle]").setAttribute("aria-expanded", String(!menu.hidden));
    if (menu.hidden) return;
    if (studio.mode === "Music3") {
      menu.innerHTML = `<a href="${MUSIC3_GUIDE_URL}" target="_blank" rel="noopener noreferrer"><strong>${t("guide.music.title")}</strong><small>${t("guide.music.subtitle")}</small></a>`;
      return;
    }
    try {
      if (!studio.guides.length) {
        const result = await getGuides();
        studio.guides = result.guides;
      }
      menu.innerHTML = studio.guides.map((guide) => `<a href="${escapeHtml(guide.source_url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(guide.filename)}</strong><small>${escapeHtml(guide.modes.join(" · "))}</small></a>`).join("");
    } catch (error) {
      showErrorToast("toast.guides.unavailable.title", error);
    }
  });

  root.querySelector("[data-duration-slider]").addEventListener("input", (event) => {
    studio.durationSeconds = Number(event.target.value);
    syncDurationLabel();
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
    setSystemPromptStatus(status, custom);
    setSystemPromptStatus(summaryStatus, custom);
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
    showToast(
      msg("toast.system_prompt.reset.title"),
      msg(profile === "music3"
        ? "toast.system_prompt.reset.music3"
        : profile === "music3_lyrics"
        ? "toast.system_prompt.reset.music3_lyrics"
        : "toast.system_prompt.reset.default", { profile }),
    );
  }));
  root.querySelector("[data-thinking]").addEventListener("change", (event) => {
    studio.thinking = event.target.checked;
    syncRuntimeSummary();
  });
  root.querySelector("[data-keep-loaded]").addEventListener("change", (event) => {
    if (studio.selectedModel?.family !== "gguf") {
      event.target.checked = false;
      studio.keepModelLoaded = false;
      return;
    }
    studio.keepModelLoaded = event.target.checked;
  });
  root.querySelector("[data-vram-handoff]")?.addEventListener("change", (event) => {
    studio.vramHandoff = event.target.checked;
    studio.vramHandoffChosen = true;
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
    showToast(
      msg("toast.models.refreshed.title"),
      msg(count === 1 ? "models.refreshed.one" : "models.refreshed.other", { count }),
    );
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
      showToast(msg("toast.copy.command.title"), msg("toast.copy.command.ollama", { command }));
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
      showToast(msg("toast.copy.command.title"), msg("toast.copy.command.runtime"));
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
      showToast(msg("toast.copy.model_path.title"), studio.modelDirectory || "ComfyUI/models/LLM/");
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
      previousLyrics.trim() ? msg("toast.lyrics.previous_restored.title") : msg("toast.lyrics.generated_removed.title"),
      msg("toast.lyrics.restore.message"),
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
    showToast(msg("toast.refine.restored.title"), msg("toast.refine.restored.message"));
  });
  root.querySelector("[data-undo-edits]").addEventListener("click", () => {
    if (typeof studio.lastModelPrompt !== "string") return;
    const output = root.querySelector("[data-output]");
    output.value = studio.lastModelPrompt;
    root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.lastModelMeta;
    renderPromptHighlights();
    syncModifiedState();
    saveCurrentModeDraft();
    showToast(msg("toast.edits.undone.title"), msg("toast.edits.undone.message"));
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
      if (!studio.selectedModel?.runtime_ready) throw new Error(t("workspace.select_ready_model"));
      studio.modelSelectionRevision = (studio.modelSelectionRevision || 0) + 1;
      return buildGeneratePayload(studio, { creativeBrief: "", seed: newGenerationSeed() });
    },
    prepare: prepareWriterRequest,
    run: (payload, onEvent) => vramHandoffCoordinator.trackWriterRequest(generateSequence(payload, onEvent)),
    cancel: (operationId) => cancelSequence(operationId, studio.sessionId),
    busy: (busy) => {
      if (busy) markActiveWriterRequest(); else clearActiveWriterRequest();
      setGenerationState(busy ? "busy" : "idle", msg("status.generating_sequence"), msg("status.detail.sequence_kept"));
      root.querySelector(".h3ps-generation-options").inert = busy;
      root.querySelector("[data-settings-view]").inert = busy;
    },
    refresh: () => { syncWorkspace(); renderMedia(studio.mode); },
    clearMedia: () => clearCurrentMedia(),
    settled: (status) => studio.desktopNotifications.notify(
      t(status === "complete" ? "notification.sequence_done" : "notification.sequence_attention"),
    ),
    error: (error) => showErrorToast("toast.sequence.title", error, sequenceNotificationOptions(error)),
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
  const refreshLocalizedUi = () => {
    studio.localeRefreshing = true;
    try {
      syncTheme();
      syncFullscreenState();
      syncInterfaceSize();
      syncDurationLabel();
      syncWorkspace();
      syncModeAvailability();
      syncSelectedModelSourceLabel();
      syncActiveModelSummary();
      syncLifecycleActions();
      syncProviderSettings();
      syncProviderPanelCopy();
      syncRuntimeSummary();
      syncThinkingAvailability();
      syncContextAvailability();
      syncAdvancedRuntimeControls();
      syncSystemPromptEditors();
      syncMusicSystemPromptSummary();
      syncNotifications();
      syncOutputLengthMeta();
      updateBriefLayout();
      updateMusicLyricsCount();
      const comfyMemory = root.querySelector("[data-comfy-memory-action]");
      if (comfyMemory) {
        comfyMemory.title = studio.requestBusy
          ? t("generation.free_vram_busy")
          : t("generation.free_vram_tooltip");
      }
      renderMedia(studio.mode);
      if (studio.generationSnapshot) {
        writeStatusContent(root.querySelector("[data-status]"), {
          ...studio.generationSnapshot,
          dots: studio.generationDotCount,
        });
      }
      if (studio.toastSnapshot) writeToastContent(root.querySelector("[data-h3ps-toast]"), studio.toastSnapshot);
      studio.sequence?.refresh();
    } finally {
      studio.localeRefreshing = false;
    }
  };
  onLocaleChange(() => {
    console.log(`[H3 Writer i18n] ui refreshed locale=${document.documentElement.lang}`);
    refreshLocalizedUi();
    postLocaleToChat();
  });
  return studio;
}

function supportsWorkflowMedia() {
  return HOST_CAPABILITIES.workflowMedia && !!(app.canvas?.graph && window.LiteGraph?.createNode && app.clientPosToCanvasPos);
}

async function openFloatingMedia() {
  const current = createStudio();
  const hasMedia = () => current.assets.some(asset => ["image", "video", "audio"].includes(asset.type) && asset.content_url);
  if (!hasMedia()) { openStudio(); showToast(msg("media.add_first"), ""); return; }
  if (!supportsWorkflowMedia()) { openStudio(); showToast(msg("toast.media.workflow_unavailable.title"), ""); return; }
  const request = ++mediaPanelRequest;
  try {
    if (!current.floatingMedia) {
      current.floatingMediaPending ||= Promise.all([
        import("./floating_media.js"), import("./workflow_media.js"), import("/scripts/api.js"),
      ]).then(([{ createFloatingMediaPanel }, { createWorkflowMediaTransfer, createMediaMaterializer, workflowMediaSnapshot }, { api }]) => {
        current.floatingMedia = createFloatingMediaPanel({
          app, getState: () => current, icon, openWriter: openStudio,
          transfer: createWorkflowMediaTransfer({ app, liteGraph: window.LiteGraph,
            getWorkflowRevision: () => workflowRevision,
            isCurrentMedia: snapshot => workflowMediaSnapshot(current.assets.find(asset => asset.id === snapshot.id))?.url === snapshot.url,
            materialize: createMediaMaterializer((...args) => api.fetchApi(...args)) }),
        });
      }).finally(() => { current.floatingMediaPending = null; });
      await current.floatingMediaPending;
    }
    if (request !== mediaPanelRequest) return;
    if (!hasMedia()) { openStudio(); showToast(msg("media.add_first"), ""); return; }
    if (closeStudio() === false) return;
    current.floatingMedia.open();
  } catch (error) { showErrorToast("toast.media_panel.unavailable.title", error); }
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
  releaseStudioResources("studio-opened");
}

function closeStudio() {
  if (!HOST_CAPABILITIES.windowed) return false;
  mediaPanelRequest++;
  if (!studio?.root.classList.contains("is-open")) return;
  const writerBusy = Boolean(studio.requestBusy);
  const chatBusy = Boolean(studio.chatBusy);
  if (writerBusy || chatBusy) {
    console.log(
      `[H3 Writer] close refused while generating request_busy=${writerBusy} ` +
      `chat_busy=${chatBusy}`,
    );
    const message = writerBusy && chatBusy ? "toast.close.both_busy"
      : writerBusy ? "toast.close.writer_busy"
        : "toast.close.chat_busy";
    showToast(msg("toast.close.busy_title"), msg(message));
    return false;
  }
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
  releaseStudioResources("studio-closed");
}

function syncLauncherLabels(doc = document) {
  const launcher = doc.querySelector("[data-h3ps-launcher]");
  if (!launcher) return;
  launcher.setAttribute("aria-label", t("launcher.open"));
  launcher.title = t("launcher.open_title");
  const image = launcher.querySelector("img");
  if (image) image.alt = t("launcher.alt");
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
  const launcherIcon = new URL("./assets/h3-prompt-writer-launcher.svg", import.meta.url).href;
  launcher.innerHTML = `<img src="${launcherIcon}" alt="">`;
  document.body.appendChild(launcher);
  syncLauncherLabels(document);

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
    configureI18n({
      preference: loadUserPreferences(localStorage)?.language || "auto",
      app,
      navigatorLanguage: navigator.language,
      root: null,
    });
    installVramHandoff(app, {
      isEnabled: vramHandoffIsEnabled,
      onQueueRequested: () => vramHandoffCoordinator.invalidateWriterAttempts(),
      beforeQueue: unloadWriterModelsBeforeQueue,
      onError: showVramHandoffQueueError,
      onQueueHandoffEnd: () => vramHandoffCoordinator.finishQueueHandoff(),
    });
    installLauncher();
    onLocaleChange(() => syncLauncherLabels());
  },
});
