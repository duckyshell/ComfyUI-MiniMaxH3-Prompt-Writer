import { app } from "/scripts/app.js";
import { cancel, clearMedia, diagnoseGGUFRuntime, disconnectApiProvider, freeComfyVram, generate, getApiProviderModels, getApiProviderPresets, getGuides, getModels, getOllamaStatus, getStatus, getSystemPrompt, probeApiProvider, probeExternalServer, refine, removeMedia, reorderMedia, resampleMedia, setMediaAnalysis, unloadModel, uploadMedia } from "./api/h3studio.js";
import { createSessionId, isChoiceMenuInteraction, isGuideMenuInteraction, isRuntimeMenuInteraction, moveOntoTarget, replaceEventListener } from "./compat.js";
import { generateModelSummaryMarkup, settingsMarkup } from "./settings.js";
import {
  buildGeneratePayload,
  buildRefinePayload,
  createStudioState,
  saveApiProviderConfig,
  saveCustomSystemPrompts,
  saveExternalServerConfig,
  saveOllamaModel,
  selectModelState,
} from "./studio_state.js";

const EXTENSION_NAME = "minimax.h3.prompt.studio";
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
  const status = studio.root.querySelector(`[data-system-prompt-status="${profile}"]`);
  const reset = studio.root.querySelector(`[data-system-prompt-reset="${profile}"]`);
  const count = studio.root.querySelector(`[data-system-prompt-count="${profile}"]`);
  const requestMode = profile === "reference" ? "Reference" : "T2VA";
  textarea.disabled = true;
  if (!studio.systemPromptDefaults[profile]) {
    try {
      const result = await getSystemPrompt(requestMode);
      studio.systemPromptDefaults[result.profile] = result.system_prompt;
    } catch (error) {
      textarea.value = "";
      status.textContent = "Unavailable";
      showToast(error.code || "System Prompt unavailable", error.message, error.details);
      return;
    }
  }
  const custom = Object.hasOwn(studio.customSystemPrompts, profile);
  textarea.value = custom ? studio.customSystemPrompts[profile] : studio.systemPromptDefaults[profile];
  textarea.disabled = false;
  status.textContent = custom ? "Custom" : "Default";
  reset.hidden = !custom;
  count.textContent = `${textarea.value.length.toLocaleString()} / 8,000`;
  resizeSystemPromptEditor(textarea);
}

function syncSystemPromptEditors() {
  return Promise.all([syncSystemPromptEditor("standard"), syncSystemPromptEditor("reference")]);
}

function setSystemPromptProfile(profile) {
  if (!studio) return;
  studio.settingsPromptProfile = profile === "reference" ? "reference" : "standard";
  studio.root.querySelectorAll("[data-system-prompt-profile]").forEach((button) => {
    const selected = button.dataset.systemPromptProfile === studio.settingsPromptProfile;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  studio.root.querySelectorAll("[data-system-prompt-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.systemPromptPanel !== studio.settingsPromptProfile;
  });
  syncSystemPromptEditor(studio.settingsPromptProfile);
}

function renderPromptHighlights() {
  if (!studio) return;
  const editor = studio.root.querySelector("[data-output]");
  const layer = studio.root.querySelector("[data-prompt-highlights]");
  if (!editor || !layer) return;
  const tokens = /(?<dialogue>&lt;d&gt;[\s\S]*?&lt;\/d&gt;)|(?<media>@(?:Image|Video|Audio)\d+|&lt;(?:Picture|Video|Audio)\s+\d+&gt;)|(?<subject>&lt;Subject\s+\d+&gt;)|(?<section>^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):)|(?<shot>\[Shot\s+\d+\])|(?<time>\b(?:\d{1,2}:\d{2}(?:\.\d{1,3})?|\d+(?:\.\d+)?\s+seconds?)\b)/gim;
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
  studio.root.querySelector("[data-modified-badge]").hidden = !modified;
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
  const audioUnavailable = asset.type === "audio" && !studio.audioSupported;
  const analysisExcluded = asset.type !== "audio" && !asset.analysis_requested;
  const visual = asset.type === "audio"
    ? `<div class="h3ps-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>`
    : asset.preview_url
      ? `<span class="h3ps-thumb-backdrop" style="background-image:url('${asset.preview_url}')"></span><img class="h3ps-real-thumb" src="${asset.preview_url}" alt="">`
      : `<div class="h3ps-thumb-art h3ps-tone-${asset.tone || "blue"}"><span></span></div>`;
  const overlay = asset.type === "video" ? `<span class="h3ps-play">${icon("play", 18)}</span>` : "";
  const duration = formatDuration(asset.duration);
  return `
    <div class="h3ps-asset ${analysisExcluded ? "is-excluded" : ""}" draggable="true" data-asset-index="${index}" data-asset-id="${asset.id}">
      <span class="h3ps-asset-preview h3ps-${asset.type}">${visual}${overlay}${audioUnavailable ? '<em class="h3ps-excluded-badge" title="Audio is not analyzed by the local model">Not analyzed locally</em>' : analysisExcluded ? '<em class="h3ps-excluded-badge">Excluded</em>' : ""}</span>
      <span class="h3ps-asset-copy">
        <strong>${escapeHtml(asset.reference)}</strong>
        <small>${escapeHtml(asset.filename)}</small>
      </span>
      ${duration ? `<span class="h3ps-duration">${duration}</span>` : ""}
      <button class="h3ps-more" type="button" data-asset-menu-toggle="${asset.id}" title="Asset actions">${icon("dots", 16)}</button>
      <div class="h3ps-asset-menu" data-asset-menu="${asset.id}" hidden>
        <button type="button" data-preview-asset="${asset.id}">Preview</button>
        ${asset.mode !== "Reference" ? `<button type="button" data-replace-asset="${asset.id}">Replace image</button>` : ""}
        <button type="button" data-analysis-asset="${asset.id}" ${audioUnavailable ? "disabled title=\"Audio stays in the prompt manifest but is not heard by the local model\"" : ""}>${audioUnavailable ? "Not analyzed by local model" : asset.analysis_requested ? "Exclude from AI analysis" : "Use for AI analysis"}</button>
        <button type="button" data-remove-asset="${asset.id}">Remove</button>
      </div>
    </div>`;
}

