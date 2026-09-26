import "./focus_lifecycle.mjs";
import "./reference_labels.mjs";
import "./draft_files.mjs";
import "./desktop_notifications.mjs";
import { generationButtonMarkup } from "../web/writer_controls.js";
import { aspectRatioMarkup, splitMenuMarkup } from "../web/writer_controls.js";
import './media_visual.mjs';
import './sequence.mjs';
import "./writer_async.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./composer_geometry.mjs";
import "./editor_geometry.mjs";
import "./editor_interactions.mjs";
import "./media_tools.mjs";
import "./workflow_media.mjs";
import "./floating_media.mjs";

const source = await readFile(new URL("../web/compat.js", import.meta.url), "utf8");
const encoded = Buffer.from(source).toString("base64");
const { availableReferenceTags, comfyVramIsAlreadyEmpty, createSessionId, fileCountFromDataTransfer, insertReferenceAtCaret, isChoiceMenuInteraction, isGuideMenuInteraction, isRuntimeMenuInteraction, moveOntoTarget, replacementTargetForFileDrop, replaceEventListener, vramReleaseReachedTarget } = await import(`data:text/javascript;base64,${encoded}`);
const responseSource = await readFile(new URL("../web/api/response.js", import.meta.url), "utf8");
const responseEncoded = Buffer.from(responseSource).toString("base64");
const { readApiResponse } = await import(`data:text/javascript;base64,${responseEncoded}`);
const vramHandoffSource = await readFile(new URL("../web/vram_handoff.js", import.meta.url), "utf8");
const vramHandoffEncoded = Buffer.from(vramHandoffSource).toString("base64");
const {
  AUTO_VRAM_TOOLTIP,
  autoVramControlMarkup,
  createVramHandoffCoordinator,
  installVramHandoff,
  isLocalOllamaHost,
  releaseComfyVramWhenIdle,
  unloadWriterModels,
  writerResidencyTargets,
} = await import(`data:text/javascript;base64,${vramHandoffEncoded}`);
const stateSource = await readFile(new URL("../web/studio_state.js", import.meta.url), "utf8");
const stateEncoded = Buffer.from(stateSource).toString("base64");
const {
  EXTERNAL_SERVER_STORAGE_KEY,
  API_PROVIDER_STORAGE_KEY,
  DEFAULT_OLLAMA_HOST,
  OLLAMA_ENDPOINT_MODELS_STORAGE_KEY,
  OLLAMA_HOST_STORAGE_KEY,
  OLLAMA_MODEL_STORAGE_KEY,
  MODE_DRAFTS_STORAGE_KEY,
  SYSTEM_PROMPT_STORAGE_KEY,
  USER_PREFERENCES_STORAGE_KEY,
  buildGeneratePayload,
  buildLyricsRefinePayload,
  buildRefinePayload,
  audioWasAdded,
  clearPromptDraft,
  createStudioState,
  currentSystemPromptOverride,
  isGenerationModeAvailable,
  isTextOnlyDirectModel,
  loadCustomSystemPrompts,
  loadApiProviderConfig,
  loadExternalServerConfig,
  loadOllamaHost,
  loadOllamaModel,
  loadModeDrafts,
  loadUserPreferences,
  normalizeCustomFrameCount,
  saveCustomSystemPrompts,
  saveApiProviderConfig,
  saveExternalServerConfig,
  saveOllamaHost,
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
const composerSource = await readFile(new URL("../web/media_composer.js", import.meta.url), "utf8");
const styleModules = [
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
];
const styleSources = Object.fromEntries(await Promise.all(styleModules.map(async (name) => [
  name,
  await readFile(new URL(`../web/styles/${name}.css`, import.meta.url), "utf8"),
])));
const stylesSource = styleModules.map((name) => styleSources[name]).join("\n");
const skinSource = ["tokens", "themes/dark", "themes/light", "shell", "workbench", "media", "composer", "settings", "models", "providers", "prompts", "overlays", "music", "responsive"]
  .map((name) => styleSources[name])
  .join("\n");
const componentStyleNames = styleModules.filter((name) => !name.startsWith("themes/") && name !== "tokens");

// Legacy opaque literals are kept only until the affected special-case CSS is retired.
// Alpha colors and artwork/overlay/reference selectors are intentionally handled below.
const HARDCODED_COLOR_WHITELIST = new Set([
  "#3b4048", "#484850", "#494951", "#4d4d55", "#4f4f57", "#595961", "#595962", "#62626b",
  "#686871", "#6d6d76", "#707680", "#737b87", "#7f8d9d", "#ee7049", "#fff", "#fff0eb",
]);

const HARDCODED_COLOR_SPECIAL_CASE = /(?:rgba?|hsla?|gradient|shadow|backdrop|preview|reference|mark|asset|frame|drag|toast|spinner|primary-button|disabled|drop-before|drop-after)/i;
const INTERFACE_FIXED_FONT_SELECTOR = /(?:h3ps-section-heading|h3ps-section-hint|h3ps-clear-control|h3ps-output-actions|h3ps-memory-action|h3ps-toggle-control|h3ps-primary-button|h3ps-settings-heading)/i;

function hardcodedColorRecords(source) {
  return [...source.matchAll(/#[0-9a-f]{3,8}\b|\b(?:white|black)(?=\s*[;,)])/gi)].map((match) => {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineEnd = source.indexOf("\n", match.index);
    return { value: match[0].toLowerCase(), line: source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd) };
  });
}

function fixedFontSizeViolations(source) {
  const violations = [];
  for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1].trim();
    for (const declaration of block[2].matchAll(/font-size\s*:\s*([^;}]*)/g)) {
      const value = declaration[1].trim();
      const tokenized = /var\(--h3ps-(?:font|toast-font|interface-scale)/.test(value);
      const relative = /^[-+]?\d*\.?\d+(?:em|rem|%)$/.test(value) || value === "0";
      if (!tokenized && !relative && !INTERFACE_FIXED_FONT_SELECTOR.test(selector)) {
        violations.push(`${selector} -> ${value}`);
      }
    }
  }
  return violations;
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    entries: () => Object.fromEntries(values),
  };
}

