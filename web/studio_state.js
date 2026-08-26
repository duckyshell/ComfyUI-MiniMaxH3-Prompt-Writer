export const SYSTEM_PROMPT_STORAGE_KEY = "h3ps-system-prompts-v1";
export const EXTERNAL_SERVER_STORAGE_KEY = "h3ps-external-llama-server-v1";
export const OLLAMA_MODEL_STORAGE_KEY = "h3ps-ollama-model-v1";
export const OLLAMA_HOST_STORAGE_KEY = "h3ps-ollama-host-v1";
export const OLLAMA_ENDPOINT_MODELS_STORAGE_KEY = "h3ps-ollama-endpoint-models-v1";
export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
export const API_PROVIDER_STORAGE_KEY = "h3ps-api-provider-v1";
export const USER_PREFERENCES_STORAGE_KEY = "h3ps-preferences-v1";
export const MODE_DRAFTS_STORAGE_KEY = "h3ps-mode-drafts-v1";

const MODES = ["T2VA", "I2VA", "FL2VA", "L2VA", "Reference", "Music3"];
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
const PROVIDERS = ["direct", "external", "ollama", "api"];
const CONTEXT_PROFILES = ["auto", "low", "standard", "extended", "large", "maximum"];
const KV_CACHES = ["auto", "f16", "q8"];
const DRAFT_MODES = ["T2VA", "I2VA", "FL2VA", "L2VA", "Reference", "Music3"];

export function isPersistedDraftMode(mode) {
  return DRAFT_MODES.includes(mode);
}

export function audioWasAdded(previousAssets, nextAssets) {
  return previousAssets.every((asset) => asset.type !== "audio")
    && nextAssets.some((asset) => asset.type === "audio");
}

export function isTextOnlyDirectModel(model) {
  return model?.family === "gguf" && model?.capabilities?.images === false;
}

export function isGenerationModeAvailable(model, mode) {
  return !isTextOnlyDirectModel(model) || mode === "T2VA";
}

export function isModeDraftDirty(mode, draft, defaults) {
  return isPersistedDraftMode(mode)
    && Boolean(draft)
    && (draft.brief !== defaults.brief
      || draft.prompt !== defaults.prompt
      || (mode === "Music3" && draft.lyrics !== defaults.lyrics));
}

export function resetModeDraft(drafts, mode) {
  if (!isPersistedDraftMode(mode)) return drafts;
  const next = { ...drafts };
  delete next[mode];
  return next;
}

export function loadModeDrafts(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(MODE_DRAFTS_STORAGE_KEY) || "null");
    if (!value || value.version !== 1 || !value.drafts || typeof value.drafts !== "object") return {};
    return Object.fromEntries(DRAFT_MODES.flatMap((mode) => {
      const draft = value.drafts[mode];
      if (!draft || typeof draft.brief !== "string" || typeof draft.prompt !== "string") return [];
      const safeDraft = { brief: draft.brief.slice(0, 2000), prompt: draft.prompt.slice(0, 16000) };
      if (mode === "Music3") safeDraft.lyrics = typeof draft.lyrics === "string" ? draft.lyrics.slice(0, 4000) : "";
      return [[mode, safeDraft]];
    }));
  } catch {
    return {};
  }
}

export function saveModeDrafts(storage, drafts) {
  const safeDrafts = Object.fromEntries(DRAFT_MODES.flatMap((mode) => {
    const draft = drafts?.[mode];
    if (!draft || typeof draft.brief !== "string" || typeof draft.prompt !== "string") return [];
    const safeDraft = { brief: draft.brief.slice(0, 2000), prompt: draft.prompt.slice(0, 16000) };
    if (mode === "Music3") safeDraft.lyrics = typeof draft.lyrics === "string" ? draft.lyrics.slice(0, 4000) : "";
    return [[mode, safeDraft]];
  }));
  storage?.setItem(MODE_DRAFTS_STORAGE_KEY, JSON.stringify({ version: 1, drafts: safeDrafts }));
}

export function loadUserPreferences(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(USER_PREFERENCES_STORAGE_KEY) || "null");
    if (!value || value.version !== 1) return null;
    return {
      version: 1,
      mode: MODES.includes(value.mode) ? value.mode : "Reference",
      duration_seconds: Number.isInteger(value.duration_seconds) && value.duration_seconds >= 1 && value.duration_seconds <= 20 ? value.duration_seconds : 10,
      aspect_ratio: ASPECT_RATIOS.includes(value.aspect_ratio) ? value.aspect_ratio : "16:9",
      active_provider: PROVIDERS.includes(value.active_provider) ? value.active_provider : "direct",
      direct_model_id: typeof value.direct_model_id === "string" && value.direct_model_id ? value.direct_model_id : null,
      direct_context_profile: CONTEXT_PROFILES.includes(value.direct_context_profile) ? value.direct_context_profile : "auto",
      direct_kv_cache: KV_CACHES.includes(value.direct_kv_cache) ? value.direct_kv_cache : "auto",
      music_lyrics_use_brief: value.music_lyrics_use_brief !== false,
      fullscreen: value.fullscreen === true,
    };
  } catch {
    return null;
  }
}

