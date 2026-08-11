import { app } from "/scripts/app.js";
import { cancel, clearMedia, diagnoseGGUFRuntime, freeComfyVram, generate, getGuides, getModels, getStatus, getSystemPrompt, probeExternalServer, refine, removeMedia, reorderMedia, resampleMedia, setMediaAnalysis, unloadModel, uploadMedia } from "./api/h3studio.js";
import { createSessionId, moveOntoTarget, replaceEventListener } from "./compat.js";
import { generateModelSummaryMarkup, settingsMarkup } from "./settings.js";
import {
  buildGeneratePayload,
  buildRefinePayload,
  createStudioState,
  saveCustomSystemPrompts,
  saveExternalServerConfig,
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
  const timing = result.external_server
    ? `${result.total_seconds.toFixed(1)}s total (${media}s media · ${llm}s server)`
    : `${result.total_seconds.toFixed(1)}s total (${load}s load · ${media}s media · ${llm}s LLM)`;
  return `${promptLengthMeta(result.prompt)} · ${timing} · ${result.tokens_per_second.toFixed(1)} tok/s${peakVram}${memory}${fallback}`;
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
  if (!textarea || !textarea.offsetParent) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(108, textarea.scrollHeight + 2)}px`;
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
  if (document.querySelector("link[data-h3ps-styles]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./styles.css", import.meta.url).href;
  link.dataset.h3psStyles = "true";
  document.head.appendChild(link);
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
  const external = studio.selectedModel?.family === "external";
  button.classList.toggle("is-cancel", busy);
  button.innerHTML = busy ? `<span class="h3ps-spinner"></span>Cancel` : `${icon("spark", 16)}Generate prompt`;
  lifecycle.hidden = !busy && !studio.modelLoaded;
  lifecycle.classList.toggle("is-busy", busy);
  if (busy) {
    studio.lifecycleDotCount = ((studio.lifecycleDotCount || 0) % 3) + 1;
    lifecycleLabel.textContent = `${external ? "External request active" : "Prompt model active"}${".".repeat(studio.lifecycleDotCount)}`;
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
    const external = studio.selectedModel?.family === "external";
    button.innerHTML = `${icon("memory", 15)}${external ? "Stop request" : "Stop & unload"}`;
    button.title = external ? "Cancel the request without stopping or unloading the external server" : "Stop the current prompt generation and unload its local model";
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
  const external = studio.selectedModel?.family === "external";
  if (busy) setGenerationState("busy", external ? "Stopping request" : "Stopping & unloading", external ? "The external server will remain running" : "Cancelling the request and unloading its model");
  button.disabled = true;
  try {
    await unloadModel();
    studio.modelLoaded = false;
    showToast(
      busy ? (external ? "Stop requested" : "Stop & unload requested") : "Prompt model unloaded",
      busy ? (external ? "The request will stop. The external llama.cpp server remains running." : "The request will stop and release its model at the next safe point.") : "GPU memory used by the local prompt model was released.",
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
    showToast("No prompt model selected", "Choose a local GGUF model or connect an existing llama.cpp server.");
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
  const generationDetail = external ? `${modelName} · the server may load its model if idle` : modelName;
  setGenerationState("busy", external ? "Contacting server" : "Loading model", generationDetail);
  studio.statusTimer = setInterval(async () => {
    try {
      const status = await getStatus();
      const labels = { loading_model: external ? "Contacting server" : "Loading model", processing_media: "Processing references", generating: "Generating", cancelling: "Cancelling" };
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
    studio.modelLoaded = studio.selectedModel.family === "external" ? false : studio.keepModelLoaded;
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
      showToast("Prompt generated", `${result.total_seconds.toFixed(1)}s · ${result.tokens_per_second.toFixed(1)} tok/s · Thinking ${result.thinking ? "on" : "off"}`);
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
      studio.modelLoaded = studio.selectedModel?.family === "external" ? false : Boolean(status.loaded);
    } catch {}
    setGenerationState("idle", "", "");
  }
}

function modelVramLabel(model) {
  if (model?.family === "external") return "";
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
    <div class="h3ps-model-setup">
      <strong>No compatible local model found</strong>
      <p>Open the two verified Hugging Face pages, download both files, then place them in:</p>
      <button type="button" class="h3ps-model-path" data-copy-model-path><code>${escapeHtml(directory)}</code>${icon("copy", 13)}</button>
      <p>Using multiple models? Keep each model and its matching vision projector together in a separate subfolder.</p>
      ${renderModelScanDetails()}
      <div class="h3ps-model-setup-list">${renderModelSetupRows()}</div>
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
  const source = studio.selectedModel?.family === "external" ? "External server" : studio.selectedModel ? localRuntimeLabel() : "No prompt model";
  studio.root.querySelector("[data-model-source-label]").textContent = source;
  studio.root.querySelector("[data-active-model-source]").textContent = source;
}

function syncActiveModelSummary(runtimeSummary = null) {
  if (!studio) return;
  const model = studio.selectedModel;
  studio.root.querySelector("[data-active-model-icon]").textContent = model?.family === "external" ? "S" : "G";
  studio.root.querySelector("[data-active-model-name]").textContent = model ? model.name.split("/").pop() : "No compatible prompt model";
  studio.root.querySelector("[data-active-model-source]").textContent = model?.family === "external" ? "External server" : model ? localRuntimeLabel() : "Open Settings to configure";
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
    renderModelMenu();
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
      <span><strong>Browse other models</strong><small>Verified model and projector pairs</small></span>${icon("chevron", 14)}
    </button>`;
}