test("frontend styles load as ordered modules with scoped dark and light themes", () => {
  assert.match(mainSource, /const STYLE_MODULES = \[[\s\S]+"tokens"[\s\S]+"themes\/dark"[\s\S]+"themes\/light"[\s\S]+"responsive"/);
  assert.ok(mainSource.indexOf('"settings"') < mainSource.indexOf('"models"'));
  assert.match(mainSource, /\.\/styles\/\$\{name\}\.css/);
  assert.doesNotMatch(mainSource, /\.\/skin\.css|\.\/styles\.css/);
  assert.match(styleSources["themes/dark"], /--h3ps-bg:/);
  assert.match(styleSources["themes/light"], /\.h3ps-root\[data-theme="light"\]\s*\{[\s\S]*--h3ps-bg:\s*#f5f7fa;/);
  assert.doesNotMatch(styleSources["themes/light"], /(^|\n)\s*(?:html|body|:root)\b/);
  assert.doesNotMatch(styleSources.tokens, /--h3ps-bg:/);
});

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

test("VRAM handoff targets only Writer-managed Direct and retained Ollama models", () => {
  assert.deepEqual(writerResidencyTargets({
    prompt_residency: {
      direct: { loaded: true, model_id: "writer.gguf" },
      ollama: { targets: [
        { model_id: "gemma4:test", endpoint: "http://127.0.0.1:11434" },
        { model_id: "gemma4:test", endpoint: "http://127.0.0.1:11434" },
        { model_id: "remote:test", endpoint: "http://ollama.example:11434" },
      ] },
    },
  }, "http://127.0.0.1:11434"), [
    { family: "gguf", model_id: "writer.gguf" },
    { family: "ollama", model_id: "gemma4:test", ollama_host: "http://127.0.0.1:11434" },
  ]);
  assert.equal(isLocalOllamaHost("http://localhost:11434"), true);
  assert.equal(isLocalOllamaHost("http://[::1]:11434"), true);
  assert.equal(isLocalOllamaHost("http://192.168.0.30:11434"), false);
});

test("VRAM handoff waits for targeted Writer models to leave residency", async () => {
  const resident = {
    prompt_residency: {
      direct: { loaded: true, model_id: "writer.gguf" },
      ollama: { targets: [{ model_id: "gemma4:test", endpoint: "http://127.0.0.1:11434" }] },
    },
  };
  const released = { prompt_residency: { direct: { loaded: false }, ollama: { targets: [] } } };
  const statuses = [resident, released];
  const unloaded = [];
  const targets = await unloadWriterModels({
    getStatus: async () => statuses.shift() || released,
    unloadModel: async (target) => { unloaded.push(target); return { unload_requested: true }; },
    ollamaHost: "http://127.0.0.1:11434",
    sleep: async () => {},
  });
  assert.deepEqual(unloaded, targets);
  assert.deepEqual(unloaded, [
    { family: "gguf", model_id: "writer.gguf" },
    { family: "ollama", model_id: "gemma4:test", ollama_host: "http://127.0.0.1:11434" },
  ]);
});

test("Auto VRAM skips empty ComfyUI and otherwise confirms stable /free release", async () => {
  let freeCalls = 0;
  const alreadyEmpty = await releaseComfyVramWhenIdle({
    getStatus: async () => ({
      comfyui: { available: true, queue_running: 0, queue_pending: 0, loaded_models: 0 },
      gpu_memory: { free_mb: 12000 },
    }),
    freeComfyVram: async () => { freeCalls += 1; },
  });
  assert.equal(freeCalls, 0);
  assert.equal(alreadyEmpty.comfyui.loaded_models, 0);

  const freeReadings = [12000, 12016];
  const statuses = [
    { comfyui: { available: true, queue_running: 0, queue_pending: 0, loaded_models: 1 }, gpu_memory: { free_mb: 8000 } },
    ...freeReadings.map((free_mb) => ({
      comfyui: { available: true, queue_running: 0, queue_pending: 0, loaded_models: 0 },
      gpu_memory: { free_mb },
    })),
  ];
  const result = await releaseComfyVramWhenIdle({
    getStatus: async () => statuses.shift(),
    freeComfyVram: async () => { freeCalls += 1; },
    sleep: async () => {},
  });
  assert.equal(freeCalls, 1);
  assert.equal(result.comfyui.loaded_models, 0);

  freeCalls = 0;
  await assert.rejects(releaseComfyVramWhenIdle({
    getStatus: async () => ({
      comfyui: { available: true, queue_running: 1, queue_pending: 0, loaded_models: 1 },
      gpu_memory: { free_mb: 8000 },
    }),
    freeComfyVram: async () => { freeCalls += 1; },
  }), { code: "COMFYUI_BUSY" });
  assert.equal(freeCalls, 0);
});

test("Auto VRAM aborts Writer preparation when Queue wins the race", async () => {
  let current = true;
  await assert.rejects(releaseComfyVramWhenIdle({
    getStatus: async () => ({
      comfyui: { available: true, queue_running: 0, queue_pending: 0, loaded_models: 1 },
      gpu_memory: { free_mb: 12000 },
    }),
    freeComfyVram: async () => { current = false; },
    isCurrent: () => current,
  }), { code: "WRITER_PREPARATION_CANCELLED" });
});

test("VRAM handoff shares preparation without replacing native Queue semantics", async () => {
  const order = [];
  const app = {
    async queuePrompt(value) { order.push(`queue:${value}`); return true; },
  };
  let enabled = false;
  let failures = 0;
  let releaseHandoff;
  installVramHandoff(app, {
    isEnabled: () => enabled,
    beforeQueue: async () => {
      order.push("unload");
      await new Promise((resolve) => { releaseHandoff = resolve; });
    },
    onError: () => { failures += 1; },
  });

  assert.equal(await app.queuePrompt(1), true);
  enabled = true;
  const second = app.queuePrompt(2);
  const third = app.queuePrompt(3);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["queue:1", "unload"]);
  releaseHandoff();
  assert.deepEqual(await Promise.all([second, third]), [true, true]);
  assert.deepEqual(order, ["queue:1", "unload", "queue:2", "queue:3"]);

  installVramHandoff(app, {
    isEnabled: () => true,
    beforeQueue: async () => { throw new Error("unload failed"); },
    onError: () => { failures += 1; },
  });
  const failedA = app.queuePrompt(4);
  const failedB = app.queuePrompt(5);
  assert.deepEqual(await Promise.all([failedA, failedB]), [true, true]);
  assert.equal(failures, 1);
  assert.deepEqual(order, ["queue:1", "unload", "queue:2", "queue:3", "queue:4", "queue:5"]);
  installVramHandoff(app, {
    isEnabled: () => true, timeoutMs: 5,
    beforeQueue: () => new Promise(() => {}),
    onError: () => { failures += 1; },
  });
  assert.equal(await app.queuePrompt(6), true);
  assert.equal(failures, 2);
  assert.equal(order.at(-1), "queue:6");
});

test("Queue invalidates Writer attempts synchronously and tracked requests remain awaitable", async () => {
  const coordinator = createVramHandoffCoordinator();
  const token = coordinator.beginWriterAttempt();
  assert.equal(coordinator.isWriterAttemptCurrent(token), true);
  coordinator.invalidateWriterAttempts();
  assert.equal(coordinator.isWriterAttemptCurrent(token), false);
  coordinator.finishQueueHandoff();
  assert.equal(coordinator.isWriterAttemptCurrent(token), false);

  let finish;
  const request = coordinator.trackWriterRequest(new Promise((resolve) => { finish = resolve; }));
  assert.equal(coordinator.activeWriterRequest(), request);
  finish("done");
  assert.equal(await request, "done");
  assert.equal(coordinator.activeWriterRequest(), null);
});

test("Auto VRAM markup is absent outside ComfyUI and carries the approved tooltip", () => {
  assert.equal(autoVramControlMarkup(false), "");
  const markup = autoVramControlMarkup(true);
  assert.match(markup, />Auto VRAM<\/label>/);
  assert.match(markup, new RegExp(AUTO_VRAM_TOOLTIP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("Ollama host and selected models persist independently per endpoint", () => {
  const storage = memoryStorage();
  const first = "http://192.168.1.20:11434";
  const second = "http://192.168.1.21:11434";

  assert.equal(loadOllamaHost(storage), DEFAULT_OLLAMA_HOST);
  saveOllamaHost(storage, `${first}/`);
  saveOllamaModel(storage, "gemma4:first", first);
  saveOllamaModel(storage, "gemma4:second", second);

  assert.equal(loadOllamaHost(storage), first);
  assert.equal(loadOllamaModel(storage, first), "gemma4:first");
  assert.equal(loadOllamaModel(storage, second), "gemma4:second");
  assert.equal(loadOllamaModel(storage, DEFAULT_OLLAMA_HOST), null);
  assert.equal(storage.entries()[OLLAMA_HOST_STORAGE_KEY], first);
  assert.deepEqual(JSON.parse(storage.entries()[OLLAMA_ENDPOINT_MODELS_STORAGE_KEY]), {
    [first]: "gemma4:first",
    [second]: "gemma4:second",
  });

  const state = createStudioState({ sessionId: "remote-host", storage });
  assert.equal(state.ollamaHost, first);
  assert.equal(state.ollamaModelName, "gemma4:first");
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
    directContextTokens: 20000,
    directKvCache: "q8",
    directGenerationBudget: "custom",
    directGenerationBudgetTokens: 6000,
    directReasoningEffort: "medium",
    musicLyricsUseBrief: false,
    fullscreen: true,
    vramHandoff: true,
    theme: "light",
    interfaceSize: "125",
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
    direct_context_tokens: 20000,
    direct_kv_cache: "q8",
    direct_generation_budget: "custom",
    direct_generation_budget_tokens: 6000,
    ollama_generation_budget: "auto",
    ollama_generation_budget_tokens: null,
    direct_reasoning_effort: "medium",
    music_lyrics_use_brief: false,
    fullscreen: true,
    vram_handoff: true,
    theme: "light",
    interface_size: "125",
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
      theme: "sepia",
      interface_size: "140",
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
    direct_context_tokens: null,
    direct_kv_cache: "auto",
    direct_generation_budget: "auto",
    direct_generation_budget_tokens: null,
    ollama_generation_budget: "auto",
    ollama_generation_budget_tokens: null,
    direct_reasoning_effort: "auto",
    music_lyrics_use_brief: true,
    fullscreen: false,
    vram_handoff: false,
    theme: "dark",
    interface_size: "100",
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
      direct_context_tokens: 20000,
      direct_kv_cache: "q8",
      direct_generation_budget: "4096",
      direct_reasoning_effort: "low",
      fullscreen: true,
      vram_handoff: true,
      theme: "light",
      interface_size: "120",
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
  assert.equal(state.directContextTokens, 20000);
  assert.equal(state.directKvCache, "q8");
  assert.equal(state.directGenerationBudget, "4096");
  assert.equal(state.directReasoningEffort, "low");
  assert.equal(state.musicLyricsUseBrief, true);
  assert.equal(state.fullscreen, true);
  assert.equal(state.vramHandoff, true);
  assert.equal(state.theme, "light");
  assert.equal(state.interfaceSize, "120");
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
  assert.equal(clean.vramHandoff, false);
  assert.equal(clean.theme, "dark");
  assert.equal(clean.interfaceSize, "100");

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

test("mode drafts round trip prompts longer than 16k without truncation", () => {
  const storage = memoryStorage();
  const prompt = "Long prompt 🙂\n".repeat(2000);
  saveModeDrafts(storage, { Reference: { brief: "brief", prompt } });
  assert.equal(loadModeDrafts(storage).Reference.prompt, prompt);
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

test("clear prompts removes brief and generated output while preserving lyrics and extra draft state", () => {
  assert.deepEqual(clearPromptDraft({
    brief: "Keep the camera static.",
    prompt: "Generated prompt",
    lyrics: "[Verse]\nKeep these lyrics",
    marker: "preserved",
  }), {
    brief: "",
    prompt: "",
    lyrics: "[Verse]\nKeep these lyrics",
    marker: "preserved",
  });
  assert.match(mainSource, /data-clear-media><strong>Clear media<\/strong>/);
  assert.match(mainSource, /data-clear-prompts><strong>Clear prompts<\/strong><small>Keep media<\/small>/);
  assert.match(mainSource, /data-clear-all><strong>Clear all<\/strong><small>Media and prompts<\/small>/);
  assert.match(mainSource, /if \(!await clearCurrentMedia\(\{ notify: false \}\)\) return;/);
  assert.match(stylesSource, /\.h3ps-clear-control \{[^}]*display: inline-flex;[^}]*border-radius: 7px;/);
  assert.match(stylesSource, /\.h3ps-clear-menu \{[^}]*right: -20px;[^}]*width: max-content;[^}]*max-width: calc\(100vw - 24px\);/);
  assert.match(stylesSource, /\.h3ps-clear-menu button \{[^}]*display: grid;[^}]*min-height: calc\(42px \* var\(--h3ps-interface-scale\)\);/);
  assert.match(stylesSource, /\.h3ps-clear-menu button strong \{[^}]*font-size: 1em;[^}]*letter-spacing: normal;/);
});

test("custom contact sheet counts accept only whole values from 2 through 24", () => {
  assert.equal(normalizeCustomFrameCount("2"), "2");
  assert.equal(normalizeCustomFrameCount(16), "16");
  for (const value of [1, 25, 2.5, "2.5", "custom", ""]) {
    assert.equal(normalizeCustomFrameCount(value), null);
  }
});

test("long video drafts remain intact while Music keeps 2000", () => {
  const storage = memoryStorage();
  saveModeDrafts(storage, {
    T2VA: { brief: "v".repeat(40000), prompt: "Video prompt" },
    Music3: { brief: "m".repeat(8000), prompt: "Music prompt", lyrics: "Lyrics" },
  });
  const drafts = loadModeDrafts(storage);
  assert.equal(drafts.T2VA.brief.length, 40000);
  assert.equal(drafts.Music3.brief.length, 2000);
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

test("Reference assets replace one dropped file and append multiple dropped files", () => {
  assert.match(mainSource, /class="h3ps-replace-asset"[^>]*data-replace-asset="\$\{asset\.id\}"[^>]*aria-label="Replace[^>]*>\$\{icon\("refresh", 12\)\}<\/button>/);
  assert.match(mainSource, /class="h3ps-remove-asset"[^>]*data-remove-asset="\$\{asset\.id\}"/);
  assert.doesNotMatch(mainSource, /data-asset-menu|data-asset-menu-toggle|data-preview-asset|icon\("dots"/);
  assert.doesNotMatch(mainSource, /asset\.mode !== "Reference"[^\n]+data-replace-asset/);
  assert.match(mainSource, /input\.multiple = !replaceAssetId/);
  assert.match(mainSource, /button\.blur\(\);\s*chooseMedia\(mode, button\.dataset\.replaceAsset\)/);
  assert.match(mainSource, /is-file-replace-target/);
  assert.doesNotMatch(mainSource, /Choose one replacement/);
  assert.match(mainSource, /uploadFiles\(mode, files, replacementTargetForFileDrop\(targetId, files\.length\)\)/);

  assert.equal(fileCountFromDataTransfer({ items: [{ kind: "file" }] }), 1);
  assert.equal(fileCountFromDataTransfer({ items: [{ kind: "file" }, { kind: "file" }] }), 2);
  assert.equal(fileCountFromDataTransfer({ files: [{}, {}, {}] }), 3);
  assert.equal(replacementTargetForFileDrop("asset-2", 1), "asset-2");
  assert.equal(replacementTargetForFileDrop("asset-2", 2), null);
});

test("media card overlays stay inside the thumbnail and below previews", () => {
  assert.match(stylesSource, /\.h3ps-duration\s*\{[^}]*position:\s*absolute;[^}]*right:\s*7px;[^}]*bottom:\s*49px;/);
  assert.match(stylesSource, /\.h3ps-replace-asset, \.h3ps-remove-asset \{[^}]*width:\s*22px;[^}]*height:\s*22px;/);
  assert.match(stylesSource, /\.h3ps-root \.h3ps-replace-asset svg, \.h3ps-root \.h3ps-remove-asset svg \{ width:12px; height:12px; \}/);
  assert.match(stylesSource, /\.h3ps-replace-asset \{[^}]*top:\s*32px;[^}]*right:\s*6px;/);
  assert.match(stylesSource, /\.h3ps-asset:hover \.h3ps-replace-asset[^}]*opacity:\s*1;/);
  assert.match(stylesSource, /\.h3ps-asset:hover \.h3ps-remove-asset[^}]*opacity:\s*1;/);
  assert.doesNotMatch(stylesSource, /\.h3ps-asset:focus-within \.h3ps-(?:replace|remove)-asset/);
  assert.doesNotMatch(stylesSource, /\.h3ps-more|\.h3ps-asset-menu/);
});

test("Actions keeps media tools ordered and explains unavailable states without hiding Compose", async () => {
  const { mediaVisualDescriptor } = await import("../web/media_visual.js");
  const markup = mainSource.slice(mainSource.indexOf('${splitMenuMarkup(icon, {label: "Actions"'), mainSource.indexOf('<p class="h3ps-section-hint"'));
  assert.match(markup, /data-media-panel-action[\s\S]*data-open-composer[\s\S]*<hr data-compose-separator>[\s\S]*data-clear-media[\s\S]*data-clear-prompts[\s\S]*data-clear-all/);
  assert.doesNotMatch(markup, /data-open-composer[^>]*hidden|data-compose-separator[^>]*hidden/);
  assert.match(stylesSource, /\.h3ps-clear-menu button:disabled \{ opacity: .45; cursor: default;/);
  const panel = {}, compose = {};
  const studio = { mode: "Reference", assets: [], requestBusy: false, root: {
    querySelector: selector => selector === "[data-media-panel-action]" ? panel : compose,
  } };
  const controlSource = mainSource.slice(mainSource.indexOf("function referenceComposerAssets("), mainSource.indexOf("async function addComposedPicture("));
  const sync = new Function("studio", "mediaVisualDescriptor", controlSource + ";return syncComposerControl;")(studio, mediaVisualDescriptor);
  sync();
  assert.equal(panel.disabled, true); assert.equal(panel.title, "Add media first");
  assert.equal(compose.disabled, true); assert.equal(compose.title, "Add a Picture or Video first");
  studio.assets = [{ type: "audio", mode: "Reference", content_url: "audio" }];
  sync(); assert.equal(panel.disabled, false); assert.equal(compose.disabled, true);
  studio.assets.push({ type: "video", mode: "Reference", content_url: "video" });
  sync(); assert.equal(compose.disabled, true);
  studio.assets[1].contact_sheet_url = "sheet";
  sync(); assert.equal(compose.disabled, false);
  studio.requestBusy = true;
  sync(); assert.equal(compose.disabled, true); assert.match(compose.title, /Wait/);
  studio.requestBusy = false;
  for (const mode of ["T2VA", "I2VA", "FL2VA", "Music3"]) {
    sync(mode); assert.equal(compose.disabled, true); assert.match(compose.title, /Reference/);
    assert.equal(panel.disabled, false); assert.equal(compose.hidden, undefined);
  }
  studio.assets = Array.from({length:9}, () => ({type:"image", mode:"Reference", content_url:"picture"}));
  sync(); assert.equal(compose.disabled, false); // The full Picture quota still permits copy and download.
  studio.assets = [];
  sync(); assert.equal(panel.disabled, true); assert.equal(compose.disabled, true);
});

test("Media Composer creates an independent Picture from prepared visual sources", () => {
  assert.match(mainSource, /await import\("\.\/media_composer\.js"\)/);
  assert.match(mainSource, /"media",\s*"composer",\s*"editor",\s*"floating-media",\s*"settings"/);
  assert.match(mainSource, /data-open-composer disabled/);
  assert.match(mainSource, /uploadMedia\(studio\.sessionId, "Reference", \[file\]\)/);
  assert.match(mainSource, /studio\.assets = \[\.\.\.studio\.assets, \.\.\.result\.assets\]/);
  assert.match(mainSource, /pictureCount >= 9/);
  assert.match(mainSource, /assets\.length >= 12/);
  assert.match(composerSource, /mediaVisualDescriptor as defaultVisualDescriptor/);
  assert.match(composerSource, /asset\.contact_sheet_url/);
  assert.match(composerSource, /ctx\.drawImage\(bitmap,it\.x,it\.y,it\.w,it\.h\)/);
  assert.doesNotMatch(composerSource, /\bCover\b|background selector|transform:\s*scale/);
  assert.match(composerSource, /\["auto", "Auto"\]/);
  assert.match(composerSource, /data-value="auto">Auto<\/button><button type="button" data-value="2">2 cols<\/button><button type="button" data-value="3">3 cols<\/button><button type="button" data-value="grid">Grid<\/button>/);
  assert.match(composerSource, /if\(d\.type==="resize"\)[\s\S]{0,240}d\.it\.weight=/);
  assert.match(composerSource, /if \(r\) \{ W=Math\.max\(reqW, reqH\*r\)/);
  assert.match(composerSource, /drawOutput\(canvas\.getContext\("2d"\),r\.W,r\.H,false\)/);
  assert.match(composerSource, /data-copy[^>]*aria-label="Copy PNG">\$\{i\("copy", 14\)\}<\/button>/);
  assert.match(composerSource, /ClipboardItem\(\{"image\/png":png\}\)/);
  assert.match(composerSource, /data-download[^>]*>\$\{i\("download", 13\)\}Download<\/button>/);
  assert.match(composerSource, /URL\.createObjectURL\(payload\.blob\)/);
  assert.doesNotMatch(composerSource, /showReferenceLabels|referenceLabelRect|drawReferenceLabels|data-reference-labels/);
  assert.doesNotMatch(composerSource, /data-label-layer/);
  assert.match(composerSource, /b\.disabled=!layoutAvailable\(b\.dataset\.value\)/);
  assert.match(composerSource, /pad=Math\.max\(10,c\?\.fontSize\*\.45\|\|0\)/);
  assert.match(composerSource, /requestAnimationFrame\(positionCaptionUI\)/);
  assert.match(styleSources.composer, /caption-inline textarea\{[^}]*color:var\(--h3ps-canvas-text\)/);
  assert.match(styleSources.composer, /\.h3ps-cmp-source\{cursor:grab/);
  assert.doesNotMatch(styleSources.composer, /\.h3ps-cmp-source\{height:104px/);
});

test("VRAM retry waits for the required free-memory target", () => {
  assert.equal(vramReleaseReachedTarget(4_000, 9_999, 10_000), false);
  assert.equal(vramReleaseReachedTarget(4_000, 10_000, 10_000), true);
  assert.equal(vramReleaseReachedTarget(4_000, 4_063), false);
  assert.equal(vramReleaseReachedTarget(4_000, 4_064), true);
});

test("manual VRAM release skips polling when idle ComfyUI has no loaded models", () => {
  assert.equal(comfyVramIsAlreadyEmpty({
    comfyui: { available: true, queue_running: 0, queue_pending: 0, loaded_models: 0 },
  }), true);
  assert.equal(comfyVramIsAlreadyEmpty({
    comfyui: { available: true, queue_running: 1, queue_pending: 0, loaded_models: 0 },
  }), false);
  assert.equal(comfyVramIsAlreadyEmpty({
    comfyui: { available: true, queue_running: 0, queue_pending: 0, loaded_models: 1 },
  }), false);
  assert.equal(comfyVramIsAlreadyEmpty({
    comfyui: { available: false, queue_running: 0, queue_pending: 0, loaded_models: 0 },
  }), false);
  assert.match(mainSource, /typeof retry !== "function" && requiredFree == null && comfyVramIsAlreadyEmpty\(before\)/);
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

test("External llama.cpp keeps reasoning under server control", () => {
  assert.match(mainSource, /externalManaged = studio\.selectedModel\?\.family === "external"/);
  assert.match(mainSource, /Thinking is controlled by the external llama\.cpp server\./);
  assert.match(mainSource, /--reasoning on --reasoning-effort low/);
  assert.match(mainSource, /external \? null : `Thinking/);
  assert.match(stateSource, /state\.selectedModel\?\.family === "external" \? false : state\.thinking/);
});

test("External llama.cpp offers capability-driven two-way Auto VRAM", () => {
  assert.match(mainSource, /\["gguf", "external"\]\.includes\(model\?\.family\)/);
  assert.match(AUTO_VRAM_TOOLTIP, /lifecycle-capable External llama\.cpp routers/);

  const queueHandoffStart = mainSource.indexOf("async function unloadWriterModelsBeforeQueue(signal)");
  const queueHandoffEnd = mainSource.indexOf("\nfunction showVramHandoffQueueError", queueHandoffStart);
  assert.ok(queueHandoffStart >= 0 && queueHandoffEnd > queueHandoffStart);
  const queueHandoffSource = mainSource.slice(queueHandoffStart, queueHandoffEnd);
  assert.match(queueHandoffSource, /activeFamily === "gguf"/);
  assert.match(queueHandoffSource, /activeFamily === "ollama"/);
  assert.match(queueHandoffSource, /activeFamily === "external" && studio\?\.selectedModel\?\.lifecycle_supported/);
});

test("verified router manual Unload stays visible across residency refreshes",()=>{
  const start=mainSource.indexOf('function lifecycleTargets()'), end=mainSource.indexOf('function syncLifecycleActions',start);
  const render=new Function('studio','escapeHtml',mainSource.slice(start,end)+'; return lifecycleTargets().map(t=>lifecycleButtonMarkup(t)).join("");');
  const id='external::local::writer';
  for (const [state,owned,enabled] of [['loaded',true,true],['sleeping',false,true],['loading',true,false],['unloading',true,false],['unloaded',false,false],['unknown',true,true],['unknown',false,false]]) {
    const html=render({selectedModel:{id,family:'external',lifecycle_supported:true},promptResidency:{direct:null,ollama:[],external:[{model_id:id,state,writer_owned:owned}]}},String);
    assert.equal((html.match(/data-lifecycle-family=/g)||[]).length,1);
    assert.equal(html.includes(' disabled '),!enabled,state);
  }
  assert.match(render({selectedModel:{id,family:'external',lifecycle_supported:true},promptResidency:{direct:null,ollama:[],external:[]}},String),/disabled/);
});

test("External queue handoff waits for exact unloaded status and fails closed on lost status",async()=>{
  const modelId='external::local::writer',target={family:'external',model_id:modelId},calls=[];
  const status=state=>({prompt_residency:{external:{targets:[{model_id:modelId,state,writer_owned:true}]}}});
  const samples=[status('loaded'),status('loading'),status('unloaded')];
  const result=await unloadWriterModels({getStatus:async()=>samples.shift(),unloadModel:async t=>{calls.push(t);return {unload_requested:true};},sleep:async()=>{}});
  assert.deepEqual(result,[target]);assert.deepEqual(calls,[target]);
  await assert.rejects(()=>unloadWriterModels({
    getStatus:async()=>status('unknown'),requiredTargets:[target],unloadModel:async()=>({unload_requested:true}),sleep:async()=>{},maxPolls:1,
  }),error=>error.code==='WRITER_UNLOAD_TIMEOUT');
  await assert.rejects(()=>unloadWriterModels({
    getStatus:async()=>status('loaded'),unloadModel:async()=>({unload_requested:false}),
  }),error=>error.code==='WRITER_UNLOAD_FAILED');
});

test("text-only Direct models expose T2VA and Music3", () => {
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
  assert.equal(isGenerationModeAvailable(textOnly, "Music3"), true);
  for (const mode of ["I2VA", "FL2VA", "L2VA", "Reference"]) {
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
    ollama_host: null,
    api_provider: null,
    thinking: false,
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
    ollama_host: null,
    api_provider: null,
    thinking: false,
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
  assert.equal(ollamaPayload.ollama_host, DEFAULT_OLLAMA_HOST);
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

  selectModelState(state, { id: "direct.gguf", family: "gguf", capabilities: { audio: false } });
  state.contextProfile = "custom";
  state.contextTokens = 20000;
  state.kvCache = "q8";
  state.generationBudget = "custom";
  state.generationBudgetTokens = 6000;
  state.reasoningEffort = "medium";
  const directPayload = buildGeneratePayload(state, { creativeBrief: "Direct brief", seed: 1 });
  assert.equal(directPayload.context_profile, "custom");
  assert.equal(directPayload.context_tokens, 20000);
  assert.equal(directPayload.generation_budget, 6000);
  assert.equal(directPayload.reasoning_effort, "medium");
  state.thinking = false;
  assert.equal(Object.hasOwn(buildGeneratePayload(state, { creativeBrief: "Direct brief", seed: 2 }), "reasoning_effort"), false);
});

test("Ollama remote host controls stay collapsed and disclosure state survives refresh renders", () => {
  assert.match(mainSource, /data-ollama-host-settings[^>]*\$\{studio\.ollamaHostSettingsOpen \? "open" : ""\}/);
  assert.match(mainSource, /data-ollama-host-form/);
  assert.match(mainSource, /getOllamaStatus\(studio\.ollamaHost\)/);
  assert.match(mainSource, /saveOllamaHost\(localStorage, endpoint\)/);
  assert.match(mainSource, /studio\.promptResidency\.ollama = \[\]/);
  assert.match(mainSource, /data-ollama-storage-help \$\{studio\.ollamaStorageHelpOpen \? "open" : ""\}/);
  assert.match(mainSource, /studio\.ollamaStorageHelpOpen = !ollamaStorageSummary\.closest\("details"\)\.open/);
  assert.match(skinSource, /\.h3ps-ollama-host-settings/);
});

test("automatic Ollama refresh renders preserve the unsaved host field value", () => {
  assert.match(mainSource, /const ollamaHostDraft = studio\.root\.querySelector\('\[data-ollama-host-form\] input\[name="host"\]'\)\?\.value/);
  assert.match(mainSource, /renderOllamaProviderControl\(ollamaHostDraft\)/);
  assert.match(mainSource, /ollamaHostControlMarkup\(hostValue = studio\.ollamaHost\)/);
  assert.match(mainSource, /value="\$\{escapeHtml\(hostValue\)\}"/);
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
  assert.doesNotMatch(markup, /<strong>Context<\/strong>/);
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
  assert.match(mainSource, /runtimeSettings\.hidden = !\["direct", "ollama"\]\.includes\(provider\)/);
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
  assert.match(skinSource, /h3ps-root \.h3ps-ollama-add-model-toggle[^}]+color: var\(--h3ps-accent-strong\)[^}]+font-size: var\(--h3ps-font-label-sm\)[^}]+cursor: pointer/);
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
  assert.match(skinSource, /\.h3ps-assets:has\(> \.h3ps-empty-drop:only-child\) \{ grid-template-columns: minmax\(0, 1fr\); \}/);
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
  assert.match(mainSource, /autoVramControlMarkup\(VRAM_HANDOFF_SUPPORTED\)/);
  assert.match(vramHandoffSource, />Auto VRAM<\/label>/);
  assert.match(vramHandoffSource, /data-vram-handoff-control/);
  assert.match(mainSource, /isLocalOllamaHost\(studio\.ollamaHost\)/);
  assert.match(mainSource, /VRAM_HANDOFF_SUPPORTED = typeof app\?\.queuePrompt === "function"/);
  assert.match(mainSource, /installVramHandoff\(app/);
  assert.match(mainSource, /releaseComfyVramWhenIdle\(\{/);
  assert.match(mainSource, /onQueueRequested: \(\) => vramHandoffCoordinator\.invalidateWriterAttempts\(\)/);
  assert.match(mainSource, /data-comfy-memory-action/);
  const freeVramStart = mainSource.indexOf("async function releaseComfyVram");
  const freeVramEnd = mainSource.indexOf("function showVramRetry", freeVramStart);
  const freeVramSource = mainSource.slice(freeVramStart, freeVramEnd);
  assert.match(freeVramSource, /finally\s*\{[\s\S]*button\.disabled = false;[\s\S]*button\.innerHTML = `\$\{icon\("memory", 15\)\}Free ComfyUI VRAM`;/);
  assert.match(freeVramSource, /requiredFreeMb/);
  assert.match(freeVramSource, /targetReached/);
  assert.doesNotMatch(freeVramSource, /if \(typeof retry === "function"\) \{\s*shouldRetry = true/);
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
  assert.match(settingsSource, /data-runtime-option="context" data-value="custom">Custom</);
  assert.match(settingsSource, /Generation budget/);
  assert.match(settingsSource, /data-direct-runtime-advanced[\s\S]*KV cache[\s\S]*Generation budget/);
  assert.match(settingsSource, /data-reasoning-effort-control hidden/);
  assert.match(settingsSource, /data-direct-advanced-summary>Auto</);
  assert.match(settingsSource, /data-value="2048">2K</);
  assert.match(settingsSource, /data-value="4096">4K</);
  assert.match(settingsSource, /data-value="8192">8K</);
  assert.doesNotMatch(settingsSource, /data-runtime-summary/);
  assert.doesNotMatch(settingsSource, />Custom (Context|Generation budget)</);
  assert.match(mainSource, /reasoning_effort_values/);
  assert.match(mainSource, /reasoningControl\.hidden = values\.length === 0/);
  assert.match(mainSource, /Number\(studio\.reasoningEffort !== "auto" && values\.includes\(studio\.reasoningEffort\)\)/);
  assert.match(mainSource, /generationBudgetOverride = studio\.generationBudget !== "auto"/);
  assert.match(mainSource, /overrideCount = Number\(studio\.kvCache !== "auto"\)/);
  assert.match(mainSource, /Number\.isInteger\(studio\.generationBudgetTokens\)/);
  assert.match(mainSource, /overrideCount === 1 \? "" : "s"/);
  assert.match(stylesSource, /\.h3ps-runtime-picker \{ position:relative/);
  assert.match(stylesSource, /--h3ps-runtime-field-width:132px/);
  assert.match(stylesSource, /\.h3ps-runtime-custom input \{[^}]*width:12ch[^}]*appearance:textfield/);
  assert.match(stylesSource, /::-webkit-inner-spin-button[^}]*appearance:none/);
  assert.match(stylesSource, /top:calc\(100% \+ 5px\)/);
  assert.match(stylesSource, /\.h3ps-direct-advanced > summary:hover/);
  assert.match(stylesSource, /\.h3ps-runtime-control \{[^}]*border:0;[^}]*background:transparent;/);
  assert.match(stylesSource, /\.h3ps-direct-advanced \{[^}]*border:0;[^}]*border-top:/);
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

test("media labels insert references at the last editor caret without opening the inspector", () => {
  assert.doesNotMatch(mainSource, /data-reference-insert-toggle|h3ps-edit-asset/);
  assert.match(mainSource, /data-media-tag/);
  assert.match(mainSource, /insertReferenceAtCaret\(target\.editor, reference, target\.caret\)/);
  assert.match(mainSource, /\["focus", "click", "keyup", "select", "input"\]/);
  assert.match(mainSource, /studio.mediaEditor.open\(asset,button\)/);
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
  const requestIndex = mainSource.indexOf("trackWriterRequest(refine(buildLyricsRefinePayload");
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

test("text-only Direct UI disables visual modes and explains the fallback", () => {
  assert.match(mainSource, /function syncModeAvailability\(\)/);
  assert.match(mainSource, /Text-only model · T2VA and Music3 available/);
  assert.match(mainSource, /Switched to T2VA/);
  assert.match(mainSource, /if \(!generationModeIsAvailable\(\)\) return/);
  assert.match(stylesSource, /\.h3ps-modes button:disabled/);
  assert.match(skinSource, /\.h3ps-workspaces button:disabled/);
});

test("closed Prompt Writer does not advertise an active modal", () => {
  assert.match(mainSource, /<section class="h3ps-modal" role="dialog" aria-label="H3 Prompt Writer" hidden>/);
  assert.doesNotMatch(mainSource, /<section class="h3ps-modal" role="dialog" aria-modal="true"/);
});

test("theme selection is scoped, persisted, and exposed in the main header", () => {
  const markup = settingsMarkup(() => "");
  assert.doesNotMatch(markup, /data-theme-option|Color theme/);
  assert.match(mainSource, /data-theme-toggle>\$\{icon\("sun", 17\)\}/);
  assert.match(mainSource, /icon\(light \? "moon" : "sun", 17\)/);
  assert.match(mainSource, /studio\.root\.dataset\.theme = studio\.theme/);
  assert.match(mainSource, /setTheme\(studio\.theme === "light" \? "dark" : "light"\)/);
  assert.match(styleSources["themes/dark"], /\.h3ps-root\s*\{[\s\S]*--h3ps-bg:\s*#09090a;[\s\S]*color-scheme:\s*dark;/);
  assert.match(styleSources["themes/light"], /\.h3ps-root\[data-theme="light"\]\s*\{[\s\S]*--h3ps-text:\s*#1f2935;[\s\S]*color-scheme:\s*light;/);
  assert.match(styleSources.settings, /background:\s*var\(--h3ps-settings-header\)/);
  assert.match(styleSources.workbench, /background:\s*var\(--h3ps-output-surface\)/);
  assert.match(styleSources.settings, /background:\s*var\(--h3ps-field\)/);
});

test("theme maintenance guard keeps component colors on the token path", () => {
  const colorViolations = [];
  for (const name of componentStyleNames) {
    for (const record of hardcodedColorRecords(styleSources[name])) {
      if (!HARDCODED_COLOR_WHITELIST.has(record.value) && !HARDCODED_COLOR_SPECIAL_CASE.test(record.line)) {
        colorViolations.push(`${name}: ${record.value}`);
      }
    }
  }
  assert.deepEqual(colorViolations, [], "new opaque component colors need a theme token or an explicit special-case whitelist");
  assert.match(styleSources.tokens, /--h3ps-accent:\s*#e8613c;/);
  assert.doesNotMatch(styleSources["themes/dark"], /--h3ps-accent:/);
  assert.match(styleSources["themes/light"], /--h3ps-surface-raised:\s*var\(--h3ps-surface\);/);
  assert.match(styleSources["themes/light"], /--h3ps-border-control:\s*var\(--h3ps-border\);/);
});
test("interface size is token-based, persisted, and exposed as a header slider", () => {
  const markup = settingsMarkup(() => "");
  assert.doesNotMatch(markup, /Interface Size|data-interface-size/);
  assert.match(mainSource, /data-interface-size-toggle>Aa<\/button>/);
  assert.match(mainSource, /type="range" min="0" max="3" step="1"[^>]*data-interface-size-range/);
  assert.match(mainSource, /INTERFACE_SIZES\[Number\(event\.target\.value\)\]/);
  assert.match(mainSource, /setAttribute\("aria-valuetext", `\$\{size\}%`\)/);
  assert.match(mainSource, /studio\.root\.dataset\.interfaceSize = size/);
  assert.match(styleSources.tokens, /--h3ps-interface-scale:\s*1;/);
  assert.match(styleSources.tokens, /\[data-interface-size="110"\][^}]*--h3ps-interface-scale:\s*1\.1/);
  assert.match(styleSources.tokens, /\[data-interface-size="120"\][^}]*--h3ps-interface-scale:\s*1\.2/);
  assert.match(styleSources.tokens, /\[data-interface-size="125"\][^}]*--h3ps-interface-scale:\s*1\.25/);
  assert.match(styleSources.tokens, /--h3ps-font-body:\s*calc\(12px \* var\(--h3ps-interface-scale\)\)/);
  assert.match(styleSources.foundation, /--h3ps-icon-size\) \* var\(--h3ps-interface-scale\)/);
  assert.match(styleSources.tokens, /--h3ps-interface-scale-soft:\s*1;/);
  assert.match(styleSources.tokens, /\[data-interface-size="125"\][^}]*--h3ps-interface-scale-soft:\s*1\.125/);
  assert.match(styleSources.settings, /\.h3ps-settings-heading > \.h3ps-secondary-button \{[^}]*height:calc\(30px \* var\(--h3ps-interface-scale-soft\)\);[^}]*font-size:calc\(10\.5px \* var\(--h3ps-interface-scale-soft\)\);/);
  assert.match(styleSources.workbench, /\.h3ps-output-actions \.h3ps-secondary-button \{[^}]*height: 34px;[^}]*font-size: 11px;/);
  assert.match(styleSources.workbench, /\.h3ps-memory-action \{[^}]*height: 30px;[^}]*font-size: 10px;/);
  assert.match(styleSources.workbench, /\.h3ps-toggle-control \{[^}]*min-height: 28px;[^}]*font-size: 10\.5px;/);
  assert.match(styleSources.workbench, /\.h3ps-primary-button \{[^}]*height: 36px;[^}]*font-size: 10\.5px;/);
  assert.match(styleSources.workbench, /\.h3ps-section-heading strong \{ font-size: 15px; \}/);
  assert.match(styleSources.shell, /\.h3ps-guide-menu \{[^}]*background: var\(--h3ps-popover\)/);
  assert.match(styleSources.shell, /\.h3ps-guide-menu a:hover \{ background: var\(--h3ps-menu-hover\); \}/);
  assert.match(styleSources.tokens, /--h3ps-toast-scale:\s*calc\(1\.25 \* var\(--h3ps-interface-scale\)\)/);
  assert.match(styleSources.overlays, /min-width:\s*min\(var\(--h3ps-toast-min-width\), calc\(100vw - 24px\)\)/);
  assert.match(styleSources.overlays, /font-size:\s*var\(--h3ps-toast-font-title\)/);
  assert.match(styleSources.workbench, /\.h3ps-spinner \{[^}]*display:inline-block;[^}]*animation: h3ps-spin \.7s linear infinite;/);
  assert.match(styleSources.responsive, /prefers-reduced-motion:[^)]+\)[\s\S]*\.h3ps-root \.h3ps-spinner \{[^}]*animation-duration: \.7s !important;[^}]*animation-iteration-count: infinite !important;/);
  assert.doesNotMatch(styleSources.shell, /h3ps-guide-menu a:hover[^}]*rgba\(255,\s*255,\s*255/);
  assert.doesNotMatch(styleSources.models, /h3ps-direct-advanced > summary:hover[^}]*rgba\(255,\s*255,\s*255/);
  assert.doesNotMatch(styleSources.providers, /h3ps-runtime-menu button:hover[^}]*rgba\(255,\s*255,\s*255/);
  assert.doesNotMatch(styleSources.overlays, /h3ps-model-setup-row:hover[^}]*rgba\(255,\s*255,\s*255/);
  assert.match(styleSources.media, /\.h3ps-asset, \.h3ps-add-asset \{[^}]*height:\s*150px;/);
  assert.doesNotMatch(stylesSource, /\.is-large-text|text-large\.css|zoom:/);
  assert.doesNotMatch(styleSources["themes/dark"] + styleSources["themes/light"], /interface-size|interface-scale/);
});

test("interface maintenance guard keeps readable font sizes on semantic tokens", () => {
  const violations = componentStyleNames.flatMap((name) => fixedFontSizeViolations(styleSources[name].replaceAll("\r", "")));
  assert.deepEqual(violations, [], "ordinary readable UI font sizes should use semantic tokens");
});

test("theme and interface size preferences remain independent at both endpoints", () => {
  for (const theme of ["dark", "light"]) {
    for (const interfaceSize of ["100", "125"]) {
      const state = createStudioState({
        sessionId: `${theme}-${interfaceSize}`,
        storage: memoryStorage({
          [USER_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, theme, interface_size: interfaceSize }),
        }),
      });
      assert.equal(state.theme, theme);
      assert.equal(state.interfaceSize, interfaceSize);
    }
  }
});
test("the current launcher replaces stale duplicate extension launchers", () => {
  assert.match(mainSource, /const LAUNCHER_SCHEMA_VERSION = "2"/);
  assert.match(mainSource, /existingLauncher\?\.dataset\.h3psLauncherVersion === LAUNCHER_SCHEMA_VERSION/);
  assert.match(mainSource, /existingLauncher\?\.remove\(\)/);
  assert.match(mainSource, /launcher\.dataset\.h3psLauncherVersion = LAUNCHER_SCHEMA_VERSION/);
});

test("workbench exposes responsive stacking and layered keyboard navigation", () => {
  assert.match(styleSources.responsive, /@media \(max-width: 920px\)[\s\S]+\.h3ps-workspace \{[\s\S]+grid-template-columns: 1fr;[\s\S]+overflow-y: auto;/);
  assert.match(styleSources.shell, /\.h3ps-modal > \* \{ min-width: 0; \}/);
  assert.match(styleSources.responsive, /@media \(max-width: 920px\)[\s\S]+\.h3ps-header \{ flex-wrap: wrap; \}/);
  assert.match(styleSources.responsive, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(mainSource, /aria-expanded="false" data-guide-toggle/);
  assert.doesNotMatch(mainSource, /role="(?:menu|menuitem|listbox|option)"|aria-haspopup="menu"/);
  assert.match(aspectRatioMarkup(()=>""), /class="h3ps-choice-menu h3ps-aspect-menu"[^>]*role="group"/);
  assert.match(aspectRatioMarkup(()=>""), /aria-pressed="false"\s+data-aspect="16:9"/);
  assert.match(mainSource, /role="status" aria-live="polite" aria-atomic="true" data-status/);
  assert.match(mainSource, /if \(event\.key === "Tab"\)[\s\S]{0,1000}focusable/);
});

test("runtime pickers and the verified-model dialog keep keyboard state in sync", () => {
  assert.match(settingsSource, /aria-haspopup="true" aria-expanded="false" data-runtime-toggle="context"/);
  assert.match(settingsSource, /aria-haspopup="true" aria-expanded="false" data-runtime-toggle="reasoning"/);
  assert.match(mainSource, /function setRuntimeMenuOpen\(name, open, restoreFocus = false\)/);
  assert.match(mainSource, /else if \(runtimeMenu\) setRuntimeMenuOpen\(runtimeMenu\.dataset\.runtimeMenu, false, true\)/);
  assert.match(mainSource, /data-other-models-backdrop[^>]*hidden/);
  assert.match(mainSource, /role="dialog" aria-label="Other verified models"/);
  assert.match(styleSources.overlays, /\.h3ps-other-models-backdrop\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*119;/);
  assert.doesNotMatch(styleSources.overlays, /100vmax/);
});

test("focus styling stays visible for controls without outlining the dialog shell", () => {
  assert.match(styleSources.foundation, /\.h3ps-root \.h3ps-modal:focus,[\s\S]{0,80}\.h3ps-root \.h3ps-modal:focus-visible\s*\{\s*outline:\s*none !important;/);
  assert.match(styleSources.foundation, /\.h3ps-floating-launcher:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--h3ps-launcher-focus\) !important/);
  assert.doesNotMatch(styleSources.settings, /\.h3ps-provider-selector > button:focus-visible\s*\{[^}]*outline:\s*0/);
  assert.match(styleSources["themes/dark"], /\.h3ps-root\s*\{[\s\S]*color-scheme:\s*dark;/);
  assert.doesNotMatch(styleSources["themes/dark"], /:root\s*\{[^}]*color-scheme:/);
});

test("fullscreen reuses the studio root and persists its UI state", () => {
  assert.match(mainSource, /data-fullscreen-toggle/);
  assert.match(mainSource, /root\.classList\.toggle\("is-fullscreen", studio\.fullscreen\)/);
  assert.match(mainSource, /setAttribute\("aria-pressed", String\(studio\.fullscreen\)\)/);
  assert.match(mainSource, /if \(studio\.fullscreen\) setFullscreen\(false\)/);
  assert.match(mainSource, /saveUserPreferences\(localStorage, studio\)/);
  assert.match(mainSource, /fitTextarea\(brief, minimumHeight, 2\)/);
  assert.match(stylesSource, /\.h3ps-root\.is-fullscreen \.h3ps-brief textarea \{ max-height: none; \}/);
});

test("prompt refinement keeps actions above a vertically resizable editor", () => {
  assert.match(mainSource, /h3ps-refine-heading-actions[\s\S]{0,500}data-refine-cancel[\s\S]{0,250}data-refine-submit/);
  assert.match(mainSource, /data-refine-helper[\s\S]{0,160}data-refine-media-note/);
  assert.doesNotMatch(mainSource, /refine_height|refineHeight/);
  assert.match(stylesSource, /\.h3ps-refine\[data-refine-panel\] textarea \{[^}]*min-height: 72px;[^}]*resize: vertical;/);
});

test("refined media UI has neutral actions, no dead preview flow or reorder thumbnail ghost",()=>{
  assert.match(splitMenuMarkup(()=>"",{label:"Actions",primary:"data-actions-menu-toggle",toggle:"data-clear-menu-toggle",menu:"data-clear-menu",contents:"",ariaLabel:"Media actions"}),/data-actions-menu-toggle[^>]*>Actions/);
  assert.match(mainSource,/splitMenuMarkup\(icon, \{label: "Actions"/);
  assert.doesNotMatch(mainSource,/h3ps-compose-button|openVideoPreview|openImagePreview|resampleCurrentVideo|h3ps-drag-ghost/);
  assert.match(mainSource,/ghost.width = ghost.height = 1/);
  assert.match(mainSource,/setDragImage\(ghost, 0, 0\)/);
  assert.match(mainSource,/dismissOnWorkspaceClick:true/);
  assert.doesNotMatch(mainSource,/toast.onclick|options.persistent/);
  assert.match(mainSource,/!event.target.closest\("\[data-h3ps-toast\]"\)/);
  const fields=new Map(),classes=new Set(),timers=[];
  const toast={classList:{contains:c=>classes.has(c),add:c=>classes.add(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},querySelector(selector){
    if(!fields.has(selector))fields.set(selector,{querySelector:()=>({})});
    return fields.get(selector);
  }};
  const studio={root:{querySelector:()=>toast}};
  let dismissed=0;
  const show=mainSource.slice(mainSource.indexOf('function showToast('),mainSource.indexOf('function defaultModeDraft('));
  new Function('studio','hideToast','setTimeout','clearTimeout',show+';showToast("Trim required","Keep this notice",null,null,{dismissOnWorkspaceClick:true});')(studio,()=>dismissed++,(fn,ms)=>timers.push({fn,ms}),()=>{});
  assert.equal(timers.length,1);assert.equal(timers[0].ms,0);timers[0].fn();
  assert.equal(studio.toastDismissOnWorkspaceClick,true);
  const rule=mainSource.match(/if \(studio.toastDismissOnWorkspaceClick && !event.target.closest\("\[data-h3ps-toast\]"\)\) hideToast\(\);/)[0];
  const click=new Function('studio','event','hideToast',rule);
  click(studio,{target:{closest:()=>toast}},()=>dismissed++);assert.equal(dismissed,0);
  click(studio,{target:{closest:()=>null}},()=>dismissed++);assert.equal(dismissed,1);
});

test("startup generation state has no legacy preview dependency",()=>{
  assert.doesNotMatch(mainSource,/setSheetUpdating|resampleCurrentVideo|openVideoPreview/);
  const start=mainSource.indexOf('function setGenerationState('),end=mainSource.indexOf('function updatePromptResidency(',start);
  const noop=()=>{},node={querySelector:()=>node,querySelectorAll:()=>[],classList:{toggle:noop},innerHTML:''};
  const studio={root:node,mode:'Reference'};
  new Function('studio','icon','syncModeAvailability','renderMedia','syncLifecycleActions','HOST_CAPABILITIES','generationButtonMarkup',mainSource.slice(start,end)+';setGenerationState("idle","","");')(studio,noop,noop,noop,noop,{comfyMemory:true},generationButtonMarkup);
});

test("only confirmed Writer ownership makes unknown router state a release target",async()=>{
  const status={prompt_residency:{external:{targets:[{model_id:'old',state:'unknown',writer_owned:false},{model_id:'other',state:'loaded',writer_owned:false}]}}};
  assert.deepEqual(await unloadWriterModels({getStatus:async()=>status,unloadModel:async()=>assert.fail('no confirmed Writer residency')}),[]);
  status.prompt_residency.external.targets[0].writer_owned=true;
  assert.deepEqual(writerResidencyTargets(status),[{family:'external',model_id:'old'}]);
});
