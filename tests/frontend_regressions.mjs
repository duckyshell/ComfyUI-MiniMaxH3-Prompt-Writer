import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web/compat.js", import.meta.url), "utf8");
const encoded = Buffer.from(source).toString("base64");
const { createSessionId, isChoiceMenuInteraction, isGuideMenuInteraction, isRuntimeMenuInteraction, moveOntoTarget, replaceEventListener } = await import(`data:text/javascript;base64,${encoded}`);
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
  buildRefinePayload,
  createStudioState,
  currentSystemPromptOverride,
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

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    entries: () => Object.fromEntries(values),
  };
}

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
    [SYSTEM_PROMPT_STORAGE_KEY]: JSON.stringify({ standard: "Standard custom", reference: "Reference custom" }),
    [OLLAMA_MODEL_STORAGE_KEY]: "gemma4:12b",
  });

  assert.deepEqual(loadExternalServerConfig(storage), { url: "http://127.0.0.1:8080", model: "gemma.gguf" });
  assert.deepEqual(loadCustomSystemPrompts(storage), { standard: "Standard custom", reference: "Reference custom" });
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
    credential_source: "session",
    environment_name: "",
    gemini_reasoning_effort: "minimal",
    custom_images: true,
    custom_context_tokens: 32768,
    api_key: "must-not-be-stored",
  });
  const serialized = storage.entries()[API_PROVIDER_STORAGE_KEY];
  assert.doesNotMatch(serialized, /must-not-be-stored/);
  assert.deepEqual(loadApiProviderConfig(storage), {
    preset: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model_id: "provider/model",
    credential_source: "session",
    environment_name: "",
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
  assert.equal(state.ollamaContextProfile, undefined);
  assert.equal(state.keepModelLoaded, false);
  assert.equal(state.thinking, false);
  assert.equal(state.selectedModel, null);
  assert.deepEqual(state.assets, []);
});

test("standard mode drafts persist independently across reloads", () => {
  const storage = memoryStorage();
  saveModeDrafts(storage, {
    T2VA: { brief: "Text brief", prompt: "Text prompt" },
    I2VA: { brief: "Image brief", prompt: "Image prompt" },
    Reference: { brief: "must not persist", prompt: "must not persist" },
  });
  assert.deepEqual(loadModeDrafts(storage), {
    T2VA: { brief: "Text brief", prompt: "Text prompt" },
    I2VA: { brief: "Image brief", prompt: "Image prompt" },
  });
  assert.doesNotMatch(storage.entries()[MODE_DRAFTS_STORAGE_KEY], /must not persist|Reference/);
  assert.deepEqual(createStudioState({ sessionId: "drafts", storage }).modeDrafts.T2VA, { brief: "Text brief", prompt: "Text prompt" });
});

test("draft reset visibility is limited to dirty standard modes", () => {
  const defaults = { brief: "Default brief", prompt: "Default prompt" };
  assert.equal(isModeDraftDirty("T2VA", defaults, defaults), false);
  assert.equal(isModeDraftDirty("FL2VA", { ...defaults, brief: "Changed" }, defaults), true);
  assert.equal(isModeDraftDirty("Reference", { brief: "Changed", prompt: "Changed" }, defaults), false);
  assert.equal(isPersistedDraftMode("L2VA"), true);
  assert.equal(isPersistedDraftMode("Reference"), false);
});

test("draft reset restores only the selected standard mode", () => {
  const drafts = {
    T2VA: { brief: "Custom T2VA", prompt: "Custom T2VA" },
    I2VA: { brief: "Custom I2VA", prompt: "Custom I2VA" },
  };
  assert.deepEqual(resetModeDraft(drafts, "T2VA"), {
    I2VA: drafts.I2VA,
  });
  assert.equal(resetModeDraft(drafts, "Reference"), drafts);
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
  assert.equal(state.modelLoaded, false);
  assert.equal(state.audioSupported, false);
  assert.equal(state.settingsProvider, "external");
  assert.equal(state.settingsPromptProfile, "standard");
  assert.equal(systemPromptProfile("Reference"), "reference");
  assert.equal(systemPromptProfile("T2VA"), "standard");
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
  assert.deepEqual(buildRefinePayload(state, { currentPrompt: "Current", instruction: "Slower", seed: 99 }), {
    session_id: state.sessionId,
    mode: "Reference",
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
  assert.match(mainSource, /Run this from your ComfyUI Portable folder/);
  assert.match(mainSource, /Installation guide ↗/);
  assert.match(mainSource, /Troubleshooting guide ↗/);
  assert.match(mainSource, /llama-cpp-python is installed, but the runtime is not usable/);
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
  assert.doesNotMatch(markup, /data-memory-action/);
  assert.match(mainSource, /data-thinking/);
  assert.match(mainSource, /data-keep-loaded/);
  assert.match(mainSource, /data-memory-action/);
  assert.match(settingsSource, /title="Open model settings"/);
  assert.match(settingsSource, /data-active-runtime-summary>Runtime · Auto</);
  assert.match(mainSource, /"Server managed"/);
  assert.match(mainSource, /generate\(buildGeneratePayload\(studio/);
  assert.match(mainSource, /refine\(buildRefinePayload\(studio/);
});

test("Generate owns a compact standard-mode draft reset and leaves Reference out", () => {
  assert.match(mainSource, /data-draft-reset hidden/);
  assert.match(mainSource, /STANDARD_DEFAULT_BRIEF/);
  assert.match(mainSource, /STANDARD_DEFAULT_PROMPT/);
  assert.match(mainSource, /saveCurrentModeDraft\(\)/);
  assert.match(mainSource, /resetCurrentModeDraft/);
  assert.match(mainSource, /Draft reset to defaults/);
  assert.match(mainSource, /isPersistedDraftMode\(studio\.mode\)/);
  assert.match(mainSource, /studio\.referenceDraft = \{[\s\S]{0,240}lastModelPrompt/);
  assert.match(mainSource, /lastModelPrompt: SAMPLE_PROMPT/);
  assert.match(skinSource, /h3ps-draft-reset/);
});