function renderExternalServerControl() {
  const connected = studio.externalModel;
  const config = studio.externalServerConfig || { url: "http://127.0.0.1:8080", model: "" };
  const title = connected ? connected.name.split("/").pop() : "External llama.cpp server";
  const selected = connected && connected.id === studio.selectedModel?.id;
  const state = connected
    ? `External llama.cpp · ${connected.endpoint}`
    : studio.externalServerError
      ? "Saved server is offline"
      : "Use a model already running in llama.cpp";
  return `
    <div class="h3ps-external-server ${connected ? "is-connected" : ""} ${selected ? "is-selected" : ""}">
      <div class="h3ps-external-server-row">
        <button type="button" class="h3ps-external-server-select" data-external-server-select>
          <span class="h3ps-model-option-icon">S</span>
          <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(state)}</small></span>
          ${connected ? "<em>API</em>" : ""}
          ${icon("check", 15)}
        </button>
        <button type="button" class="h3ps-external-server-toggle" data-external-server-toggle aria-label="${connected ? "Server settings" : "Connect external server"}" aria-expanded="false">
          ${icon("chevron", 14)}
        </button>
      </div>
      <form data-external-server-form hidden>
        <label><span>Server URL</span><input name="url" type="url" value="${escapeHtml(config.url)}" placeholder="http://127.0.0.1:8080" required></label>
        <label><span>Model ID <em>optional</em></span><input name="model" type="text" value="${escapeHtml(config.model)}" placeholder="Use the first loaded model"></label>
        <small>Localhost only. Context, KV cache and model loading stay under server control.</small>
        <div><button type="button" data-external-server-disconnect ${connected || studio.externalServerConfig ? "" : "hidden"}>Disconnect</button><span></span><button type="submit">Connect</button></div>
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
  const picker = studio?.root.querySelector("[data-model-picker]");
  if (!popover || popover.hidden || !trigger || !picker) return;
  const margin = 12;
  const gap = 8;
  const pickerRect = picker.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const width = Math.min(pickerRect.width, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;
  const maxHeight = Math.min(window.innerHeight * 0.62, 520, window.innerHeight - margin * 2);
  const height = Math.min(popover.scrollHeight, maxHeight);
  let left = pickerRect.right + gap;
  if (left + width > window.innerWidth - margin) left = pickerRect.left - width - gap;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  const top = Math.max(margin, Math.min(triggerRect.top, window.innerHeight - height - margin));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function renderModelMenu() {
  const options = studio.root.querySelector(".h3ps-model-options");
  if (!studio.models.length) {
    setOtherModelsPopover(false);
    options.innerHTML = `${renderExternalServerControl()}${renderModelSetup()}`;
    return;
  }
  const modelOptions = studio.models.filter((model) => model.family !== "external").map((model) => `
    <button class="h3ps-model-option ${model.id === studio.selectedModel?.id ? "is-selected" : ""} ${model.runtime_ready ? "" : "is-incomplete"}" type="button" data-model-id="${escapeHtml(model.id)}">
      <span class="h3ps-model-option-icon">${model.family === "external" ? "S" : "G"}</span>
      <span><strong>${escapeHtml(model.name.split("/").pop())}</strong><small>${model.family === "external" ? escapeHtml(model.source_label) : model.runtime_ready ? escapeHtml(localRuntimeLabel()) : escapeHtml(model.setup_message || `Missing ${model.missing_dependencies.join(", ")}`)}</small></span>
      <span class="h3ps-model-tags">${modelVramLabel(model) ? `<em>${modelVramLabel(model)}</em>` : ""}${model.format ? `<em>${escapeHtml(model.format)}</em>` : ""}</span>
      ${icon("check", 15)}
    </button>`).join("");
  const readyLocal = studio.models.some((model) => model.family !== "external" && model.runtime_ready);
  options.innerHTML = `${modelOptions}${renderExternalServerControl()}${readyLocal || studio.externalModel ? `${renderModelScanDetails()}${renderOtherModelsTrigger()}` : renderModelSetup()}`;
  const catalog = studio.root.querySelector("[data-other-models-catalog]");
  catalog.innerHTML = `<div class="h3ps-model-setup-list">${renderModelSetupRows()}</div>`;
}

function selectModel(model) {
  selectModelState(studio, model);
  const external = model?.family === "external";
  const name = model ? model.name.split("/").pop() : "No compatible local model";
  const label = studio.root.querySelector("[data-selected-model]");
  label.innerHTML = `${escapeHtml(name)}${model?.format ? ` <em>${escapeHtml(model.format)}</em>` : ""}`;
  syncSelectedModelSourceLabel();
  studio.root.querySelector(".h3ps-model-icon").textContent = external ? "S" : "G";
  const keepLoaded = studio.root.querySelector("[data-keep-loaded]");
  const keepLoadedControl = studio.root.querySelector("[data-keep-loaded-control]");
  keepLoadedControl.hidden = external;
  keepLoaded.checked = studio.keepModelLoaded;
  const runtimeSettings = studio.root.querySelector(".h3ps-runtime-settings");
  runtimeSettings.classList.toggle("is-server-managed", external);
  runtimeSettings.querySelectorAll("[data-runtime-toggle]").forEach((button) => { button.disabled = external; });
  runtimeSettings.querySelector("[data-runtime-management]").textContent = external
    ? "Context, KV cache and model loading are managed by the external llama.cpp server."
    : "Direct GGUF runtime settings are applied to the next request.";
  for (const capability of ["images", "video_frames", "audio"]) {
    const value = model?.capabilities?.[capability] === true;
    const target = studio.root.querySelector(`[data-model-capability="${capability}"]`);
    target.textContent = capability === "audio" ? "Not analyzed" : value ? "Yes" : "No";
    target.classList.toggle("is-off", capability !== "audio" && !value);
  }
  renderModelMenu();
  renderMedia(studio.mode);
  const picker = studio.root.querySelector("[data-model-picker]");
  const menu = studio.root.querySelector("[data-model-menu]");
  menu.hidden = true;
  picker.classList.remove("is-open");
  setOtherModelsPopover(false);
  syncRuntimeSummary();
  syncThinkingAvailability();
}

function syncThinkingAvailability() {
  if (!studio) return;
  const external = studio.selectedModel?.family === "external";
  const context = studio.contextProfile;
  const resolved = context === "auto" ? (studio.selectedModel?.recommended_context || "standard") : context;
  const input = studio.root.querySelector("[data-thinking]");
  const label = input.closest("label");
  const disabled = !external && context !== "auto" && resolved === "low";
  if (disabled) input.checked = false;
  if (disabled) studio.thinking = false;
  input.checked = studio.thinking;
  input.disabled = disabled;
  label.classList.toggle("is-disabled", disabled);
  label.title = disabled ? "Thinking needs Standard 16K or Extended 24K context." : "";
}

const CONTEXT_LABELS = { auto: "Auto", low: "8K", standard: "16K", extended: "24K" };
const KV_LABELS = { auto: "Auto", q8: "Q8", f16: "F16" };

function syncRuntimeSummary(result = null) {
  if (!studio) return;
  studio.root.querySelector('[data-runtime-label="context"]').textContent = CONTEXT_LABELS[studio.contextProfile];
  studio.root.querySelector('[data-runtime-label="kv"]').textContent = KV_LABELS[studio.kvCache];
  const summary = studio.root.querySelector("[data-runtime-summary]");
  let summaryText;
  if (studio.selectedModel?.family === "external") {
    const tokens = result?.context_tokens || studio.selectedModel.server_context_tokens;
    summaryText = tokens ? `Server · ${Math.round(tokens / 1024)}K` : "Managed by server";
  } else if (result && studio.contextProfile === "auto") {
    summaryText = `Auto → ${Math.round(result.context_tokens / 1024)}K · ${String(result.kv_cache).toUpperCase()}`;
  } else {
    summaryText = studio.contextProfile === "auto" ? "Auto" : `${CONTEXT_LABELS[studio.contextProfile]} · ${KV_LABELS[studio.kvCache]}`;
  }
  summary.textContent = summaryText;
  syncActiveModelSummary(summaryText);
  studio.root.querySelectorAll("[data-runtime-option]").forEach((button) => {
    const selected = button.dataset.runtimeOption === "context" ? studio.contextProfile : studio.kvCache;
    button.classList.toggle("is-selected", button.dataset.value === selected);
  });
}

function setSettingsOpen(open) {
  if (!studio) return;
  setOtherModelsPopover(false);
  studio.root.querySelector("[data-settings-view]").hidden = !open;
  studio.root.querySelectorAll("[data-generate-view]").forEach((element) => { element.hidden = open; });
  studio.root.querySelector("[data-open-settings-header]").hidden = open;
  studio.root.classList.toggle("is-settings-open", open);
  if (open) {
    renderModelMenu();
    syncRuntimeSummary();
    syncSystemPromptEditors();
    requestAnimationFrame(() => {
      studio.root.querySelectorAll("[data-system-prompt]").forEach(resizeSystemPromptEditor);
    });
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
    renderModelMenu();
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
  else renderModelMenu();
  showToast("External server disconnected", "The llama.cpp process was left running and unchanged.");
}

async function refreshModels() {
  try {
    const [result, status] = await Promise.all([getModels(), getStatus()]);
    const selectedId = studio.selectedModel?.id;
    studio.models = result.models;
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
    const developerMode = studio.root.querySelector("[data-developer-mode]");
    developerMode.hidden = !status.developer_mode;
    selectModel(studio.models.find((model) => model.id === selectedId) || studio.models.find((model) => model.runtime_ready) || studio.models[0] || null);
    const needsSetup = !studio.models.some((model) => model.runtime_ready);
    const picker = studio.root.querySelector("[data-model-picker]");
    const menu = studio.root.querySelector("[data-model-menu]");
    picker.classList.toggle("needs-setup", needsSetup);
    picker.classList.toggle("is-open", needsSetup);
    menu.hidden = !needsSetup;
    setGenerationState("idle", "", "");
  } catch (error) {
    showToast(error.code || "Model scan failed", error.message, error.details);
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
    showToast("No prompt model selected", "Choose a local GGUF model or connect an existing llama.cpp server.");
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
    studio.modelLoaded = studio.selectedModel.family === "external" ? false : studio.keepModelLoaded;
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
      studio.modelLoaded = studio.selectedModel?.family === "external" ? false : Boolean(status.loaded);
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
    const modelMenuFocused = root.querySelector("[data-model-menu]").contains(document.activeElement);
    if (!event.target.closest("[data-model-picker], [data-other-models-popover]") && !modelMenuFocused) {
      root.querySelector("[data-model-menu]").hidden = true;
      root.querySelector("[data-model-picker]").classList.remove("is-open");
    }
    if (!event.target.closest("[data-other-models-toggle], [data-other-models-popover]")) setOtherModelsPopover(false);
    if (!event.target.closest(".h3ps-runtime-settings")) {
      root.querySelectorAll("[data-runtime-menu]").forEach((menu) => { menu.hidden = true; });
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
  root.querySelector("[data-model-toggle]").addEventListener("click", () => {
    const picker = root.querySelector("[data-model-picker]");
    const menu = root.querySelector("[data-model-menu]");
    const open = menu.hidden;
    menu.hidden = !open;
    picker.classList.toggle("is-open", open);
    if (!open) setOtherModelsPopover(false);
  });
  root.querySelector("[data-model-refresh]").addEventListener("click", async () => {
    await refreshModels();
    showToast("Models refreshed", `${studio.models.length} supported local model${studio.models.length === 1 ? "" : "s"} found.`);
  });
  root.querySelector(".h3ps-model-options").addEventListener("click", (event) => {
    const externalSelect = event.target.closest("[data-external-server-select]");
    if (externalSelect) {
      if (studio.externalModel) {
        selectModel(studio.externalModel);
      } else {
        const server = externalSelect.closest(".h3ps-external-server");
        const form = server.querySelector("[data-external-server-form]");
        form.hidden = !form.hidden;
        server.classList.toggle("is-open", !form.hidden);
        server.querySelector("[data-external-server-toggle]").setAttribute("aria-expanded", String(!form.hidden));
      }
      return;
    }
    const externalToggle = event.target.closest("[data-external-server-toggle]");
    if (externalToggle) {
      const form = externalToggle.closest(".h3ps-external-server").querySelector("[data-external-server-form]");
      form.hidden = !form.hidden;
      externalToggle.closest(".h3ps-external-server").classList.toggle("is-open", !form.hidden);
      externalToggle.setAttribute("aria-expanded", String(!form.hidden));
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
    const button = event.target.closest("[data-model-id]");
    if (button) {
      selectModel(studio.models.find((model) => model.id === button.dataset.modelId));
      root.querySelector("[data-model-menu]").hidden = true;
      root.querySelector("[data-model-picker]").classList.remove("is-open");
    }
  });
  root.querySelector(".h3ps-model-options").addEventListener("submit", (event) => {
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