function renderMedia(mode) {
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
        ${canAdd ? `<button class="${assets.length ? "h3ps-add-asset" : "h3ps-empty-drop"}" type="button" data-add-media>${icon("plus", 18)}<span>${addLabel}</span><small>Drop files here</small></button>` : ""}
      </div>`;
  }
  bindMediaActions(mode);
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
  studio.root.querySelectorAll("[data-analysis-asset]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const asset = studio.assets.find((item) => item.id === button.dataset.analysisAsset);
      try {
        const result = await setMediaAnalysis(studio.sessionId, asset.id, !asset.analysis_requested);
        Object.assign(asset, result.asset);
        renderMedia(mode);
      } catch (error) {
        showToast(error.code || "Update failed", error.message, error.details);
      }
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
  if (!files.length) return;
  const existing = studio.assets.filter((asset) => asset.mode === mode);
  if (mode !== "Reference" && !replaceAssetId && existing.length + files.length > MODES[mode].limit) {
    showToast("Reference slot is full", "Use Replace on the existing image.");
    return;
  }
  showToast("Processing media", "Creating previews and the ordered contact sheet…");
  try {
    if (replaceAssetId) {
      const removed = await removeMedia(studio.sessionId, replaceAssetId);
      studio.assets = removed.assets;
    }
    const result = await uploadMedia(studio.sessionId, mode, files);
    studio.sessionId = result.session_id;
    studio.assets.push(...result.assets);
    renderMedia(mode);
    hideToast();
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
    control.disabled = updating;
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

function showToast(title, message, details = null, action = null) {
  const toast = studio.root.querySelector("[data-h3ps-toast]");
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
  toast.classList.add("is-visible");
  clearTimeout(studio.toastTimer);
  studio.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), action ? 12000 : details == null ? 2800 : 7000);
}

function hideToast() {
  if (!studio) return;
  clearTimeout(studio.toastTimer);
  studio.root.querySelector("[data-h3ps-toast]").classList.remove("is-visible");
}

function setGenerationState(state, label, detail) {
  const button = studio.root.querySelector("[data-generate]");
  const status = studio.root.querySelector("[data-status]");
  const statusDetail = studio.root.querySelector("[data-status-detail]");
  const lifecycle = studio.root.querySelector("[data-model-lifecycle]");
  const lifecycleLabel = studio.root.querySelector("[data-model-lifecycle-label]");
  const busy = state === "busy";
  studio.requestBusy = busy;
  const remote = ["external", "api"].includes(studio.selectedModel?.family);
  button.classList.toggle("is-cancel", busy);
  button.innerHTML = busy ? `<span class="h3ps-spinner"></span>Cancel` : `${icon("spark", 16)}Generate prompt`;
  lifecycle.hidden = !busy && !studio.modelLoaded;
  lifecycle.classList.toggle("is-busy", busy);
  if (busy) {
    studio.lifecycleDotCount = ((studio.lifecycleDotCount || 0) % 3) + 1;
    lifecycleLabel.textContent = `${remote ? "External request active" : "Prompt model active"}${".".repeat(studio.lifecycleDotCount)}`;
  } else {
    studio.lifecycleDotCount = 0;
    lifecycleLabel.textContent = "Model loaded";
  }
  syncMemoryAction(busy);
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

function syncMemoryAction(busy = studio.requestBusy) {
  const button = studio.root.querySelector("[data-memory-action]");
  if (busy) {
    const remote = ["external", "api"].includes(studio.selectedModel?.family);
    button.innerHTML = `${icon("memory", 15)}${remote ? "Stop request" : "Stop & unload"}`;
    button.title = remote ? "Cancel the request. The remote provider may continue processing or billing." : "Stop the current prompt generation and unload its local model";
  } else if (studio.modelLoaded) {
    button.innerHTML = `${icon("memory", 15)}Unload prompt model`;
    button.title = "Unload the local prompt model from GPU memory";
  } else {
    button.innerHTML = `${icon("memory", 15)}Free ComfyUI VRAM`;
    button.title = "Unload models held by ComfyUI without clearing cached workflow results";
  }
}

async function releaseComfyVram({ retry = null } = {}) {
  const button = studio.root.querySelector("[data-memory-action]");
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
    syncMemoryAction(false);
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

async function runMemoryAction() {
  const button = studio.root.querySelector("[data-memory-action]");
  if (button.disabled) return;
  const busy = studio.requestBusy;
  if (!busy && !studio.modelLoaded) {
    await releaseComfyVram();
    return;
  }
  const remote = ["external", "api"].includes(studio.selectedModel?.family);
  if (busy) setGenerationState("busy", remote ? "Stopping request" : "Stopping & unloading", remote ? "Remote processing may not stop immediately" : "Cancelling the request and unloading its model");
  button.disabled = true;
  try {
    await unloadModel();
    studio.modelLoaded = false;
    showToast(
      busy ? (remote ? "Stop requested" : "Stop & unload requested") : "Prompt model unloaded",
      busy ? (remote ? "The local request will stop. The provider may continue processing or billing." : "The request will stop and release its model at the next safe point.") : "GPU memory used by the local prompt model was released.",
    );
    if (!busy) setGenerationState("idle", "", "");
  } catch (error) {
    showToast(error.code || "Unload failed", error.message, error.details);
  } finally {
    button.disabled = false;
    if (!busy) syncMemoryAction(false);
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
  if (!studio.root.querySelector("[data-modified-badge]").hidden && !window.confirm("Replace the modified prompt with a new generation?")) return;
  const modelName = studio.selectedModel.name.split("/").pop();
  const external = studio.selectedModel.family === "external";
  const apiProvider = studio.selectedModel.family === "api";
  const remote = external || apiProvider;
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
      creativeBrief: studio.root.querySelector(".h3ps-brief textarea").value,
      seed: newGenerationSeed(),
    }));
    const output = studio.root.querySelector("[data-output]");
    output.value = result.prompt;
    studio.lastModelPrompt = result.prompt;
    renderPromptHighlights();
    studio.lastModelMeta = formatGenerationMeta(result);
    studio.modelLoaded = remote ? false : studio.keepModelLoaded;
    syncRuntimeSummary(result);
    studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.lastModelMeta;
    syncModifiedState();
    studio.refineRestore = null;
    studio.root.querySelector("[data-refine-restore]").hidden = true;
    if (result.thinking_fallback) {
      showToast("Prompt completed", "Thinking reached its budget — the final prompt was completed in standard mode.");
    } else if (result.format_repair_applied) {
      showToast("Prompt generated", `The first draft failed ${result.format_repair_reason}; ${result.format_repair_method} corrected it without re-uploading media.`);
    } else if (result.format_repair_failure) {
      showToast("Prompt generated with a format warning", `The first draft failed ${result.format_repair_reason}; the safe repair was rejected because ${result.format_repair_failure}.`);
    } else {
      const reasoning = result.api_provider ? "Reasoning provider managed" : `Thinking ${result.thinking ? "on" : "off"}`;
      showToast("Prompt generated", `${result.total_seconds.toFixed(1)}s · ${result.tokens_per_second.toFixed(1)} tok/s · ${reasoning}`);
    }
  } catch (error) {
    if (error.code === "GENERATION_CANCELLED") {
      showToast("Generation cancelled", "The active request stopped.");
    } else if (error.code === "INSUFFICIENT_FREE_VRAM") {
      showVramRetry(error, startGenerationPreview);
    } else if (error.code === "CONTEXT_BUDGET_EXCEEDED" && error.details?.suggested_context_profile) {
      const target = error.details.suggested_context_profile;
      const targetLabel = CONTEXT_LABELS[target] || target;
      showToast(
        "More context is needed",
        `This request needs at least ${targetLabel} context. ${CONTEXT_LABELS[studio.contextProfile]} cannot fit the current references.`,
        null,
        { label: `Use ${targetLabel}`, onClick: () => { studio.contextProfile = target; syncRuntimeSummary(); syncThinkingAvailability(); } },
      );
    } else {
      showToast(error.code || "Generation failed", error.message, error.details);
    }
  } finally {
    clearInterval(studio.statusTimer);
    studio.statusTimer = null;
    try {
      const status = await getStatus();
      studio.modelLoaded = ["external", "api"].includes(studio.selectedModel?.family) ? false : Boolean(status.loaded);
    } catch {}
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
  studio.root.querySelector("[data-active-model-icon]").textContent = model?.family === "external" ? "S" : model?.family === "ollama" ? "O" : model?.family === "api" ? "A" : "G";
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
      const result = await diagnoseGGUFRuntime();
      studio.ggufRuntimeDiagnostics = result.diagnostics;
    } catch (error) {
      showToast("Runtime could not be inspected", "The isolated compatibility check was unavailable. Generation will continue with the existing runtime behavior.", error.details || error.message);
      return true;
    }
    renderInferenceSettings();
    syncSelectedModelSourceLabel();
  }

  const diagnostics = studio.ggufRuntimeDiagnostics;
  const blocking = diagnostics.status === "crashed" || diagnostics.status === "unavailable";
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
        <span class="h3ps-provider-icon">S</span>
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

function renderOllamaProviderControl() {
  const status = studio.ollamaStatus;
  if (!status) {
    return `<header class="h3ps-settings-section-heading"><span><small>Local service</small><strong>Ollama</strong></span></header>
      ${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state"><span class="h3ps-spinner"></span><strong>Checking Ollama…</strong><p>Looking for the local service and installed models.</p></div>`;
  }
  const refresh = `<button type="button" data-ollama-refresh>${icon("refresh", 13)} Check again</button>`;
  const header = `<header class="h3ps-settings-section-heading"><span><small>Local service</small><strong>Ollama</strong></span>${refresh}</header>`;
  if (status.state === "not_installed") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">1</span><strong>Get Ollama</strong>
      <p>Install the official Ollama app, open it once, then return here.</p>
      <a class="h3ps-ollama-primary" href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">Open official download ↗</a>
    </div>`;
  }
  if (status.state === "not_running") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">1</span><strong>Start Ollama</strong>
      <p>Ollama is installed, but its local service is not responding. Open the Ollama app, then check again.</p>
      <button class="h3ps-ollama-primary" type="button" data-ollama-refresh>Check connection</button>
    </div>`;
  }
  if (status.state === "error") {
    return `${header}${ollamaJourneyMarkup("service")}<div class="h3ps-ollama-state is-error">
      <span class="h3ps-ollama-state-icon">!</span><strong>Ollama could not be inspected</strong>
      <p>${escapeHtml(status.error?.message || "The service returned an unexpected response.")}</p>
      <button class="h3ps-ollama-primary" type="button" data-ollama-refresh>Try again</button>
    </div>`;
  }
  const models = ollamaModels();
  if (!models.length) {
    const suggested = status.recommended_model;
    const command = suggested ? `ollama pull ${suggested}` : null;
    return `${header}${ollamaJourneyMarkup("model")}<div class="h3ps-ollama-state">
      <span class="h3ps-ollama-state-icon">2</span><strong>Add a compatible prompt model</strong>
      <p>Ollama is running, but no locally installed model reports both vision and text generation support.</p>
      ${command ? `<div class="h3ps-ollama-command"><code>${escapeHtml(command)}</code><button type="button" data-copy-ollama-command="${escapeHtml(command)}">Copy</button></div><small>Run this command in Terminal or PowerShell, then check again.</small>` : `<small>Install a vision-capable model in Ollama, then check again. Tested tags will appear here only after validation.</small>`}
    </div>`;
  }
  const selected = ollamaModelForSettings();
  const tested = selected?.tested_for_h3 === true;
  return `${header}${ollamaJourneyMarkup("ready")}<div class="h3ps-ollama-ready">
    <div class="h3ps-ollama-ready-heading"><span class="h3ps-provider-icon">O</span><span><strong>Ollama is ready</strong><small>Version ${escapeHtml(status.version || "unknown")} · local service</small></span><em>Running</em></div>
    <label class="h3ps-ollama-model-select"><span>Prompt model</span><select data-ollama-model>${models.map((model) => `<option value="${escapeHtml(model.remote_model)}" ${model.remote_model === selected?.remote_model ? "selected" : ""}>${escapeHtml(model.name)}${model.parameter_size ? ` · ${escapeHtml(model.parameter_size)}` : ""}${model.quantization_level ? ` · ${escapeHtml(model.quantization_level)}` : ""}</option>`).join("")}</select></label>
    <div class="h3ps-ollama-badges"><span>Vision</span><span>${selected?.thinking_detected ? "Thinking detected" : "Standard generation"}</span><span class="${tested ? "is-tested" : ""}">${tested ? "Tested for H3" : "Compatible · not yet H3-tested"}</span></div>
    <p>${tested ? "This exact Ollama tag passed the focused H3 Generate and Refine smoke test." : "Compatibility comes from Ollama model metadata. It is not a quality guarantee for H3 prompts."}</p>
    <small>Use “Keep model loaded” on the Generate page to control whether Ollama retains this model after each request.</small>
  </div>`;
}

