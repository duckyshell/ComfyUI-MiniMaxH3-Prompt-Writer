export const SYSTEM_PROMPT_STORAGE_KEY = "h3ps-system-prompts-v1";
export const EXTERNAL_SERVER_STORAGE_KEY = "h3ps-external-llama-server-v1";

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
  return mode === "Reference" || mode === "reference" ? "reference" : "standard";
}

export function currentSystemPromptOverride(state, mode = state.mode) {
  const profile = systemPromptProfile(mode);
  return Object.hasOwn(state.customSystemPrompts, profile)
    ? state.customSystemPrompts[profile]
    : null;
}

export function selectedExternalServer(state) {
  return state.selectedModel?.family === "external" ? state.externalServerConfig : null;
}

export function selectModelState(state, model) {
  state.selectedModel = model || null;
  state.audioSupported = model?.capabilities?.audio === true;
  if (model?.family === "external") state.settingsProvider = "external";
  else if (model?.family === "gguf") state.settingsProvider = "direct";
  if (model?.family === "external") {
    state.keepModelLoaded = false;
    state.modelLoaded = false;
  }
  return state;
}

function sharedInferencePayload(state) {
  return {
    session_id: state.sessionId,
    mode: state.mode,
    model_id: state.selectedModel?.id,
    external_server: selectedExternalServer(state),
    thinking: state.thinking,
    context_profile: state.contextProfile,
    kv_cache: state.kvCache,
    system_prompt_override: currentSystemPromptOverride(state),
    unload_after: !state.keepModelLoaded,
  };
}

export function buildGeneratePayload(state, { creativeBrief, seed }) {
  return {
    session_id: state.sessionId,
    mode: state.mode,
    duration_seconds: state.durationSeconds,
    aspect_ratio: state.aspectRatio,
    creative_brief: creativeBrief,
    model_id: state.selectedModel?.id,
    external_server: selectedExternalServer(state),
    thinking: state.thinking,
    context_profile: state.contextProfile,
    kv_cache: state.kvCache,
    system_prompt_override: currentSystemPromptOverride(state),
    seed,
    unload_after: !state.keepModelLoaded,
  };
}

export function buildRefinePayload(state, { currentPrompt, instruction, seed }) {
  return {
    ...sharedInferencePayload(state),
    current_prompt: currentPrompt,
    instruction,
    seed,
  };
}

export function createStudioState({ sessionId, storage = globalThis.localStorage }) {
  return {
    mode: "Reference",
    mediaFilter: "all",
    durationSeconds: 10,
    aspectRatio: "16:9",
    contextProfile: "auto",
    kvCache: "auto",
    thinking: false,
    keepModelLoaded: false,
    settingsProvider: "direct",
    settingsPromptProfile: "standard",
    modelLoaded: false,
    requestBusy: false,
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
    ggufRuntimeDiagnostics: null,
    runtimeWarningShown: false,
    refineRestore: null,
    lastModelPrompt: null,
    lastModelMeta: null,
    guides: [],
    draggedAssetId: null,
    dragGhost: null,
    customSystemPrompts: loadCustomSystemPrompts(storage),
    systemPromptDefaults: {},
  };
}
