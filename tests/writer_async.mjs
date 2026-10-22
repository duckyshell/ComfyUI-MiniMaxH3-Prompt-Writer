import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { Window } from "happy-dom";
import { configureI18n, messageText, msg, setLanguagePreference, t } from "../web/i18n.js";
import { writeToastContent } from "../web/toast.js";

const source = await readFile(process.env.H3_WRITER_SOURCE || new URL("../web/main.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Execute the actual orchestration functions, replacing only their IO boundaries.
function controller(names, dependencies) {
  if (dependencies.studio) dependencies.studio.desktopNotifications = { notify() {} };
  const context = vm.createContext(dependencies);
  for (const name of names) {
    const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
    assert.ok(declaration, name);
    vm.runInContext(declaration[0], context);
  }
  return context;
}

test("upload completion renders the current mode, including replacement", async () => {
  for (const replacement of [null, "old"]) {
    const pending = deferred();
    const renders = [];
    const studio = { mode: "Reference", assets: [], sessionId: "session" };
    const api = controller(["uploadFiles"], {
      studio, uploadMedia: () => pending.promise,
      acceptMediaAssets: assets => { studio.assets = assets; },
      showToast() {}, hideToast() {}, audioWasAdded: () => false, msg,
      renderMedia: (mode) => renders.push(mode),
    });
    const operation = api.uploadFiles("Reference", [{}], replacement);
    studio.mode = "I2VA";
    pending.resolve({ session_id: "session", assets: [{ id: "new", mode: "Reference" }] });
    await operation;
    assert.deepEqual(renders, ["I2VA"]);
    assert.equal(studio.assets[0].mode, "Reference");
  }
});

test("Clear everything does not clear another mode or newer input", async () => {
  for (const changeMode of [false, true]) {
    const pending = deferred();
    const studio = { mode: "Reference" };
    let fields = { brief: "old", prompt: "old", lyrics: "" };
    const api = controller(["clearEverything"], {
      studio, currentDraftFields: () => ({ ...fields }),
      clearCurrentMedia: () => pending.promise,
      clearCurrentPrompts: () => { fields = { brief: "", prompt: "" }; },
      showToast() {}, msg,
    });
    const operation = api.clearEverything();
    if (changeMode) studio.mode = "I2VA";
    fields = { brief: "new", prompt: "new", lyrics: "" };
    pending.resolve(true);
    await operation;
    assert.equal(fields.prompt, "new");
  }
});

function refinementController(lyricsMode, pending) {
  const started = deferred();
  const output = { value: "original" };
  const instruction = { value: "rewrite" };
  const generic = { value: "brief", checked: true, textContent: "", hidden: true };
  const submit = { disabled: false };
  const panel = { querySelector: (selector) => {
    if (selector.includes("submit")) return submit;
    if (selector === "textarea" || selector.includes("instruction")) return instruction;
    return generic;
  } };
  const studio = { mode: lyricsMode ? "Music3" : "Reference", selectedModel: { name: "model", runtime_ready: true }, root: {
    querySelector: (selector) => {
      if (selector.includes("panel")) return panel;
      if (selector === "[data-output]" || selector === "[data-music-lyrics]") return output;
      return generic;
    },
  } };
  const api = controller([lyricsMode ? "submitLyricsRefinement" : "submitRefinement"], {
    studio, prepareWriterRequest: async () => true, generationModeIsAvailable: () => true,
    markActiveWriterRequest() {}, clearActiveWriterRequest() {}, setGenerationState() {},
    vramHandoffCoordinator: { trackWriterRequest: (promise) => promise },
    refine: () => { started.resolve(); return pending.promise; },
    buildRefinePayload: () => ({}), buildLyricsRefinePayload: () => ({}),
    currentBriefTextarea: () => generic, newGenerationSeed: () => 1,
    renderPromptHighlights() {}, formatGenerationMeta: () => "", syncRuntimeSummary() {},
    syncModifiedState() {}, saveCurrentModeDraft() {}, showToast() {}, updateMusicLyricsCount() {},
    icon: () => "", getStatus: async () => ({}), updatePromptResidency() {}, msg, t, messageText, showErrorToast() {},
  });
  return { api, output, instruction, submit, started: started.promise };
}

for (const lyrics of [false, true]) {
  test(`${lyrics ? "Lyrics" : "Prompt"} Refine preserves newer editable text and instruction`, async () => {
    const pending = deferred();
    const { api, output, instruction, started } = refinementController(lyrics, pending);
    const operation = lyrics ? api.submitLyricsRefinement() : api.submitRefinement();
    await started;
    output.value = "new user text";
    instruction.value = "new instruction";
    pending.resolve({ prompt: "late result", total_seconds: 1, tokens_per_second: 1 });
    await operation;
    assert.equal(output.value, "new user text");
    assert.equal(instruction.value, "new instruction");
  });
}

test("Refine finally restores a localized button span", async () => {
  for (const lyrics of [false, true]) {
    const pending = deferred();
    const { api, submit, started } = refinementController(lyrics, pending);
    const operation = lyrics ? api.submitLyricsRefinement() : api.submitRefinement();
    await started;
    pending.resolve({ prompt: "rewritten", total_seconds: 1, tokens_per_second: 1 });
    await operation;
    assert.match(submit.innerHTML, /<span data-i18n="workspace\.refine">/);
  }
});

test("Refine applies an owned result without clearing a newer instruction", async () => {
  const pending = deferred();
  const { api, output, instruction, started } = refinementController(false, pending);
  const operation = api.submitRefinement();
  await started;
  instruction.value = "next instruction";
  pending.resolve({ prompt: "rewritten", total_seconds: 1, tokens_per_second: 1 });
  await operation;
  assert.equal(output.value, "rewritten");
  assert.equal(instruction.value, "next instruction");
});

test("an in-flight status response cannot restore busy after generation finishes", async () => {
  const generation = deferred();
  const started = deferred();
  const status = deferred();
  const { api } = refinementController(false, generation);
  let poll;
  let statusCalls = 0;
  Object.assign(api, {
    generate: () => { started.resolve(); return generation.promise; },
    buildGeneratePayload: () => ({}),
    setInterval: (callback) => { poll = callback; return 1; },
    clearInterval() {},
    getStatus: () => ++statusCalls === 1 ? status.promise : Promise.resolve({}),
    setGenerationState: (phase) => { api.studio.requestBusy = phase === "busy"; },
  });
  controller(["startGenerationPreview"], api);
  const operation = api.startGenerationPreview();
  await started.promise;
  const oldPoll = poll();
  generation.resolve({ prompt: "done", total_seconds: 1, tokens_per_second: 1 });
  await operation;
  assert.equal(api.studio.requestBusy, false);
  status.resolve({ phase: "generating" });
  await oldPoll;
  assert.equal(api.studio.requestBusy, false);
});

const composerSource = await readFile(new URL("../web/media_composer.js", import.meta.url), "utf8");
test("an old Composer Add cannot clear a reopened composition", async () => {
  const upload = deferred();
  const started = deferred();
  const state = { items: [{}], open: true, openGeneration: 1 };
  const context = vm.createContext({
    state, dom: { add: { disabled: false }, dialog: { focus() {}, setAttribute() {}, removeAttribute() {} } },
    exportPicture: async () => ({}),
    onAddPicture: () => { started.resolve(); return upload.promise; },
    normalizeCanvas() {}, clearDragGhost() {}, endCaption() {},
    notify() {}, renderPreview() {}, renderAll() {}, onOpenChange() {},
    setAssets: (assets) => { state.assets = assets; },
    document: { activeElement: null }, requestAnimationFrame: (callback) => callback(),
    root: { querySelector: () => null }, shellHomes: [],
    $: (selector) => selector === "[data-shell-controls]" ? { querySelector: () => ({}) } : null,
    el: { classList: { add() {}, remove() {} }, setAttribute() {} },
  });
  const declaration = composerSource.match(/^  async function addPicture\([^]*?^  }/m);
  vm.runInContext(declaration[0], context);
  vm.runInContext(composerSource.slice(composerSource.indexOf("  function open("), composerSource.indexOf("  function destroy(")), context);
  const operation = context.addPicture();
  await started.promise;
  context.close();
  context.open();
  state.items = [{ uid: "new composition" }];
  upload.resolve();
  await operation;
  assert.equal(state.items[0]?.uid, "new composition");
  assert.equal(state.open, true);
});

function providerController(overrides = {}, dependencies = {}) {
  const studio = {
    apiProviderConfig: { preset: "custom" }, apiProviderModels: [], models: [],
    root: { classList: { contains: () => false } }, modelSelectionRevision: 0,
    ...overrides,
  };
  return controller([
    "escapeHtml", "externalConnectedContextTokens", "syncExternalServerStatus",
    "renderApiProviderError", "syncApiProviderError",
    "connectConfiguredApiProvider", "disconnectConfiguredApiProvider",
    "chooseApiProviderPreset", "refreshApiProviderModels", "connectExternalServer",
    "disconnectExternalServer", "refreshModels",
  ], {
    studio, localStorage: {}, t, msg, showToast() {}, showErrorToast() {},
    DEFAULT_OLLAMA_HOST: "http://127.0.0.1:11434",
    renderInferenceSettings() {}, syncProviderPanelCopy() {}, syncRuntimeSummary() {},
    saveUserPreferences() {}, saveApiProviderConfig() {}, saveExternalServerConfig() {},
    apiProviderModelForSettings: () => null, disconnectApiProvider: async () => {},
    selectModel: (model) => { studio.selectedModel = model; studio.modelSelectionRevision++; },
    API_PROVIDER_UI: { custom: {}, openai: {} },
    getModels: async () => ({ models: [] }), getStatus: async () => ({}),
    getOllamaStatus: async () => ({}), getApiProviderPresets: async () => ({}),
    restoredModelAfterDiscovery: () => null, updatePromptResidency() {},
    setGenerationState: (phase) => { studio.requestBusy = phase === "busy"; },
    refreshGGUFRuntimeDiagnostics() {},
    ...dependencies,
  });
}

function providerForm() {
  const submit = { dataset: {} };
  return { querySelector: () => submit, elements: {
    model_id: { value: "model" }, url: { value: "http://localhost:8080" },
    model: { value: "model" }, api_key: { value: "" },
  } };
}

test("late API Connect releases only its own connection after a newer Connect", async () => {
  const first = deferred();
  const api = providerController();
  const disconnected = [];
  let calls = 0;
  api.disconnectApiProvider = async (id) => { disconnected.push(id); };
  api.probeApiProvider = () => ++calls === 1 ? first.promise : Promise.resolve({ connection: { id: "B" }, models: [] });
  const old = api.connectConfiguredApiProvider(providerForm());
  await api.connectConfiguredApiProvider(providerForm());
  first.resolve({ connection: { id: "A" }, models: [] });
  await old;
  assert.equal(api.studio.apiProviderConnection.id, "B");
  assert.deepEqual(disconnected, ["A"]);
});

test("a newer External Connect owns selection while an older API Connect finishes", async () => {
  const first = deferred();
  const second = deferred();
  const api = providerController();
  api.probeApiProvider = () => first.promise;
  api.probeExternalServer = () => second.promise;
  const old = api.connectConfiguredApiProvider(providerForm());
  const current = api.connectExternalServer(providerForm());
  first.resolve({ connection: { id: "A" }, model: { id: "A", name: "A" }, models: [] });
  await old;
  assert.equal(api.studio.selectedModel, undefined);
  second.resolve({ model: { id: "B", name: "B", endpoint: "http://localhost" } });
  await current;
  assert.equal(api.studio.selectedModel.id, "B");
});

test("a new Connect is not invalidated by an earlier background discovery", async () => {
  const discovery = deferred();
  const connection = deferred();
  const api = providerController();
  api.getModels = () => discovery.promise;
  api.probeApiProvider = () => connection.promise;
  const old = api.refreshModels();
  const current = api.connectConfiguredApiProvider(providerForm());
  discovery.resolve({ models: [] });
  await old;
  connection.resolve({ connection: { id: "new" }, model: { id: "new", name: "new" }, models: [] });
  await current;
  assert.equal(api.studio.selectedModel?.id, "new");
});

test("stale initial discovery finishes restoration and permits saving runtime preferences", async () => {
  const discovery = deferred();
  const connection = deferred();
  const api = providerController({ preferencesRestoring: true });
  controller(["rememberRuntimePreferences"], api);
  api.getModels = () => discovery.promise;
  api.probeApiProvider = () => connection.promise;
  const initial = api.refreshModels();
  const current = api.connectConfiguredApiProvider(providerForm());
  discovery.resolve({ models: [] });
  await initial;
  connection.resolve({ connection: { id: "new" }, model: { id: "new", name: "new" }, models: [] });
  await current;
  assert.equal(api.studio.selectedModel.id, "new");
  assert.equal(api.studio.preferencesRestoring, false);
  api.studio.contextProfile = "custom";
  api.studio.contextTokens = 24576;
  api.rememberRuntimePreferences("direct");
  assert.equal(api.studio.directContextTokens, 24576);
});

test("Disconnect invalidates pending API model refresh and Connect", async () => {
  for (const connect of [false, true]) {
    const pending = deferred();
    const api = providerController({ apiProviderConnection: { id: "old" } });
    api.getApiProviderModels = () => pending.promise;
    api.probeApiProvider = () => pending.promise;
    const operation = connect ? api.connectConfiguredApiProvider(providerForm()) : api.refreshApiProviderModels();
    await api.disconnectConfiguredApiProvider();
    pending.resolve({ connection: { id: "late" }, models: [] });
    await operation;
    assert.equal(api.studio.apiProviderConnection, null);
  }
});

test("changing API preset invalidates pending Connect without an existing connection", async () => {
  const pending = deferred();
  const api = providerController();
  api.probeApiProvider = () => pending.promise;
  const operation = api.connectConfiguredApiProvider(providerForm());
  await api.chooseApiProviderPreset("openai");
  pending.resolve({ connection: { id: "late" }, models: [] });
  await operation;
  assert.equal(api.studio.apiProviderConfig.preset, "openai");
});

test("External Disconnect invalidates a pending probe", async () => {
  const pending = deferred();
  const api = providerController();
  api.probeExternalServer = () => pending.promise;
  const operation = api.connectExternalServer(providerForm());
  api.disconnectExternalServer();
  pending.resolve({ model: { id: "late", endpoint: "http://localhost", name: "late" } });
  await operation;
  assert.equal(api.studio.externalModel, null);
});

test("model discovery cannot release a generation started while it waited", async () => {
  const pending = deferred();
  const api = providerController();
  api.getModels = () => pending.promise;
  const operation = api.refreshModels();
  api.studio.requestBusy = true;
  pending.resolve({ models: [] });
  await operation;
  assert.equal(api.studio.requestBusy, true);
});

test("discovery probe cannot restore the model selected before a newer selection", async () => {
  const pending = deferred();
  const started = deferred();
  const oldModel = { id: "old" };
  const newModel = { id: "new" };
  const api = providerController({ selectedModel: oldModel, externalServerConfig: {} });
  api.getModels = async () => ({ models: [oldModel, newModel] });
  api.probeExternalServer = () => { started.resolve(); return pending.promise; };
  const operation = api.refreshModels();
  await started.promise;
  api.selectModel(newModel);
  pending.resolve({ model: { id: "external" } });
  await operation;
  assert.equal(api.studio.selectedModel.id, "new");
});

test("external connect toast omits the context suffix when tokens are missing or non-numeric", async () => {
  const window = new Window();
  const root = window.document.createElement("div");
  window.document.body.append(root);
  configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  const connect = async (model) => {
    const toasts = [];
    const api = providerController({}, { showToast: (title, message) => toasts.push({ title, message }) });
    api.probeExternalServer = async () => ({ model });
    await api.connectExternalServer(providerForm());
    return messageText(toasts.pop().message);
  };
  try {
    const base = { id: "external:llama", name: "llama", endpoint: "http://127.0.0.1:8080", remote_model: "llama", context_verified: true };
    for (const server_context_tokens of [undefined, null, "16384", NaN, Infinity]) {
      assert.equal(await connect({ ...base, ...(server_context_tokens === undefined ? {} : { server_context_tokens }) }), "llama");
    }
    assert.equal(await connect({ ...base, server_context_tokens: 16384 }), "llama · 16K context");
  } finally {
    configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  }
});

test("a failed external connect keeps the typed form and only updates status", async () => {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = `<div data-external-provider-control>
    <em data-external-server-status data-i18n="providers.status.not_connected"></em>
    <form data-external-server-form>
      <input name="url" value="http://127.0.0.1:9000">
      <input name="model" value="my-model">
      <input name="api_key" type="password" value="secret">
      <button type="submit">Connect</button>
    </form>
  </div>`;
  window.document.body.append(root);
  configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  try {
    const form = root.querySelector("[data-external-server-form]");
    const status = root.querySelector("[data-external-server-status]");
    const submit = form.querySelector('[type="submit"]');
    const studio = {
      root, models: [], externalModel: null, externalServerError: null,
      externalServerConfig: { url: "http://127.0.0.1:9000", model: "my-model" },
      modelSelectionRevision: 0, externalConnectionAttempt: 0,
    };
    let rerenders = 0;
    let errorToasts = 0;
    const api = controller(["connectExternalServer", "syncExternalServerStatus"], {
      studio, t, msg,
      probeExternalServer: async () => { throw new Error("connection refused"); },
      showErrorToast() { errorToasts++; },
      syncProviderPanelCopy() {}, renderInferenceSettings() { rerenders++; },
    });

    await api.connectExternalServer(form);

    assert.equal(errorToasts, 1);
    assert.ok(studio.externalServerError instanceof Error);
    assert.equal(root.querySelector("[data-external-server-form]"), form, "form node must not be rebuilt");
    assert.equal(form.elements.url.value, "http://127.0.0.1:9000");
    assert.equal(form.elements.model.value, "my-model");
    assert.equal(form.elements.api_key.value, "secret");
    assert.equal(rerenders, 0);
    assert.equal(status.dataset.i18n, "providers.status.offline");
    assert.equal(status.textContent, "Offline");
    assert.equal(submit.disabled, false);
    assert.equal(submit.dataset.i18n, "providers.external.connect");
    assert.equal(submit.textContent, "Connect");
  } finally {
    configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  }
});

test("a failed reconnect restores the Reconnect label while keeping the connected model", async () => {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = `<div data-external-provider-control>
    <em data-external-server-status></em>
    <form data-external-server-form>
      <input name="url" value="http://127.0.0.1:9000">
      <input name="model" value="my-model">
      <input name="api_key" type="password" value="">
      <button type="submit">Reconnect</button>
    </form>
  </div>`;
  window.document.body.append(root);
  configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  try {
    const form = root.querySelector("[data-external-server-form]");
    const status = root.querySelector("[data-external-server-status]");
    const submit = form.querySelector('[type="submit"]');
    const studio = {
      root, models: [], externalModel: { id: "external:llama", name: "llama" },
      externalServerError: null,
      externalServerConfig: { url: "http://127.0.0.1:9000", model: "my-model" },
      modelSelectionRevision: 0, externalConnectionAttempt: 0,
    };
    const api = controller(["connectExternalServer", "syncExternalServerStatus"], {
      studio, t, msg,
      probeExternalServer: async () => { throw new Error("connection refused"); },
      showErrorToast() {}, syncProviderPanelCopy() {}, renderInferenceSettings() {},
    });

    await api.connectExternalServer(form);

    assert.equal(form.elements.url.value, "http://127.0.0.1:9000");
    assert.equal(form.elements.model.value, "my-model");
    assert.equal(status.dataset.i18n, "providers.status.connected");
    assert.equal(submit.dataset.i18n, "providers.external.reconnect");
    assert.equal(submit.textContent, "Reconnect");
  } finally {
    configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  }
});

test("a failed API provider connect keeps the typed form and shows the error in place", async () => {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = `<div data-api-provider-control>
    <form data-api-provider-form>
      <input name="base_url" type="url" value="http://127.0.0.1:1234/v1">
      <input name="api_key" type="password" value="sk-test">
      <input name="model_id" type="text" value="my-model">
      <div data-api-provider-error></div>
      <button type="submit">Connect &amp; test</button>
    </form>
  </div>`;
  window.document.body.append(root);
  configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  try {
    const form = root.querySelector("[data-api-provider-form]");
    const slot = root.querySelector("[data-api-provider-error]");
    const submit = form.querySelector('[type="submit"]');
    const oldConfig = { preset: "custom", base_url: "", model_id: "", gemini_reasoning_effort: "minimal" };
    const studio = {
      root, models: [], apiProviderConnection: null, apiProviderModels: [],
      apiProviderConfig: oldConfig, apiProviderError: null,
      modelSelectionRevision: 0, apiConnectionAttempt: 0,
    };
    let rerenders = 0;
    const api = controller([
      "escapeHtml", "renderApiProviderError", "syncApiProviderError", "connectConfiguredApiProvider",
    ], {
      studio, t, msg,
      probeApiProvider: async () => { throw new Error("401 unauthorized"); },
      showErrorToast() {}, syncProviderPanelCopy() {}, renderInferenceSettings() { rerenders++; },
      saveApiProviderConfig() {}, syncRuntimeSummary() {}, saveUserPreferences() {},
      selectModel() {}, apiProviderModelForSettings: () => null,
      disconnectApiProvider: async () => {}, getApiProviderModels: async () => ({}),
    });

    await api.connectConfiguredApiProvider(form);

    assert.ok(studio.apiProviderError instanceof Error);
    assert.equal(root.querySelector("[data-api-provider-form]"), form, "form node must not be rebuilt");
    assert.equal(form.elements.base_url.value, "http://127.0.0.1:1234/v1");
    assert.equal(form.elements.model_id.value, "my-model");
    assert.equal(form.elements.api_key.value, "sk-test");
    assert.equal(rerenders, 0);
    assert.equal(studio.apiProviderConfig, oldConfig);
    assert.match(slot.textContent, /401 unauthorized/);
    assert.ok(slot.querySelector('[data-provider-dynamic="api-error-code"]'));
    assert.equal(submit.disabled, false);
    assert.equal(submit.dataset.i18n, "providers.api.connect_test");
    assert.equal(submit.textContent, "Connect & test");
  } finally {
    configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  }
});

test("provider connect toast bodies replay after a locale switch", async () => {
  const window = new Window();
  const root = window.document.createElement("div");
  window.document.body.append(root);
  const toast = window.document.createElement("div");
  toast.innerHTML = `<strong data-toast-title></strong><span data-toast-message></span>
    <details data-toast-details hidden><summary>Technical details</summary><pre></pre></details>
    <button data-toast-action hidden></button>`;
  const toasts = [];
  const capture = (title, message) => toasts.push({ title, message });
  configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  try {
    const external = providerController({}, { showToast: capture });
    external.probeExternalServer = async () => ({ model: {
      id: "external:llama", name: "llama", endpoint: "http://127.0.0.1:8080",
      remote_model: "llama", context_verified: true, server_context_tokens: 16384,
    } });
    await external.connectExternalServer(providerForm());
    const externalToast = toasts.pop();
    writeToastContent(toast, externalToast);
    assert.equal(toast.querySelector("[data-toast-message]").textContent, "llama · 16K context");

    const api = providerController({}, { showToast: capture });
    api.probeApiProvider = async () => ({
      connection: { id: "api:gemini", provider_name: "Gemini", connection_verified: true },
      model: {
        id: "api:gemini:pro", name: "gemini-2.5-pro", remote_model: "gemini-2.5-pro",
        capabilities: { images: true },
      },
      models: [],
    });
    await api.connectConfiguredApiProvider(providerForm());
    const apiToast = toasts.pop();
    writeToastContent(toast, apiToast);
    assert.equal(toast.querySelector("[data-toast-message]").textContent, "gemini-2.5-pro · vision ready");

    setLanguagePreference("zh-CN");
    writeToastContent(toast, externalToast);
    assert.equal(toast.querySelector("[data-toast-message]").textContent, "llama · 16K 上下文");
    writeToastContent(toast, apiToast);
    assert.equal(toast.querySelector("[data-toast-message]").textContent, "gemini-2.5-pro · 视觉就绪");
  } finally {
    configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  }
});