const API_PROVIDER_UI = {
  gemini: { name: "Gemini", icon: "G", note: "Google API", env: "GEMINI_API_KEY", keyUrl: "https://aistudio.google.com/api-keys" },
  openai: { name: "OpenAI", icon: "O", note: "OpenAI API", env: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { name: "OpenRouter", icon: "R", note: "Multi-provider gateway", env: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/settings/keys" },
  custom: { name: "Custom", icon: "C", note: "Generic OpenAI-compatible", env: "OPENAI_API_KEY", keyUrl: null },
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
      <span class="h3ps-provider-icon">${provider.icon}</span><span><strong>${provider.name}</strong><small>${provider.note}</small></span>${icon("check", 13)}
    </button>`).join("");
  const header = `<header class="h3ps-settings-section-heading"><span><small>OpenAI-compatible</small><strong>API providers</strong></span></header>`;
  const disclosure = `<div class="h3ps-api-disclosure"><strong>What leaves this computer</strong><p>The provider receives your brief, H3 instructions, enabled prepared images and one derived contact sheet per enabled video. Original videos and audio bytes are not uploaded.</p>${config.preset === "openrouter" ? "<small>OpenRouter forwards the request to an upstream model provider with its own data policy.</small>" : ""}</div>`;
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
          <span class="h3ps-provider-icon">${selectedPreset.icon}</span>
          <span><strong>${escapeHtml(connection.provider_name)}</strong><small>${escapeHtml(connection.base_url)} · ${escapeHtml(connection.key_hint || connection.environment_name || "no key")}${connection.compatibility_profile === "lm_studio" ? " · LM Studio detected" : ""}</small></span>
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
  const environment = config.environment_name || selectedPreset.env;
  return `${header}<div class="h3ps-api-layout">
    <div class="h3ps-api-preset-list">${providerChoices}</div>
    <form class="h3ps-api-setup" data-api-provider-form>
      <div class="h3ps-api-intro"><strong>Connect ${selectedPreset.name}</strong><p>One shared Chat Completions backend. Provider-specific fields are applied by the selected preset.</p></div>
      ${config.preset === "custom" ? `<label><span>API base URL</span><input name="base_url" type="url" value="${escapeHtml(config.base_url)}" placeholder="https://host.example/v1 or http://localhost:8000/v1" required><small>Remote endpoints require HTTPS; loopback HTTP is allowed for local vLLM or LM Studio.</small></label>` : ""}
      <label><span>Credential source</span><select name="credential_source"><option value="session" ${config.credential_source === "session" ? "selected" : ""}>Session only</option><option value="environment" ${config.credential_source === "environment" ? "selected" : ""}>Environment variable</option></select></label>
      ${config.credential_source === "environment"
        ? `<label><span>Environment variable</span><input name="environment_name" type="text" value="${escapeHtml(environment)}" pattern="[A-Z_][A-Z0-9_]*" required><small>The secret stays in the ComfyUI process environment.</small></label>`
        : `<label><span>API key ${config.preset === "custom" ? "<em>optional</em>" : ""}</span><input name="api_key" type="password" value="" placeholder="Paste key for this session" autocomplete="off" spellcheck="false" ${config.preset === "custom" ? "" : "required"}><small>The key is sent once to the local H3 backend, kept only in memory, and never saved in localStorage.</small></label>`}
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
  const serverManaged = provider === "external";
  const ollamaManaged = provider === "ollama";
  const apiManaged = provider === "api";
  runtimeSettings.classList.toggle("is-server-managed", serverManaged || ollamaManaged || apiManaged);
  runtimeSettings.querySelector('[data-runtime-toggle="context"]').disabled = serverManaged || apiManaged;
  runtimeSettings.querySelector('[data-runtime-toggle="kv"]').disabled = serverManaged || ollamaManaged || apiManaged;
  runtimeSettings.querySelector("[data-runtime-management]").textContent = serverManaged
    ? studio.externalModel
      ? "Context, KV cache and model loading are managed by the external llama.cpp server."
      : "Connect the external llama.cpp server to inspect its managed context."
    : ollamaManaged
      ? "Context is sent explicitly with each request. KV cache is managed by Ollama."
      : apiManaged
        ? "Context, KV cache and model lifecycle are managed by the selected API provider."
      : "Direct GGUF runtime settings are applied to the next request.";
}

function renderInferenceSettings() {
  const models = localModels();
  const directModel = directModelForSettings();
  const select = studio.root.querySelector("[data-installed-model]");
  select.disabled = !models.length;
  select.innerHTML = models.length
    ? models.map((model) => {
      const suffix = [modelVramLabel(model), model.format, model.runtime_ready ? "" : "Needs setup"].filter(Boolean).join(" · ");
      return `<option value="${escapeHtml(model.id)}" ${model.id === directModel?.id ? "selected" : ""}>${escapeHtml(model.name.split("/").pop())}${suffix ? ` — ${escapeHtml(suffix)}` : ""}</option>`;
    }).join("")
    : "<option>No compatible model found</option>";
  const directStatus = studio.root.querySelector("[data-direct-model-status]");
  if (!models.length) {
    directStatus.innerHTML = renderModelSetup();
  } else if (directModel && !directModel.runtime_ready) {
    directStatus.innerHTML = `<div class="h3ps-direct-model-warning"><strong>Model needs attention</strong><span>${escapeHtml(directModel.setup_message || `Missing ${directModel.missing_dependencies?.join(", ") || "required files"}`)}</span></div>`;
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

function selectSettingsProvider(provider) {
  setOtherModelsPopover(false);
  studio.settingsProvider = ["direct", "external", "ollama", "api"].includes(provider) ? provider : "direct";
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
}

function selectModel(model) {
  selectModelState(studio, model);
  const remote = ["external", "api"].includes(model?.family);
  if (model?.family === "ollama") {
    studio.kvCache = "auto";
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
  const settingsSummary = studio.settingsProvider === "external"
    ? studio.externalModel?.server_context_tokens
      ? `Server · ${Math.round(studio.externalModel.server_context_tokens / 1024)}K`
      : "Connect server"
    : studio.settingsProvider === "ollama"
      ? studio.contextProfile === "auto" ? "Ollama · Auto" : `Ollama · ${CONTEXT_LABELS[studio.contextProfile]}`
    : studio.settingsProvider === "api"
      ? studio.apiProviderConnection ? "API · Connected" : "API · Setup"
    : studio.contextProfile === "auto"
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
  if (!open) studio.settingsProvider = studio.selectedModel?.family === "external" ? "external" : studio.selectedModel?.family === "ollama" ? "ollama" : studio.selectedModel?.family === "api" ? "api" : "direct";
  studio.root.querySelector("[data-settings-view]").hidden = !open;
  studio.root.querySelectorAll("[data-generate-view]").forEach((element) => { element.hidden = open; });
  studio.root.querySelector("[data-open-settings-header]").hidden = open;
  studio.root.classList.toggle("is-settings-open", open);
  if (open) {
    studio.settingsProvider = studio.selectedModel?.family === "external" ? "external" : studio.selectedModel?.family === "ollama" ? "ollama" : studio.selectedModel?.family === "api" ? "api" : "direct";
    renderInferenceSettings();
    syncRuntimeSummary();
    syncSystemPromptEditors();
    setSystemPromptProfile(studio.settingsPromptProfile);
  }
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
  showToast("External server disconnected", "The llama.cpp process was left running and unchanged.");
}

async function connectConfiguredApiProvider(form) {
  const submit = form.querySelector('[type="submit"]');
  const source = form.elements.credential_source.value;
  const contextValue = Number(form.elements.custom_context_tokens?.value || 0);
  const config = {
    preset: studio.apiProviderConfig.preset,
    base_url: form.elements.base_url?.value.trim() || "",
    model_id: form.elements.model_id.value.trim(),
    credential_source: source,
    environment_name: form.elements.environment_name?.value.trim() || "",
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
        source,
        value: form.elements.api_key?.value || "",
        environment_name: config.environment_name,
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
    environment_name: API_PROVIDER_UI[preset].env,
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
    studio.modelLoaded = Boolean(status.loaded);
    selectModel(
      studio.models.find((model) => model.id === selectedId)
      || (selectedBeforeRefresh?.family === "ollama" ? selectedBeforeRefresh : null)
      || (selectedBeforeRefresh?.family === "api" ? selectedBeforeRefresh : null)
      || studio.models.find((model) => model.runtime_ready)
      || studio.models[0]
      || null,
    );
    setGenerationState("idle", "", "");
  } catch (error) {
    showToast(error.code || "Model scan failed", error.message, error.details);
  }
}

async function refreshOllama() {
  const control = studio.root.querySelector("[data-ollama-provider-control]");
  if (control) control.innerHTML = renderOllamaProviderControl();
  try {
    const status = await getOllamaStatus();
    studio.ollamaStatus = status;
    studio.ollamaError = status.error || null;
    studio.models = [...studio.models.filter((model) => model.family !== "ollama"), ...(status.compatible_models || [])];
    const model = ollamaModelForSettings();
    if (model && studio.settingsProvider === "ollama") selectModel(model);
    else renderInferenceSettings();
  } catch (error) {
    studio.ollamaStatus = { state: "error", running: false, compatible_models: [], error: { code: error.code, message: error.message } };
    studio.ollamaError = error;
    renderInferenceSettings();
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
  submit.disabled = true;
  submit.innerHTML = `<span class="h3ps-spinner"></span>Rewriting…`;
  setGenerationState("busy", "Refining prompt", studio.selectedModel.name.split("/").pop());
  try {
    const result = await refine(buildRefinePayload(studio, {
      currentPrompt: previousPrompt,
      instruction,
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
    studio.modelLoaded = ["external", "api"].includes(studio.selectedModel.family) ? false : studio.keepModelLoaded;
    syncRuntimeSummary(result);
    studio.root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.lastModelMeta;
    syncModifiedState();
    showToast(
      result.thinking_fallback ? "Rewrite completed" : "Prompt rewritten",
      result.thinking_fallback
        ? "Thinking reached its budget — the rewrite was completed in standard mode."
        : result.format_repair_applied
          ? `The first draft failed ${result.format_repair_reason}; its format was repaired once without media.`
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
      studio.modelLoaded = ["external", "api"].includes(studio.selectedModel?.family) ? false : Boolean(status.loaded);
    } catch {}
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
        <nav class="h3ps-modes" aria-label="Generation mode">
          ${Object.keys(MODES).map((mode) => `<button type="button" role="tab" data-mode="${mode}">${mode}</button>`).join("")}
        </nav>
        <div class="h3ps-output-toolbar">
          <span>Generated prompt</span>
          <div class="h3ps-output-badges"><span data-modified-badge hidden>Modified</span><button type="button" data-undo-edits hidden>Undo</button></div>
        </div>
      </div>

      <div class="h3ps-workspace" data-generate-view>
        <section class="h3ps-input-panel">
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
            <textarea spellcheck="true">Use identity and wardrobe from &lt;Picture 1&gt; and the slow lateral camera movement from &lt;Video 1&gt;. A solitary character waits at a rain-soaked tram stop at blue hour, notices an approaching light and turns into the wind. End on a quiet, unresolved look; keep the shot cinematic, realistic and restrained.</textarea>
            <small class="h3ps-char-count">0 / 2,000</small>
          </label>

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
              <span><strong>Refine prompt</strong><small>Describe only what should change</small></span>
              <em>No media re-upload</em>
            </div>
            <textarea rows="2" placeholder="For example: make the camera movement slower and keep the ending more ambiguous."></textarea>
            <div class="h3ps-refine-actions">
              <button type="button" class="h3ps-text-button" data-refine-restore hidden>Restore original</button>
              <span></span>
              <button type="button" class="h3ps-text-button" data-refine-cancel>Cancel</button>
              <button type="button" class="h3ps-refine-submit" data-refine-submit>${icon("spark", 13)} Rewrite</button>
            </div>
          </div>
          <div class="h3ps-output-actions">
            <button class="h3ps-secondary-button" type="button" title="Refine with local LLM" data-refine-toggle>${icon("spark", 15)} Refine</button>
            <button class="h3ps-secondary-button" type="button" data-copy>${icon("copy", 15)} Copy prompt</button>
          </div>
        </section>
      </div>

      <footer class="h3ps-footer" data-generate-view>
        <button class="h3ps-memory-action" type="button" data-memory-action title="Unload models held by ComfyUI without clearing cached workflow results">${icon("memory", 15)}Free ComfyUI VRAM</button>
        <div class="h3ps-status is-busy" data-status hidden><span><strong></strong><small data-status-detail></small></span></div>
        <div class="h3ps-footer-actions">
          <span class="h3ps-generation-options">
            <label class="h3ps-toggle-control"><input type="checkbox" data-thinking><span></span>Thinking</label>
            <label class="h3ps-toggle-control" data-keep-loaded-control title="Keep the prompt model in VRAM for the next prompt"><input type="checkbox" data-keep-loaded><span></span>Keep model loaded</label>
          </span>
          <button class="h3ps-primary-button" type="button" data-generate>${icon("spark", 16)}Generate prompt</button>
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
  root.querySelectorAll("[data-close-studio]").forEach((el) => el.addEventListener("click", closeStudio));
  root.addEventListener("click", (event) => {
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
  });
  root.querySelectorAll("[data-close-preview]").forEach((el) => el.addEventListener("click", closeVideoPreview));
  root.querySelectorAll("[data-close-image-preview]").forEach((el) => el.addEventListener("click", closeImagePreview));
  root.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    studio.mode = button.dataset.mode;
    renderMedia(studio.mode);
    syncRuntimeSummary();
  }));
  root.querySelector("[data-open-settings-header]").addEventListener("click", () => setSettingsOpen(true));
  root.querySelector("[data-open-settings]").addEventListener("click", () => setSettingsOpen(true));
  root.querySelector("[data-close-settings]").addEventListener("click", () => setSettingsOpen(false));
  root.querySelector("[data-clear-media]").addEventListener("click", async () => {
    try {
      await clearMedia(studio.sessionId);
      studio.assets = [];
      closeVideoPreview();
      renderMedia(studio.mode);
      showToast("Media cleared", "The temporary session files were removed.");
    } catch (error) {
      showToast(error.code || "Clear failed", error.message, error.details);
    }
  });
  root.querySelector("[data-generate]").addEventListener("click", startGenerationPreview);
  root.querySelector("[data-memory-action]").addEventListener("click", runMemoryAction);
  root.querySelector("[data-guide-toggle]").addEventListener("click", async () => {
    const menu = root.querySelector("[data-guide-menu]");
    menu.hidden = !menu.hidden;
    if (menu.hidden || studio.guides.length) return;
    try {
      const result = await getGuides();
      studio.guides = result.guides;
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
  }));
  syncRuntimeSummary();
  root.querySelectorAll("[data-system-prompt-profile]").forEach((button) => button.addEventListener("click", () => {
    setSystemPromptProfile(button.dataset.systemPromptProfile);
  }));
  root.querySelectorAll("[data-system-prompt]").forEach((textarea) => textarea.addEventListener("input", () => {
    const profile = textarea.dataset.systemPrompt;
    const defaultPrompt = studio.systemPromptDefaults[profile] || "";
    if (textarea.value === defaultPrompt) delete studio.customSystemPrompts[profile];
    else studio.customSystemPrompts[profile] = textarea.value;
    saveCustomSystemPrompts(localStorage, studio.customSystemPrompts);
    const custom = Object.hasOwn(studio.customSystemPrompts, profile);
    root.querySelector(`[data-system-prompt-status="${profile}"]`).textContent = custom ? "Custom" : "Default";
    root.querySelector(`[data-system-prompt-reset="${profile}"]`).hidden = !custom;
    root.querySelector(`[data-system-prompt-count="${profile}"]`).textContent = `${textarea.value.length.toLocaleString()} / 8,000`;
    resizeSystemPromptEditor(textarea);
  }));
  root.querySelectorAll("[data-system-prompt-reset]").forEach((button) => button.addEventListener("click", () => {
    const profile = button.dataset.systemPromptReset;
    delete studio.customSystemPrompts[profile];
    saveCustomSystemPrompts(localStorage, studio.customSystemPrompts);
    syncSystemPromptEditor(profile);
    showToast("System Prompt reset", `H3 Prompt Writer is using its default ${profile} instructions.`);
  }));
  root.querySelector("[data-thinking]").addEventListener("change", (event) => {
    studio.thinking = event.target.checked;
  });
  root.querySelector("[data-keep-loaded]").addEventListener("change", (event) => {
    studio.keepModelLoaded = event.target.checked;
  });
  const brief = root.querySelector(".h3ps-brief textarea");
  const briefCount = root.querySelector(".h3ps-char-count");
  const updateBriefCount = () => {
    const compactHeight = window.innerHeight <= 800;
    const largeCanvas = window.innerWidth >= 3000 && window.innerHeight >= 1600;
    const minimumHeight = compactHeight ? 80 : largeCanvas ? 125 : 105;
    const maximumHeight = compactHeight ? 130 : largeCanvas ? 230 : 190;
    briefCount.textContent = `${brief.value.length.toLocaleString()} / 2,000`;
    brief.style.height = "auto";
    brief.style.height = `${Math.min(maximumHeight, Math.max(minimumHeight, brief.scrollHeight))}px`;
    brief.style.overflowY = brief.scrollHeight > maximumHeight ? "auto" : "hidden";
  };
  brief.addEventListener("input", updateBriefCount);
  updateBriefCount();
  root.querySelectorAll("[data-aspect]").forEach((button) => button.addEventListener("click", () => {
    studio.aspectRatio = button.dataset.aspect;
    const option = ASPECT_RATIOS.find(([value]) => value === studio.aspectRatio);
    root.querySelector("[data-aspect-label]").textContent = option[0];
    root.querySelector("[data-aspect-description]").textContent = option[1];
    root.querySelector('[data-choice-menu="aspect"]').hidden = true;
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
    const credentialSource = event.target.closest('[data-api-provider-form] [name="credential_source"]');
    if (credentialSource) {
      studio.apiProviderConfig.credential_source = credentialSource.value;
      if (credentialSource.value === "environment" && !studio.apiProviderConfig.environment_name) {
        studio.apiProviderConfig.environment_name = API_PROVIDER_UI[studio.apiProviderConfig.preset].env;
      }
      saveApiProviderConfig(localStorage, studio.apiProviderConfig);
      renderInferenceSettings();
      return;
    }
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
    showToast("Previous prompt restored", "The AI rewrite was discarded.");
  });
  root.querySelector("[data-undo-edits]").addEventListener("click", () => {
    if (typeof studio.lastModelPrompt !== "string") return;
    const output = root.querySelector("[data-output]");
    output.value = studio.lastModelPrompt;
    root.querySelector(".h3ps-editor-meta span:last-child").textContent = studio.lastModelMeta;
    renderPromptHighlights();
    syncModifiedState();
    showToast("Edits undone", "Restored the latest AI-generated prompt.");
  });
  root.querySelector("[data-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(root.querySelector("[data-output]").value);
      showToast("Prompt copied", "The generated H3 prompt is on your clipboard.");
    } catch (error) {
      showToast("Copy failed", "Clipboard access was denied.", error.message);
    }
  });
  root.querySelector("[data-output]").addEventListener("input", () => {
    syncModifiedState();
    renderPromptHighlights();
    syncOutputLengthMeta();
  });
  root.querySelector("[data-output]").addEventListener("scroll", renderPromptHighlights);
  const editor = root.querySelector("[data-output]");
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
