import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web/compat.js", import.meta.url), "utf8");
const encoded = Buffer.from(source).toString("base64");
const { availableReferenceTags, createSessionId, insertReferenceAtCaret, isChoiceMenuInteraction, isGuideMenuInteraction, isRuntimeMenuInteraction, moveOntoTarget, replaceEventListener } = await import(`data:text/javascript;base64,${encoded}`);
const responseSource = await readFile(new URL("../web/api/response.js", import.meta.url), "utf8");
const responseEncoded = Buffer.from(responseSource).toString("base64");
const { readApiResponse } = await import(`data:text/javascript;base64,${responseEncoded}`);
const stateSource = await readFile(new URL("../web/studio_state.js", import.meta.url), "utf8");
const stateEncoded = Buffer.from(stateSource).toString("base64");
const {
  EXTERNAL_SERVER_STORAGE_KEY,
  API_PROVIDER_STORAGE_KEY,
  OLLAMA_MODEL_STORAGE_KEY,
  MODE_DRAFTS_STORAGE_KEY,
  SYSTEM_PROMPT_STORAGE_KEY,
  USER_PREFERENCES_STORAGE_KEY,
  buildGeneratePayload,
  buildLyricsRefinePayload,
  buildRefinePayload,
  audioWasAdded,
  createStudioState,
  currentSystemPromptOverride,
  isGenerationModeAvailable,
  isTextOnlyDirectModel,
  loadCustomSystemPrompts,
  loadApiProviderConfig,
  loadExternalServerConfig,
  loadOllamaModel,
  loadModeDrafts,
  loadUserPreferences,
  saveCustomSystemPrompts,
  saveApiProviderConfig,
  saveExternalServerConfig,
  saveOllamaModel,
  saveModeDrafts,
  saveUserPreferences,
  restoredModelAfterDiscovery,
  selectModelState,
  systemPromptProfile,
  isModeDraftDirty,
  isPersistedDraftMode,
  resetModeDraft,
} = await import(`data:text/javascript;base64,${stateEncoded}`);
const settingsSource = await readFile(new URL("../web/settings.js", import.meta.url), "utf8");
const settingsEncoded = Buffer.from(settingsSource).toString("base64");
const { settingsMarkup } = await import(`data:text/javascript;base64,${settingsEncoded}`);
const mainSource = await readFile(new URL("../web/main.js", import.meta.url), "utf8");
const skinSource = await readFile(new URL("../web/skin.css", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    entries: () => Object.fromEntries(values),
  };
}

test("API responses preserve structured server errors", async () => {
  const response = {
    ok: false,
    status: 400,
    text: async () => JSON.stringify({
      error: { code: "INVALID_REQUEST", message: "Select a model.", details: { field: "model_id" } },
    }),
  };

  await assert.rejects(readApiResponse(response), (error) => {
    assert.equal(error.message, "Select a model.");
    assert.equal(error.code, "INVALID_REQUEST");
    assert.deepEqual(error.details, { field: "model_id" });
    return true;
  });
});

test("API responses replace non-JSON server errors with a readable fallback", async () => {
  const response = {
    ok: false,
    status: 500,
    text: async () => "<html><body>ComfyUI is restarting</body></html>",
  };

  await assert.rejects(
    readApiResponse(response),
    /H3 Prompt Writer request failed \(500\)\. The server returned a non-JSON response\./,
  );
});

test("API responses reject invalid success bodies without exposing parser errors", async () => {
  const response = { ok: true, status: 200, text: async () => "not JSON" };

  await assert.rejects(
    readApiResponse(response),
    /H3 Prompt Writer returned an invalid response \(200\)\. ComfyUI may still be restarting\./,
  );
});