export function saveUserPreferences(storage, state) {
  const safe = {
    version: 1,
    mode: MODES.includes(state.mode) ? state.mode : "Reference",
    duration_seconds: Number.isInteger(state.durationSeconds) && state.durationSeconds >= 1 && state.durationSeconds <= 20 ? state.durationSeconds : 10,
    aspect_ratio: ASPECT_RATIOS.includes(state.aspectRatio) ? state.aspectRatio : "16:9",
    active_provider: PROVIDERS.includes(state.settingsProvider) ? state.settingsProvider : "direct",
    direct_model_id: typeof state.preferredDirectModelId === "string" && state.preferredDirectModelId ? state.preferredDirectModelId : null,
    direct_context_profile: CONTEXT_PROFILES.includes(state.directContextProfile) ? state.directContextProfile : "auto",
    direct_kv_cache: KV_CACHES.includes(state.directKvCache) ? state.directKvCache : "auto",
    music_lyrics_use_brief: state.musicLyricsUseBrief !== false,
    fullscreen: state.fullscreen === true,
  };
  storage?.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify(safe));
}

export function loadApiProviderConfig(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(API_PROVIDER_STORAGE_KEY) || "null");
    if (!value || !["openai", "gemini", "openrouter", "custom"].includes(value.preset)) return null;
    return {
      preset: value.preset,
      base_url: typeof value.base_url === "string" ? value.base_url : "",
      model_id: typeof value.model_id === "string" ? value.model_id : "",
      gemini_reasoning_effort: ["minimal", "low", "medium", "high"].includes(value.gemini_reasoning_effort) ? value.gemini_reasoning_effort : "minimal",
      custom_images: value.custom_images === true,
      custom_context_tokens: Number.isInteger(value.custom_context_tokens) ? value.custom_context_tokens : null,
    };
  } catch {
    return null;
  }
}

export function saveApiProviderConfig(storage, config) {
  if (!config) {
    storage?.removeItem(API_PROVIDER_STORAGE_KEY);
    return;
  }
  const safe = {
    preset: config.preset,
    base_url: String(config.base_url || ""),
    model_id: String(config.model_id || ""),
    gemini_reasoning_effort: ["minimal", "low", "medium", "high"].includes(config.gemini_reasoning_effort) ? config.gemini_reasoning_effort : "minimal",
    custom_images: config.custom_images === true,
    custom_context_tokens: Number.isInteger(config.custom_context_tokens) ? config.custom_context_tokens : null,
  };
  storage?.setItem(API_PROVIDER_STORAGE_KEY, JSON.stringify(safe));
}

export function normalizeOllamaHost(value) {
  const host = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (/^http:\/\/(localhost|\[::1\])(?::11434)?$/i.test(host)) return DEFAULT_OLLAMA_HOST;
  return host || DEFAULT_OLLAMA_HOST;
}

export function loadOllamaHost(storage = globalThis.localStorage) {
  return normalizeOllamaHost(storage?.getItem(OLLAMA_HOST_STORAGE_KEY));
}

export function saveOllamaHost(storage, host) {
  const normalized = normalizeOllamaHost(host);
  if (normalized === DEFAULT_OLLAMA_HOST) storage?.removeItem(OLLAMA_HOST_STORAGE_KEY);
  else storage?.setItem(OLLAMA_HOST_STORAGE_KEY, normalized);
}

