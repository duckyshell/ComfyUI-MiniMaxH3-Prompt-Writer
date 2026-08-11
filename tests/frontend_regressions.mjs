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
  SYSTEM_PROMPT_STORAGE_KEY,
  buildGeneratePayload,
  buildRefinePayload,
  createStudioState,
  currentSystemPromptOverride,
  loadCustomSystemPrompts,
  loadExternalServerConfig,
  saveCustomSystemPrompts,
  saveExternalServerConfig,
  selectModelState,
  systemPromptProfile,
} = await import(`data:text/javascript;base64,${stateEncoded}`);
const settingsSource = await readFile(new URL("../web/settings.js", import.meta.url), "utf8");
const settingsEncoded = Buffer.from(settingsSource).toString("base64");
const { settingsMarkup } = await import(`data:text/javascript;base64,${settingsEncoded}`);
const mainSource = await readFile(new URL("../web/main.js", import.meta.url), "utf8");

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
  });

  assert.deepEqual(loadExternalServerConfig(storage), { url: "http://127.0.0.1:8080", model: "gemma.gguf" });
  assert.deepEqual(loadCustomSystemPrompts(storage), { standard: "Standard custom", reference: "Reference custom" });
  saveExternalServerConfig(storage, { url: "http://localhost:8081", model: "other.gguf" });
  saveCustomSystemPrompts(storage, { standard: "Updated" });

  assert.deepEqual(storage.entries(), {
    [EXTERNAL_SERVER_STORAGE_KEY]: JSON.stringify({ url: "http://localhost:8081", model: "other.gguf" }),
    [SYSTEM_PROMPT_STORAGE_KEY]: JSON.stringify({ standard: "Updated" }),
  });
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
    thinking: true,
    context_profile: "standard",
    kv_cache: "q8",
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
    thinking: true,
    context_profile: "standard",
    kv_cache: "q8",
    system_prompt_override: "Custom reference",
    seed: 99,
    unload_after: true,
  });
});

test("Settings separates providers, installed models, diagnostics, and verified models", () => {
  const markup = settingsMarkup(() => "<svg></svg>");
  assert.match(markup, /data-provider-option="direct"/);
  assert.match(markup, /data-provider-option="external"/);
  assert.match(markup, /data-provider-panel="direct"/);
  assert.match(markup, /data-provider-panel="external"/);
  assert.match(markup, /data-installed-model/);
  assert.match(markup, /data-model-refresh/);
  assert.match(markup, /data-model-scan-slot/);
  assert.match(markup, /data-verified-models-slot/);
  assert.doesNotMatch(markup, /data-model-capabilities/);
  assert.doesNotMatch(mainSource, /data-developer-mode/);
  assert.doesNotMatch(markup, /Prompt models/);
  assert.doesNotMatch(markup, /data-model-menu/);
  assert.match(markup, /Context and KV cache/);
});

test("Settings shows one switchable System Prompt editor and Generate keeps lifecycle controls", () => {
  const markup = settingsMarkup(() => "<svg></svg>");
  assert.equal((markup.match(/h3ps-system-prompt-card/g) || []).length, 1);
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
  assert.match(mainSource, /generate\(buildGeneratePayload\(studio/);
  assert.match(mainSource, /refine\(buildRefinePayload\(studio/);
});