test("createSessionId falls back to a valid UUID v4", () => {
  const fallbackCrypto = {
    getRandomValues(bytes) {
      bytes.set([...Array(bytes.length).keys()]);
      return bytes;
    },
  };

  const value = createSessionId(fallbackCrypto);
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("createSessionId preserves native randomUUID when available", () => {
  const expected = "11111111-2222-4333-8444-555555555555";
  assert.equal(createSessionId({ randomUUID: () => expected }), expected);
});

test("replacing a persistent media listener prevents duplicate dispatch", () => {
  const media = new EventTarget();
  const calls = [];
  replaceEventListener(media, "drop", "media", () => calls.push("old-mode"));
  replaceEventListener(media, "drop", "media", () => calls.push("current-mode"));

  media.dispatchEvent(new Event("drop"));
  assert.deepEqual(calls, ["current-mode"]);
});

test("dropping on another media card moves in either direction without an edge hit", () => {
  const assets = [{ id: "picture" }, { id: "video" }, { id: "audio" }];
  assert.deepEqual(moveOntoTarget(assets, "picture", "video").map((asset) => asset.id), ["video", "picture", "audio"]);
  assert.deepEqual(moveOntoTarget(assets, "audio", "video").map((asset) => asset.id), ["picture", "audio", "video"]);
});

test("the first click outside a runtime control closes its menu", () => {
  const runtimeTarget = { closest: (selector) => selector.includes("data-runtime-menu") ? {} : null };
  const outsideTarget = { closest: () => null };
  assert.equal(isRuntimeMenuInteraction(runtimeTarget), true);
  assert.equal(isRuntimeMenuInteraction(outsideTarget), false);
});

test("the first click outside a choice control closes its menu", () => {
  const choiceTarget = { closest: (selector) => selector.includes("data-choice-menu") ? {} : null };
  const outsideTarget = { closest: () => null };
  assert.equal(isChoiceMenuInteraction(choiceTarget), true);
  assert.equal(isChoiceMenuInteraction(outsideTarget), false);
});

test("the first click outside the guides control closes its menu", () => {
  const guideTarget = { closest: (selector) => selector.includes("data-guide-menu") ? {} : null };
  const outsideTarget = { closest: () => null };
  assert.equal(isGuideMenuInteraction(guideTarget), true);
  assert.equal(isGuideMenuInteraction(outsideTarget), false);
});

test("settings storage preserves the existing keys and schemas", () => {
  const storage = memoryStorage({
    [EXTERNAL_SERVER_STORAGE_KEY]: JSON.stringify({ url: "http://127.0.0.1:8080", model: "gemma.gguf" }),
    [SYSTEM_PROMPT_STORAGE_KEY]: JSON.stringify({ standard: "Standard custom", reference: "Reference custom", music3: "Music custom" }),
    [OLLAMA_MODEL_STORAGE_KEY]: "gemma4:12b",
  });

  assert.deepEqual(loadExternalServerConfig(storage), { url: "http://127.0.0.1:8080", model: "gemma.gguf" });
  assert.deepEqual(loadCustomSystemPrompts(storage), { standard: "Standard custom", reference: "Reference custom", music3: "Music custom" });
  assert.equal(loadOllamaModel(storage), "gemma4:12b");
  saveExternalServerConfig(storage, { url: "http://localhost:8081", model: "other.gguf" });
  saveCustomSystemPrompts(storage, { standard: "Updated" });
  saveOllamaModel(storage, "gemma4:27b");

  assert.deepEqual(storage.entries(), {
    [EXTERNAL_SERVER_STORAGE_KEY]: JSON.stringify({ url: "http://localhost:8081", model: "other.gguf" }),
    [SYSTEM_PROMPT_STORAGE_KEY]: JSON.stringify({ standard: "Updated" }),
    [OLLAMA_MODEL_STORAGE_KEY]: "gemma4:27b",
  });
});

test("API provider storage persists configuration but never secret values", () => {
  const storage = memoryStorage();
  saveApiProviderConfig(storage, {
    preset: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model_id: "provider/model",
    credential_source: "environment",
    environment_name: "SECRET_ENV",
    gemini_reasoning_effort: "minimal",
    custom_images: true,
    custom_context_tokens: 32768,
    api_key: "must-not-be-stored",
  });
  const serialized = storage.entries()[API_PROVIDER_STORAGE_KEY];
  assert.doesNotMatch(serialized, /must-not-be-stored/);
  assert.doesNotMatch(serialized, /SECRET_ENV|credential_source|environment_name/);
  assert.deepEqual(loadApiProviderConfig(storage), {
    preset: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model_id: "provider/model",
    gemini_reasoning_effort: "minimal",
    custom_images: true,
    custom_context_tokens: 32768,
  });
});

test("exceptional generation notices persist until a workspace click", () => {
  assert.match(mainSource, /dismissOnWorkspaceClick = options\.dismissOnWorkspaceClick === true/);
  assert.match(mainSource, /studio\.toastDismissOnWorkspaceClick && !event\.target\.closest\("\[data-h3ps-toast\]"\)/);
  assert.match(mainSource, /format_repair_failure[\s\S]{0,500}dismissOnWorkspaceClick: true/);
});

test("technical errors reuse workspace-click dismissal without closing on the opening click", () => {
  assert.match(mainSource, /details != null && durationMs == null/);
  assert.match(mainSource, /studio\.toastDismissOnWorkspaceClick = false/);
  assert.match(mainSource, /setTimeout\(\(\) => \{[\s\S]{0,300}studio\.toastDismissOnWorkspaceClick = dismissOnWorkspaceClick/);
  assert.match(mainSource, /studio\.toastDismissOnWorkspaceClick && !event\.target\.closest\("\[data-h3ps-toast\]"\)/);
  assert.doesNotMatch(mainSource, /data-toast-dismiss/);
});

test("Thinking fallback suggests more context only when Direct GGUF was context-limited", () => {
  assert.match(mainSource, /result\.thinking_budget_reduced[\s\S]{0,160}studio\.selectedModel\?\.family === "gguf"/);
  assert.match(mainSource, /A larger Context setting can give Thinking more room\./);
  assert.match(mainSource, /Thinking used its full token budget\./);
  assert.doesNotMatch(mainSource, /Thinking reached its budget —/);
});

test("user preferences persist only stable non-secret settings", () => {
  const storage = memoryStorage();
  saveUserPreferences(storage, {
    mode: "Reference",
    durationSeconds: 14,
    aspectRatio: "9:16",
    settingsProvider: "api",
    preferredDirectModelId: "direct-model.gguf",
    directContextProfile: "extended",
    directKvCache: "q8",
    musicLyricsUseBrief: false,
    fullscreen: true,
    selectedModel: { id: "api::secret-connection::model", api_connection_id: "secret-connection" },
    apiProviderConfig: { api_key: "must-not-be-stored" },
    creativeBrief: "must-not-be-stored",
    keepModelLoaded: true,
    thinking: true,
  });

  const serialized = storage.entries()[USER_PREFERENCES_STORAGE_KEY];
  assert.doesNotMatch(serialized, /secret|creativeBrief|keepModelLoaded|thinking|connection/);
  assert.deepEqual(loadUserPreferences(storage), {
    version: 1,
    mode: "Reference",
    duration_seconds: 14,
    aspect_ratio: "9:16",
    active_provider: "api",
    direct_model_id: "direct-model.gguf",
    direct_context_profile: "extended",
    direct_kv_cache: "q8",
    music_lyrics_use_brief: false,
    fullscreen: true,
  });
});

test("user preferences ignore corrupt or unknown versions and sanitize fields", () => {
  assert.equal(loadUserPreferences(memoryStorage({ [USER_PREFERENCES_STORAGE_KEY]: "{" })), null);
  assert.equal(loadUserPreferences(memoryStorage({ [USER_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 2 }) })), null);

  const storage = memoryStorage({
    [USER_PREFERENCES_STORAGE_KEY]: JSON.stringify({
      version: 1,
      mode: "unknown",
      duration_seconds: 999,
      aspect_ratio: "invalid",
      active_provider: "invalid",
      direct_model_id: 123,
      direct_context_profile: "invalid",
      direct_kv_cache: "invalid",
    }),
  });
  assert.deepEqual(loadUserPreferences(storage), {
    version: 1,
    mode: "Reference",
    duration_seconds: 10,
    aspect_ratio: "16:9",
    active_provider: "direct",
    direct_model_id: null,
    direct_context_profile: "auto",
    direct_kv_cache: "auto",
    music_lyrics_use_brief: true,
    fullscreen: false,
  });
});

test("studio restores safe preferences but not transient lifecycle state", () => {
  const storage = memoryStorage({
    [USER_PREFERENCES_STORAGE_KEY]: JSON.stringify({
      version: 1,
      mode: "FL2VA",
      duration_seconds: 7,
      aspect_ratio: "3:2",
      active_provider: "ollama",
      direct_model_id: "direct-model.gguf",
      direct_context_profile: "extended",
      direct_kv_cache: "q8",
      fullscreen: true,
      ollama_context_profile: "standard",
    }),
  });
  const state = createStudioState({ sessionId: "11111111-2222-4333-8444-555555555555", storage });
  assert.equal(state.mode, "FL2VA");
  assert.equal(state.durationSeconds, 7);
  assert.equal(state.aspectRatio, "3:2");
  assert.equal(state.preferredProvider, "ollama");
  assert.equal(state.preferredDirectModelId, "direct-model.gguf");
  assert.equal(state.directContextProfile, "extended");
  assert.equal(state.directKvCache, "q8");
  assert.equal(state.musicLyricsUseBrief, true);
  assert.equal(state.fullscreen, true);
  assert.equal(state.ollamaContextProfile, undefined);
  assert.equal(state.keepModelLoaded, false);
  assert.equal(state.thinking, false);
  assert.equal(state.selectedModel, null);
  assert.deepEqual(state.assets, []);
});

test("a clean first run defaults to Ollama while saved provider preferences remain authoritative", () => {
  const clean = createStudioState({ sessionId: "clean", storage: memoryStorage() });
  assert.equal(clean.settingsProvider, "ollama");
  assert.equal(clean.preferredProvider, "ollama");

  const saved = createStudioState({
    sessionId: "saved",
    storage: memoryStorage({
      [USER_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, active_provider: "direct" }),
    }),
  });
  assert.equal(saved.settingsProvider, "direct");
  assert.equal(saved.preferredProvider, "direct");

  const savedApi = createStudioState({
    sessionId: "saved-api",
    storage: memoryStorage({
      [USER_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, active_provider: "api" }),
    }),
  });
  assert.equal(savedApi.settingsProvider, "api");
  assert.equal(savedApi.preferredProvider, "api");
});

test("audio notice triggers once per global zero-to-present transition", () => {
  const audio = { id: "a1", type: "audio" };
  assert.equal(audioWasAdded([], [audio]), true);
  assert.equal(audioWasAdded([], [audio, { id: "a2", type: "audio" }]), true);
  assert.equal(audioWasAdded([audio], [audio, { id: "a2", type: "audio" }]), false);
  assert.equal(audioWasAdded([audio], []), false);
  assert.equal(audioWasAdded([], [{ id: "a3", type: "audio" }]), true);
});

test("Reference insertion lists current media and only subjects defined from that media", () => {
  const assets = [
    { mode: "Reference", reference: "<Picture 2>" },
    { mode: "Reference", reference: "<Video 1>" },
    { mode: "Reference", reference: "<Audio 1>" },
    { mode: "I2VA", reference: "<Picture 1>" },
  ];
  const prompt = [
    "subject_definitions:",
    "<Subject 2> is defined by <Video 1>.",
    "<Subject 1> is defined by <Picture 2>.",
    "<Subject 3> is defined by <Picture 9>.",
  ].join("\n");
  assert.deepEqual(availableReferenceTags(assets, prompt), [
    "<Subject 1>", "<Subject 2>", "<Picture 2>", "<Video 1>", "<Audio 1>",
  ]);
  assert.deepEqual(availableReferenceTags([], prompt), []);
});

test("Reference insertion uses the caret without replacing selected text and emits input", () => {
  class Editor extends EventTarget {
    constructor() {
      super();
      this.value = "keep selected text";
      this.selectionStart = 5;
      this.selectionEnd = 13;
      this.focused = false;
    }
    setRangeText(value, start, end) {
      this.value = this.value.slice(0, start) + value + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + value.length;
    }
    focus() { this.focused = true; }
  }
  const editor = new Editor();
  let inputCount = 0;
  editor.addEventListener("input", () => { inputCount += 1; });
  assert.equal(insertReferenceAtCaret(editor, "<Subject 1>", editor.selectionStart), true);
  assert.equal(editor.value, "keep <Subject 1>selected text");
  assert.equal(editor.selectionStart, 16);
  assert.equal(editor.selectionEnd, 16);
  assert.equal(inputCount, 1);
  assert.equal(editor.focused, true);
});

test("Audio added notice remains visible for six seconds", () => {
  assert.match(mainSource, /"Audio added"[\s\S]{0,280}\{ durationMs: 6000 \}/);
});

test("all mode drafts persist independently across reloads", () => {
  const storage = memoryStorage();
  saveModeDrafts(storage, {
    T2VA: { brief: "Text brief", prompt: "Text prompt" },
    I2VA: { brief: "Image brief", prompt: "Image prompt" },
    Reference: { brief: "Reference brief", prompt: "Reference prompt" },
  });
  assert.deepEqual(loadModeDrafts(storage), {
    T2VA: { brief: "Text brief", prompt: "Text prompt" },
    I2VA: { brief: "Image brief", prompt: "Image prompt" },
    Reference: { brief: "Reference brief", prompt: "Reference prompt" },
  });
  assert.match(storage.entries()[MODE_DRAFTS_STORAGE_KEY], /Reference brief|Reference prompt/);
  assert.deepEqual(createStudioState({ sessionId: "drafts", storage }).modeDrafts.T2VA, { brief: "Text brief", prompt: "Text prompt" });
});

test("draft dirty state covers every mode", () => {
  const defaults = { brief: "Default brief", prompt: "Default prompt" };
  assert.equal(isModeDraftDirty("T2VA", defaults, defaults), false);
  assert.equal(isModeDraftDirty("FL2VA", { ...defaults, brief: "Changed" }, defaults), true);
  assert.equal(isModeDraftDirty("Reference", { brief: "Changed", prompt: "Changed" }, defaults), true);
  assert.equal(isModeDraftDirty("Music3", { ...defaults, lyrics: "Changed" }, { ...defaults, lyrics: "Default" }), true);
  assert.equal(isPersistedDraftMode("L2VA"), true);
  assert.equal(isPersistedDraftMode("Reference"), true);
});

test("draft reset removes only the selected mode", () => {
  const drafts = {
    T2VA: { brief: "Custom T2VA", prompt: "Custom T2VA" },
    I2VA: { brief: "Custom I2VA", prompt: "Custom I2VA" },
    Reference: { brief: "Custom Reference", prompt: "Custom Reference" },
  };
  assert.deepEqual(resetModeDraft(drafts, "T2VA"), {
    I2VA: drafts.I2VA,
    Reference: drafts.Reference,
  });
  assert.deepEqual(resetModeDraft(drafts, "Reference"), {
    T2VA: drafts.T2VA,
    I2VA: drafts.I2VA,
  });
});

test("disconnected API preference falls back to the saved Direct model after discovery", () => {
  const preferred = { id: "preferred.gguf", family: "gguf", runtime_ready: true };
  const first = { id: "first.gguf", family: "gguf", runtime_ready: true };
  const state = {
    models: [first, preferred],
    preferredProvider: "api",
    preferredDirectModelId: preferred.id,
    ollamaModelName: null,
    externalModel: null,
  };
  assert.equal(restoredModelAfterDiscovery(state), preferred);

  state.preferredDirectModelId = "missing.gguf";
  assert.equal(restoredModelAfterDiscovery(state), first);
});

test("clean Ollama preference selects a ready Ollama model before a ready Direct model", () => {
  const direct = { id: "direct.gguf", family: "gguf", runtime_ready: true };
  const ollama = { id: "ollama::vision", family: "ollama", remote_model: "vision", runtime_ready: true };
  assert.equal(restoredModelAfterDiscovery({
    models: [direct, ollama],
    preferredProvider: "ollama",
    preferredDirectModelId: null,
    ollamaModelName: null,
    externalModel: null,
  }), ollama);
});

test("studio state owns model, runtime, lifecycle, and System Prompt settings", () => {
  const storage = memoryStorage({ [SYSTEM_PROMPT_STORAGE_KEY]: JSON.stringify({ reference: "Custom reference" }) });
  const state = createStudioState({ sessionId: "11111111-2222-4333-8444-555555555555", storage });
  state.contextProfile = "extended";
  state.kvCache = "q8";
  state.keepModelLoaded = true;
  const external = { id: "external-model", family: "external", capabilities: { audio: false } };

  selectModelState(state, external);

  assert.equal(state.selectedModel, external);
  assert.equal(state.keepModelLoaded, false);
  assert.deepEqual(state.promptResidency, { direct: null, ollama: [] });
  assert.equal(state.audioSupported, false);
  assert.equal(state.settingsProvider, "external");
  assert.equal(state.settingsPromptProfile, "standard");
  assert.equal(state.musicSystemPromptExpanded, false);
  assert.equal(systemPromptProfile("Reference"), "reference");
  assert.equal(systemPromptProfile("T2VA"), "standard");
  assert.equal(systemPromptProfile("Music3"), "music3");
  assert.equal(systemPromptProfile("Music3Lyrics"), "music3_lyrics");
  assert.equal(currentSystemPromptOverride(state, "Reference"), "Custom reference");

  selectModelState(state, { id: "direct-model", family: "gguf", capabilities: { audio: true } });
  assert.equal(state.settingsProvider, "direct");
  assert.equal(state.audioSupported, true);

  selectModelState(state, { id: "ollama::gemma4:12b", family: "ollama", remote_model: "gemma4:12b", capabilities: { audio: false } });
  assert.equal(state.settingsProvider, "ollama");

  selectModelState(state, { id: "api::connection::model", family: "api", api_connection_id: "connection", remote_model: "model", capabilities: { audio: false } });
  assert.equal(state.settingsProvider, "api");
  assert.equal(state.keepModelLoaded, false);
  assert.equal(state.keepModelLoaded, false);
});

test("Direct context preferences preserve Qwen 32K and 48K tiers", () => {
  for (const profile of ["large", "maximum"]) {
    const storage = memoryStorage();
    saveUserPreferences(storage, { directContextProfile: profile });
    assert.equal(loadUserPreferences(storage).direct_context_profile, profile);
  }
});

test("Direct Thinking is disabled when the GGUF template has no detected control", () => {
  assert.match(mainSource, /\["ollama", "gguf"\]\.includes\(studio\.selectedModel\?\.family\)/);
  assert.match(mainSource, /studio\.selectedModel\.thinking !== true/);
});

test("text-only Direct models expose only T2VA", () => {
  const textOnly = {
    id: "direct-text-only",
    family: "gguf",
    projector: null,
    capabilities: { images: false, video_frames: false, audio: false },
  };
  const vision = {
    id: "direct-vision",
    family: "gguf",
    projector: "mmproj.gguf",
    capabilities: { images: true, video_frames: true, audio: false },
  };

  assert.equal(isTextOnlyDirectModel(textOnly), true);
  assert.equal(isGenerationModeAvailable(textOnly, "T2VA"), true);
  for (const mode of ["I2VA", "FL2VA", "L2VA", "Reference", "Music3"]) {
    assert.equal(isGenerationModeAvailable(textOnly, mode), false);
  }
  assert.equal(isTextOnlyDirectModel(vision), false);
  assert.equal(isGenerationModeAvailable(vision, "Reference"), true);
  assert.equal(isGenerationModeAvailable({ family: "external", capabilities: { images: false } }, "Reference"), true);
});

test("Generate and Refine payloads are built from state rather than Settings DOM", () => {
  const state = createStudioState({ sessionId: "11111111-2222-4333-8444-555555555555", storage: memoryStorage() });
  state.mode = "Reference";
  state.durationSeconds = 8;
  state.aspectRatio = "3:2";
  state.contextProfile = "standard";
  state.kvCache = "q8";
  state.thinking = true;
  state.keepModelLoaded = true;
  state.customSystemPrompts.reference = "Custom reference";
  state.externalServerConfig = { url: "http://127.0.0.1:8080", model: "gemma.gguf" };
  selectModelState(state, { id: "external-model", family: "external", capabilities: { audio: false } });

  assert.deepEqual(buildGeneratePayload(state, { creativeBrief: "A quiet shot.", seed: 3407 }), {
    session_id: state.sessionId,
    mode: "Reference",
    duration_seconds: 8,
    aspect_ratio: "3:2",
    creative_brief: "A quiet shot.",
    model_id: "external-model",
    external_server: state.externalServerConfig,
    ollama_model: null,
    api_provider: null,
    thinking: true,
    context_profile: "auto",
    kv_cache: "auto",
    system_prompt_override: "Custom reference",
    seed: 3407,
    unload_after: true,
  });
  assert.deepEqual(buildRefinePayload(state, { currentPrompt: "Current", instruction: "Slower", creativeBrief: "Original brief", seed: 99 }), {
    session_id: state.sessionId,
    mode: "Reference",
    duration_seconds: 8,
    aspect_ratio: "3:2",
    creative_brief: "Original brief",
    current_prompt: "Current",
    instruction: "Slower",
    model_id: "external-model",
    external_server: state.externalServerConfig,
    ollama_model: null,
    api_provider: null,
    thinking: true,
    context_profile: "auto",
    kv_cache: "auto",
    system_prompt_override: "Custom reference",
    seed: 99,
    unload_after: true,
  });

  selectModelState(state, {
    id: "ollama::gemma4:12b",
    family: "ollama",
    remote_model: "gemma4:12b",
    capabilities: { audio: false },
  });
  const ollamaPayload = buildGeneratePayload(state, { creativeBrief: "A quiet shot.", seed: 3407 });
  assert.equal(ollamaPayload.ollama_model, "gemma4:12b");
  assert.equal(ollamaPayload.external_server, null);
  assert.equal(ollamaPayload.api_provider, null);
  assert.equal(ollamaPayload.context_profile, "auto");
  assert.equal(ollamaPayload.kv_cache, "auto");

  const apiModel = {
    id: "api::connection-id::provider/model",
    family: "api",
    api_connection_id: "connection-id",
    remote_model: "provider/model",
    capabilities: { audio: false, images: true },
  };
  selectModelState(state, apiModel);
  const apiPayload = buildGeneratePayload(state, { creativeBrief: "A quiet shot.", seed: 3407 });
  assert.deepEqual(apiPayload.api_provider, { connection_id: "connection-id", model_id: "provider/model" });
  assert.equal(apiPayload.external_server, null);
  assert.equal(apiPayload.ollama_model, null);
});

test("background model discovery does not override an open Settings provider tab", () => {
  const state = createStudioState({ sessionId: "settings-race", storage: memoryStorage() });
  state.settingsProvider = "api";
  selectModelState(state, {
    id: "direct-model",
    family: "gguf",
    capabilities: { audio: false, images: true },
  }, { preserveSettingsProvider: true });
  assert.equal(state.selectedModel.family, "gguf");
  assert.equal(state.settingsProvider, "api");

  selectModelState(state, state.selectedModel);
  assert.equal(state.settingsProvider, "direct");
});

test("Settings separates providers, installed models, diagnostics, and verified models", () => {
  const markup = settingsMarkup(() => "<svg></svg>");
  assert.match(markup, /data-provider-option="direct"/);
  assert.match(markup, /data-provider-option="external"/);
  assert.match(markup, /data-provider-option="ollama"/);
  assert.match(markup, /data-provider-option="api"/);
  assert.ok(markup.indexOf('data-provider-option="ollama"') < markup.indexOf('data-provider-option="direct"'));
  assert.ok(markup.indexOf('data-provider-option="direct"') < markup.indexOf('data-provider-option="external"'));
  assert.ok(markup.indexOf('data-provider-option="external"') < markup.indexOf('data-provider-option="api"'));
  assert.match(markup, /data-provider-icon="ollama"/);
  assert.match(markup, /data-provider-icon="direct"/);
  assert.match(markup, /data-provider-icon="external"/);
  assert.match(markup, /data-provider-icon="api"/);
  assert.match(markup, /data-provider-panel="direct"/);
  assert.match(markup, /data-direct-runtime-status/);
  assert.match(markup, /data-provider-panel="external"/);
  assert.match(markup, /data-provider-panel="ollama"/);
  assert.match(markup, /data-provider-panel="api"/);
  assert.match(markup, /data-provider-option="ollama"[^>]*aria-selected="true"/);
  assert.match(markup, /data-provider-panel="ollama"(?![^>]*hidden)/);
  assert.match(markup, /data-provider-panel="direct"[^>]*hidden/);
  assert.match(markup, /API providers/);
  assert.match(markup, /data-installed-model/);
  assert.match(markup, /Installed models/);
  assert.match(markup, /h3ps-installed-model-heading">Select Model/);
  assert.doesNotMatch(markup, /Model used for Direct GGUF/);
  assert.match(markup, /data-model-refresh/);
  assert.match(markup, /data-model-scan-slot/);
  assert.match(markup, /data-verified-models-slot/);
  assert.doesNotMatch(markup, /data-model-capabilities/);
  assert.doesNotMatch(mainSource, /data-developer-mode/);
  assert.doesNotMatch(markup, /Prompt models/);
  assert.doesNotMatch(markup, /data-model-menu/);
  assert.match(markup, /Context and KV cache/);
  assert.match(mainSource, /llama-cpp-python is not installed/);
  assert.match(mainSource, /data-copy-direct-runtime-command/);
  assert.match(mainSource, /Close ComfyUI, run this from your ComfyUI Portable folder/);
  assert.match(mainSource, /Installation guide ↗/);
  assert.match(mainSource, /Troubleshooting guide ↗/);
  assert.match(mainSource, /llama-cpp-python is installed, but the runtime is not usable/);
  assert.match(mainSource, /diagnostics\.gpu_offload === false[\s\S]{0,100}"Runtime detected"/);
  assert.match(mainSource, /Runtime update required/);
  assert.match(mainSource, /Runtime \$\{requirement\.minimum_version\}\+ required/);
  assert.match(mainSource, /install_or_upgrade_command/);
  assert.doesNotMatch(mainSource, /dependency !== "llama-cpp-python"/);
  assert.match(mainSource, /Troubleshooting ↗/);
  assert.match(mainSource, /refreshGGUFRuntimeDiagnostics\(\)/);
  assert.match(markup, /h3ps-model-icon h3ps-provider-icon[^>]+data-provider-icon="direct"/);
  assert.match(mainSource, /runtimeSettings\.hidden = provider !== "direct"/);
  assert.doesNotMatch(mainSource, /Context is sent explicitly with each request/);
  assert.match(mainSource, /studio\.selectedModel\?\.family === "gguf"/);
  assert.doesNotMatch(mainSource, /\/api\/pull/);
  assert.doesNotMatch(mainSource, /Install .*Gemma|Cancel download|Downloading model/i);
  assert.match(mainSource, /Compatible · not yet H3-tested/);
  assert.match(mainSource, /data-copy-ollama-command/);
  assert.match(mainSource, /Choose a model for your GPU/);
  assert.match(mainSource, /<code>\$\{escapeHtml\(command\)\}<\/code>/);
  assert.match(mainSource, /h3ps-ollama-model-state/);
  assert.match(mainSource, /is-detected/);
  assert.match(mainSource, /Detected/);
  assert.doesNotMatch(mainSource, /Recommended for your GPU|Lighter model|Larger model/);
  assert.match(mainSource, /data-ollama-model/);
  assert.match(mainSource, /data-ollama-add-model/);
  assert.match(mainSource, /\+ Add model/);
  assert.match(skinSource, /h3ps-root \.h3ps-ollama-add-model-toggle[^}]+color: var\(--h3ps-accent-strong\)[^}]+font-size: 9\.5px[^}]+cursor: pointer/);
  assert.match(skinSource, /h3ps-ollama-model-select select[\s\S]{0,900}background-position: right 12px center[\s\S]{0,300}cursor: pointer/);
  assert.match(skinSource, /h3ps-api-model-select select[\s\S]{0,900}background-position: right 12px center[\s\S]{0,300}cursor: pointer/);
  assert.match(mainSource, /Choose another tested model/);
  assert.match(mainSource, /studio\.ollamaAddModelOpen = !studio\.ollamaAddModelOpen/);
  assert.match(mainSource, /Need models on another drive\?/);
  assert.match(mainSource, /OLLAMA_MODELS/);
  assert.match(mainSource, /syncOllamaAutoDetection/);
  assert.match(mainSource, /setTimeout\(\(\) => refreshOllama\(\{ automatic: true \}\), 4000\)/);
  assert.match(mainSource, /data-provider-icon="external"/);
  assert.match(mainSource, /data-provider-icon="ollama"/);
  for (const providerIcon of ["api-gemini", "api-openai", "api-openrouter", "api-custom"]) {
    assert.match(mainSource, new RegExp(`icon: "${providerIcon}"`));
    assert.match(skinSource, new RegExp(`data-provider-icon="${providerIcon}"`));
  }
  assert.doesNotMatch(mainSource, /h3ps-provider-icon">[SO]<\/span>/);
  assert.match(mainSource, /data-api-provider-form/);
  assert.match(mainSource, /The key is sent once to the local H3 backend/);
  assert.match(mainSource, /Reasoning provider managed/);
  assert.match(mainSource, /label\.hidden = apiManaged/);
  assert.doesNotMatch(mainSource, /credential_source|environment_name|Not analyzed locally|Exclude from AI analysis|data-analysis-asset/);
});