function loadEndpointModels(storage) {
  try {
    const value = JSON.parse(storage?.getItem(OLLAMA_ENDPOINT_MODELS_STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function loadOllamaModel(storage = globalThis.localStorage, host = DEFAULT_OLLAMA_HOST) {
  const endpoint = normalizeOllamaHost(host);
  if (endpoint === DEFAULT_OLLAMA_HOST) {
    const value = storage?.getItem(OLLAMA_MODEL_STORAGE_KEY);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const value = loadEndpointModels(storage)[endpoint];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function saveOllamaModel(storage, modelName, host = DEFAULT_OLLAMA_HOST) {
  const endpoint = normalizeOllamaHost(host);
  if (endpoint === DEFAULT_OLLAMA_HOST) {
    if (modelName) storage?.setItem(OLLAMA_MODEL_STORAGE_KEY, modelName);
    else storage?.removeItem(OLLAMA_MODEL_STORAGE_KEY);
    return;
  }
  const models = loadEndpointModels(storage);
  if (modelName) models[endpoint] = modelName;
  else delete models[endpoint];
  if (Object.keys(models).length) storage?.setItem(OLLAMA_ENDPOINT_MODELS_STORAGE_KEY, JSON.stringify(models));
  else storage?.removeItem(OLLAMA_ENDPOINT_MODELS_STORAGE_KEY);
}

export function loadExternalServerConfig(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(EXTERNAL_SERVER_STORAGE_KEY) || "null");
    if (value && typeof value.url === "string") {
      return { url: value.url, model: String(value.model || "") };
    }
  } catch {}
  return null;
}

export function saveExternalServerConfig(storage, config) {
  if (config) storage?.setItem(EXTERNAL_SERVER_STORAGE_KEY, JSON.stringify(config));
  else storage?.removeItem(EXTERNAL_SERVER_STORAGE_KEY);
}

export function loadCustomSystemPrompts(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(SYSTEM_PROMPT_STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function saveCustomSystemPrompts(storage, prompts) {
  storage?.setItem(SYSTEM_PROMPT_STORAGE_KEY, JSON.stringify(prompts));
}

export function systemPromptProfile(mode) {
  if (mode === "Music3Lyrics") return "music3_lyrics";
  if (mode === "Music3") return "music3";
  return mode === "Reference" || mode === "reference" ? "reference" : "standard";
}

export function currentSystemPromptOverride(state, mode = state.mode) {
  const profile = systemPromptProfile(mode);
  return systemPromptOverride(state, profile);
}

export function systemPromptOverride(state, profile) {
  return Object.hasOwn(state.customSystemPrompts, profile)
    ? state.customSystemPrompts[profile]
    : null;
}

export function selectedExternalServer(state) {
  return state.selectedModel?.family === "external" ? state.externalServerConfig : null;
}

export function selectedOllamaModel(state) {
  return state.selectedModel?.family === "ollama" ? state.selectedModel.remote_model : null;
}

export function selectedOllamaHost(state) {
  return state.selectedModel?.family === "ollama" ? state.ollamaHost : null;
}

export function selectedApiProvider(state) {
  if (state.selectedModel?.family !== "api") return null;
  return {
    connection_id: state.selectedModel.api_connection_id,
    model_id: state.selectedModel.remote_model,
  };
}

export function selectModelState(state, model, { preserveSettingsProvider = false } = {}) {
  const settingsProvider = state.settingsProvider;
  state.selectedModel = model || null;
  state.audioSupported = model?.capabilities?.audio === true;
  if (!preserveSettingsProvider) {
    if (model?.family === "external") state.settingsProvider = "external";
    else if (model?.family === "ollama") state.settingsProvider = "ollama";
    else if (model?.family === "api") state.settingsProvider = "api";
    else if (model?.family === "gguf") state.settingsProvider = "direct";
  } else {
    state.settingsProvider = settingsProvider;
  }
  if (["external", "api"].includes(model?.family)) {
    state.keepModelLoaded = false;
  }
  return state;
}

export function restoredModelAfterDiscovery(state) {
  const preferredDirect = state.models.find((model) => model.family === "gguf" && model.id === state.preferredDirectModelId && model.runtime_ready);
  const preferredProviderModel = state.preferredProvider === "direct"
    ? preferredDirect
    : state.preferredProvider === "external"
      ? state.externalModel
      : state.preferredProvider === "ollama"
        ? state.models.find((model) => model.family === "ollama" && model.remote_model === state.ollamaModelName && model.runtime_ready)
          || state.models.find((model) => model.family === "ollama" && model.runtime_ready)
        : null;
  return preferredProviderModel
    || preferredDirect
    || state.models.find((model) => model.runtime_ready)
    || state.models[0]
    || null;
}

function sharedInferencePayload(state) {
  const directRuntime = state.selectedModel?.family === "gguf";
  return {
    session_id: state.sessionId,
    mode: state.mode,
    model_id: state.selectedModel?.id,
    external_server: selectedExternalServer(state),
    ollama_model: selectedOllamaModel(state),
    ollama_host: selectedOllamaHost(state),
    api_provider: selectedApiProvider(state),
    thinking: state.thinking,
    context_profile: directRuntime ? state.contextProfile : "auto",
    kv_cache: directRuntime ? state.kvCache : "auto",
    system_prompt_override: currentSystemPromptOverride(state),
    unload_after: !state.keepModelLoaded,
  };
}

export function buildGeneratePayload(state, { creativeBrief, lyrics = "", seed }) {
  const directRuntime = state.selectedModel?.family === "gguf";
  const payload = {
    session_id: state.sessionId,
    mode: state.mode,
    duration_seconds: state.durationSeconds,
    aspect_ratio: state.aspectRatio,
    creative_brief: creativeBrief,
    model_id: state.selectedModel?.id,
    external_server: selectedExternalServer(state),
    ollama_model: selectedOllamaModel(state),
    ollama_host: selectedOllamaHost(state),
    api_provider: selectedApiProvider(state),
    thinking: state.thinking,
    context_profile: directRuntime ? state.contextProfile : "auto",
    kv_cache: directRuntime ? state.kvCache : "auto",
    system_prompt_override: currentSystemPromptOverride(state),
    seed,
    unload_after: !state.keepModelLoaded,
  };
  if (state.mode === "Music3") payload.lyrics = lyrics;
  return payload;
}

export function buildRefinePayload(state, { currentPrompt, instruction, creativeBrief, lyrics = "", seed }) {
  const payload = {
    ...sharedInferencePayload(state),
    current_prompt: currentPrompt,
    instruction,
    duration_seconds: state.durationSeconds,
    aspect_ratio: state.aspectRatio,
    creative_brief: creativeBrief,
    seed,
  };
  if (state.mode === "Music3") payload.lyrics = lyrics;
  return payload;
}

export function buildLyricsRefinePayload(state, {
  currentLyrics,
  instruction,
  useMusicBrief,
  creativeBrief,
  seed,
}) {
  return {
    ...sharedInferencePayload(state),
    target: "lyrics",
    current_lyrics: currentLyrics,
    instruction,
    use_music_brief: useMusicBrief,
    creative_brief: useMusicBrief ? creativeBrief : "",
    system_prompt_override: systemPromptOverride(state, "music3_lyrics"),
    seed,
  };
}

export function createStudioState({ sessionId, storage = globalThis.localStorage }) {
  const preferences = loadUserPreferences(storage);
  const ollamaHost = loadOllamaHost(storage);
  return {
    mode: preferences?.mode || "Reference",
    lastVideoMode: preferences?.mode && preferences.mode !== "Music3" ? preferences.mode : "Reference",
    mediaFilter: "all",
    durationSeconds: preferences?.duration_seconds || 10,
    aspectRatio: preferences?.aspect_ratio || "16:9",
    contextProfile: "auto",
    kvCache: "auto",
    thinking: false,
    keepModelLoaded: false,
    settingsProvider: preferences?.active_provider || "ollama",
    preferencesRestoring: true,
    preferredProvider: preferences?.active_provider || "ollama",
    preferredDirectModelId: preferences?.direct_model_id || null,
    directContextProfile: preferences?.direct_context_profile || "auto",
    directKvCache: preferences?.direct_kv_cache || "auto",
    musicLyricsUseBrief: preferences?.music_lyrics_use_brief !== false,
    fullscreen: preferences?.fullscreen === true,
    settingsPromptProfile: "standard",
    musicSystemPromptProfile: "music3",
    musicSystemPromptExpanded: false,
    ollamaAddModelOpen: false,
    promptResidency: { direct: null, ollama: [] },
    activeRequestFamily: null,
    activeRequestModelId: null,
    requestBusy: false,
    comfyVramReleaseInFlight: false,
    lyricsRequestBusy: false,
    toastTimer: null,
    statusTimer: null,
    lifecycleDotCount: 0,
    generationDotCount: 0,
    sessionId,
    assets: [],
    previewAssetId: null,
    audioSupported: false,
    models: [],
    modelSetup: [],
    modelDirectory: "ComfyUI/models/LLM/",
    modelDiscovery: null,
    gpuMemory: null,
    selectedModel: null,
    externalServerConfig: loadExternalServerConfig(storage),
    externalModel: null,
    externalServerError: null,
    ollamaStatus: null,
    ollamaHost,
    ollamaModelName: loadOllamaModel(storage, ollamaHost),
    ollamaError: null,
    ollamaPollTimer: null,
    ollamaRefreshBusy: false,
    ollamaHostSettingsOpen: false,
    ollamaStorageHelpOpen: false,
    apiProviderConfig: loadApiProviderConfig(storage) || {
      preset: "gemini",
      base_url: "",
      model_id: "",
      gemini_reasoning_effort: "minimal",
      custom_images: false,
      custom_context_tokens: null,
    },
    apiProviderConnection: null,
    apiProviderModels: [],
    apiProviderPresets: [],
    apiProviderError: null,
    ggufRuntimeDiagnostics: null,
    ggufRuntimeDiagnosticsLoading: false,
    runtimeWarningShown: false,
    refineRestore: null,
    lyricsRestore: null,
    lastModelPrompt: null,
    lastModelMeta: null,
    guides: [],
    draggedAssetId: null,
    dragGhost: null,
    customSystemPrompts: loadCustomSystemPrompts(storage),
    systemPromptDefaults: {},
    modeDrafts: loadModeDrafts(storage),
  };
}