test("Reference defaults use plain Picture 1 and Video 1 text while canonical tags remain user-authored", () => {
  assert.match(mainSource, /const REFERENCE_DEFAULT_BRIEF = ["`][^"`]*Picture 1[^"`]*Video 1[^"`]*["`]/s);
  assert.doesNotMatch(mainSource.match(/const REFERENCE_DEFAULT_BRIEF = ["`][^"`]*["`]/s)?.[0] || "", /<Picture 1>|<Video 1>/);
});

test("Settings shows compact global System Prompt summaries and an on-demand editor", () => {
  const markup = settingsMarkup(() => "<svg></svg>");
  assert.equal((markup.match(/h3ps-system-prompt-card/g) || []).length, 1);
  assert.doesNotMatch(markup, /<small>H3 Prompt Writer<\/small>/);
  assert.match(markup, /Prompt behavior · shared by all providers/);
  assert.match(markup, /data-system-prompt-overview/);
  assert.match(markup, /data-system-prompt-summary-status="standard"/);
  assert.match(markup, /data-system-prompt-summary-status="reference"/);
  assert.match(markup, /data-system-prompt-editor hidden/);
  assert.match(markup, /data-system-prompt-back/);
  assert.match(markup, /data-system-prompt-profile="standard"/);
  assert.match(markup, /data-system-prompt-profile="reference"/);
  assert.match(markup, /data-system-prompt-panel="standard"/);
  assert.match(markup, /data-system-prompt-panel="reference"[^>]*hidden/);
  assert.match(markup, /data-system-prompt="standard"/);
  assert.match(markup, /data-system-prompt="reference"/);
  assert.doesNotMatch(markup, /data-keep-loaded/);
  assert.doesNotMatch(markup, /data-comfy-memory-action/);
  assert.match(mainSource, /data-thinking/);
  assert.match(mainSource, /data-keep-loaded/);
  assert.match(mainSource, /data-comfy-memory-action/);
  const freeVramStart = mainSource.indexOf("async function releaseComfyVram");
  const freeVramEnd = mainSource.indexOf("function showVramRetry", freeVramStart);
  const freeVramSource = mainSource.slice(freeVramStart, freeVramEnd);
  assert.match(freeVramSource, /finally\s*\{[\s\S]*button\.disabled = false;[\s\S]*button\.innerHTML = `\$\{icon\("memory", 15\)\}Free ComfyUI VRAM`;/);
  assert.match(mainSource, /Unload Ollama/);
  assert.match(mainSource, /Unload Direct/);
  assert.match(mainSource, /Stop & unload/);
  assert.doesNotMatch(mainSource, /Stop request/);
  assert.match(mainSource, /Checking…/);
  assert.match(mainSource, /Ollama is not running/);
  assert.match(settingsSource, /title="Open model settings"/);
  assert.match(settingsSource, /data-active-runtime-summary>Runtime · Auto</);
  assert.match(settingsSource, /data-runtime-option="context" data-value="large">32K</);
  assert.match(settingsSource, /data-runtime-option="context" data-value="maximum">48K</);
  assert.match(mainSource, /const availableContexts = model\.context_profiles/);
  assert.match(mainSource, /studio\.directContextProfile = "auto"/);
  assert.match(mainSource, /button\.disabled = unavailable/);
  assert.match(mainSource, /Large model · measure locally/);
  assert.match(mainSource, /llama-cpp-python \$\{model\.minimum_runtime\}\+/);
  assert.match(mainSource, /"Server managed"/);
  assert.match(mainSource, /generate\(buildGeneratePayload\(studio/);
  assert.match(mainSource, /refine\(buildRefinePayload\(studio/);
});

test("Settings owns a two-click restore for all mode draft defaults", () => {
  const markup = settingsMarkup(() => "<svg></svg>");
  assert.match(markup, /data-restore-default-drafts/);
  assert.match(markup, /Restore default drafts/);
  assert.doesNotMatch(mainSource, /data-draft-reset/);
  assert.match(mainSource, /MODE_DEFAULT_DRAFTS/);
  assert.match(mainSource, /T2VA:[\s\S]{0,900}rooftop greenhouse/);
  assert.match(mainSource, /I2VA:[\s\S]{0,1200}<Picture 1>/);
  assert.match(mainSource, /FL2VA:[\s\S]{0,1400}<Picture 2>/);
  assert.match(mainSource, /L2VA:[\s\S]{0,1200}final composition established by <Picture 1>/);
  assert.match(mainSource, /saveCurrentModeDraft\(\)/);
  assert.match(mainSource, /Click again to confirm/);
  assert.match(mainSource, /setTimeout\(disarmDraftDefaults, 5000\)/);
  assert.match(mainSource, /studio\.modeDrafts = \{\}/);
  assert.match(mainSource, /mode === "Reference"[\s\S]{0,120}REFERENCE_DEFAULT_BRIEF[\s\S]{0,80}SAMPLE_PROMPT/);
  assert.match(mainSource, /draftDefaultsArmed && !event\.target\.closest\("\[data-restore-default-drafts\]"\)/);
  assert.doesNotMatch(mainSource, /data-modified-badge/);
  assert.doesNotMatch(mainSource, /Replace the modified prompt with a new generation/);
  assert.doesNotMatch(mainSource, /referenceDraft/);
  assert.match(stylesSource, /h3ps-draft-defaults-action/);
});

test("Reference mode exposes one contextual insert control across its three editors", () => {
  assert.equal((mainSource.match(/data-reference-insert-toggle/g) || []).length >= 2, true);
  assert.match(mainSource, /aria-label="Insert reference"/);
  assert.match(mainSource, /data-reference-insert-toggle><\/button>/);
  assert.doesNotMatch(mainSource, /data-reference-insert-toggle[^>]*>[\s\S]{0,120}<span>Insert<\/span>/);
  assert.match(stylesSource, /assets\/icons\/insert-reference\.svg/);
  assert.match(mainSource, /studio\.mode !== "Reference"/);
  assert.match(mainSource, /querySelectorAll\("\[data-video-brief\], \[data-output\], \[data-refine-instruction\]"\)/);
  assert.match(mainSource, /insertReferenceAtCaret\(target\.editor, reference, target\.caret\)/);
  assert.match(mainSource, /\["focus", "click", "keyup", "select", "input"\]/);
  assert.match(mainSource, /if \(!event\.target\.closest\("\[data-reference-insert\]"\)\) closeReferenceInsert\(\)/);
  assert.match(stylesSource, /h3ps-output-panel\.is-refining \[data-refine-toggle\] \{ display: none; \}/);
  assert.doesNotMatch(stylesSource, /h3ps-output-panel\.is-refining \.h3ps-output-actions \{ display: none; \}/);
  for (const kind of ["subject", "image", "video", "audio"]) {
    assert.match(stylesSource, new RegExp(`h3ps-editor-highlight mark\\.is-${kind}, \\.h3ps-reference-chip\\.is-${kind}`));
  }
});

test("Music 3 drafts and payload keep lyrics separate from H3 state", () => {
  const storage = memoryStorage();
  saveModeDrafts(storage, {
    Music3: { brief: "Oboe chamber pop", lyrics: "[Verse]\nWindows glow", prompt: "### Global Metadata\n..." },
  });
  assert.deepEqual(loadModeDrafts(storage).Music3, {
    brief: "Oboe chamber pop",
    lyrics: "[Verse]\nWindows glow",
    prompt: "### Global Metadata\n...",
  });
  const state = createStudioState({ sessionId: "music-session", storage });
  state.mode = "Music3";
  state.customSystemPrompts.music3 = "Return the requested custom music format.";
  state.customSystemPrompts.music3_lyrics = "Return only the revised lyrics.";
  selectModelState(state, { id: "music-model", family: "gguf", capabilities: { audio: false } });
  const payload = buildGeneratePayload(state, { creativeBrief: "Dry funk at precisely 111 BPM without claps", lyrics: "[Chorus]\nOpen the gate", seed: 7 });
  assert.equal(payload.mode, "Music3");
  assert.equal(payload.lyrics, "[Chorus]\nOpen the gate");
  assert.equal(payload.creative_brief, "Dry funk at precisely 111 BPM without claps");
  assert.equal(payload.system_prompt_override, "Return the requested custom music format.");
  const lyricsWithBrief = buildLyricsRefinePayload(state, {
    currentLyrics: "[Verse]\nOld line",
    instruction: "Make the line quieter",
    useMusicBrief: true,
    creativeBrief: "Quiet acoustic folk",
    seed: 9,
  });
  assert.equal(lyricsWithBrief.target, "lyrics");
  assert.equal(lyricsWithBrief.current_lyrics, "[Verse]\nOld line");
  assert.equal(lyricsWithBrief.creative_brief, "Quiet acoustic folk");
  assert.equal(lyricsWithBrief.use_music_brief, true);
  assert.equal(lyricsWithBrief.system_prompt_override, "Return only the revised lyrics.");
  const lyricsWithoutBrief = buildLyricsRefinePayload(state, {
    currentLyrics: "",
    instruction: "Write a compact hook",
    useMusicBrief: false,
    creativeBrief: "Must not be sent",
    seed: 10,
  });
  assert.equal(lyricsWithoutBrief.creative_brief, "");
  assert.equal(lyricsWithoutBrief.use_music_brief, false);
  assert.match(mainSource, /data-workspace="video"/);
  assert.match(mainSource, /data-workspace="music"/);
  assert.match(mainSource, /data-music-brief/);
  assert.match(mainSource, /data-music-lyrics/);
  assert.doesNotMatch(mainSource, /data-music-prompt-toggle/);
  assert.match(mainSource, /data-music-system-prompt-profile="music3"/);
  assert.match(mainSource, /data-music-system-prompt-profile="music3_lyrics"/);
  assert.match(mainSource, /data-music-system-prompt-toggle aria-expanded="false"/);
  assert.match(mainSource, /data-music-system-prompt-summary>Default/);
  assert.match(mainSource, /data-music-system-prompt-details hidden/);
  assert.doesNotMatch(mainSource, /Prompt behavior · shared by all providers/);
  assert.match(mainSource, /Object\.hasOwn\(studio\.customSystemPrompts, "music3"\)[\s\S]{0,140}Object\.hasOwn\(studio\.customSystemPrompts, "music3_lyrics"\)[\s\S]{0,100}"Custom"/);
  assert.match(mainSource, /data-system-prompt="\$\{profile\}"/);
  assert.match(mainSource, /musicSystemPromptPanelMarkup\("music3", "Caption"/);
  assert.match(mainSource, /musicSystemPromptPanelMarkup\("music3_lyrics", "Lyrics"/);
  assert.match(mainSource, /data-system-prompt-reset="\$\{profile\}" hidden>Restore default/);
  assert.match(mainSource, /### Global Metadata[\s\S]*### Vocal Details[\s\S]*### Arrangement/);
  assert.doesNotMatch(mainSource, /global_metadata:/);
  assert.match(mainSource, /Refine caption/);
  assert.match(mainSource, /Generated caption/);
  assert.match(mainSource, /data-lyrics-refine-toggle>[\s\S]{0,80}Refine<\/button>/);
  assert.match(mainSource, /Leave Lyrics empty to create new lyrics, or describe how to rewrite the existing lyrics\./);
  assert.match(mainSource, /data-lyrics-use-brief checked/);
  assert.doesNotMatch(mainSource, /data-(?:lyrics-)?refine-submit[^>]*>[\s\S]{0,80}Rewrite<\/button>/);
  const requestIndex = mainSource.indexOf("const result = await refine(buildLyricsRefinePayload");
  const lyricsAssignmentIndex = mainSource.indexOf("lyrics.value = result.prompt", requestIndex);
  assert.ok(requestIndex >= 0 && lyricsAssignmentIndex > requestIndex);
  assert.match(mainSource, /studio\.lyricsRestore = \{ lyrics: currentLyrics \}[\s\S]{0,180}lyrics\.value = result\.prompt/);
  assert.doesNotMatch(mainSource.slice(requestIndex, lyricsAssignmentIndex + 500), /lyrics-refine-instruction[^\n]*\.value = ""/);
  assert.match(mainSource, /restore\.textContent = currentLyrics\.trim\(\) \? "Restore previous" : "Remove generated"/);
  assert.match(mainSource, /data-lyrics-refine-restore[\s\S]{0,700}const previousLyrics = studio\.lyricsRestore\.lyrics;[\s\S]{0,80}lyrics\.value = previousLyrics/);
});

test("active requests block add, reorder, and mode switching", () => {
  assert.match(mainSource, /error\.code === "EXTERNAL_VISION_REQUIRED"[\s\S]{0,160}showToast\("Vision model required"/);
  assert.match(mainSource, /data-add-media \$\{studio\.requestBusy \? "disabled" : ""\}/);
  assert.match(mainSource, /const draggable = studio\.requestBusy \? "false" : "true"/);
  assert.match(mainSource, /dragstart[\s\S]{0,180}if \(studio\.requestBusy\)/);
  assert.match(mainSource, /drop[\s\S]{0,180}if \(studio\.requestBusy\) return/);
  assert.match(mainSource, /if \(!files\.length \|\| studio\.requestBusy\) return/);
  assert.match(mainSource, /studio\.requestBusy = busy;[\s\S]{0,120}syncModeAvailability\(\)/);
  assert.match(mainSource, /const unavailable = !isGenerationModeAvailable[\s\S]{0,180}control\.disabled = studio\.requestBusy \|\| unavailable/);
});

test("text-only Direct UI disables visual and Music modes and explains the fallback", () => {
  assert.match(mainSource, /function syncModeAvailability\(\)/);
  assert.match(mainSource, /data-workspace[\s\S]{0,220}control\.dataset\.workspace === "music"/);
  assert.match(mainSource, /Text-only model · T2VA available/);
  assert.match(mainSource, /Switched to T2VA/);
  assert.match(mainSource, /if \(!generationModeIsAvailable\(\)\) return/);
  assert.match(stylesSource, /\.h3ps-modes button:disabled/);
  assert.match(skinSource, /\.h3ps-workspaces button:disabled/);
});

test("fullscreen reuses the studio root and persists its UI state", () => {
  assert.match(mainSource, /data-fullscreen-toggle/);
  assert.match(mainSource, /root\.classList\.toggle\("is-fullscreen", studio\.fullscreen\)/);
  assert.match(mainSource, /setAttribute\("aria-pressed", String\(studio\.fullscreen\)\)/);
  assert.match(mainSource, /if \(studio\.fullscreen\) setFullscreen\(false\)/);
  assert.match(mainSource, /saveUserPreferences\(localStorage, studio\)/);
  assert.match(mainSource, /current\.root\.classList\.add\("is-open"\)[\s\S]{0,220}requestAnimationFrame\(updateBriefLayout\)/);
  assert.match(mainSource, /const fullscreen = studio\.fullscreen && studio\.root\.classList\.contains\("is-open"\)/);
  assert.match(stylesSource, /\.h3ps-root\.is-fullscreen \.h3ps-brief textarea \{ max-height: none; \}/);
});

test("prompt refinement keeps actions above a vertically resizable editor", () => {
  assert.match(mainSource, /h3ps-refine-heading-actions[\s\S]{0,500}data-refine-cancel[\s\S]{0,250}data-refine-submit/);
  assert.match(mainSource, /data-refine-helper[\s\S]{0,160}data-refine-media-note/);
  assert.doesNotMatch(mainSource, /refine_height|refineHeight/);
  assert.match(stylesSource, /\.h3ps-refine\[data-refine-panel\] textarea \{[^}]*min-height: 72px;[^}]*resize: vertical;/);
});
