import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Window } from "happy-dom";
import { API_SAMPLING_FIELDS, safeApiSampling, buildGeneratePayload, buildRefinePayload,
  buildLyricsRefinePayload, createStudioState, saveApiProviderConfig, loadApiProviderConfig } from "../web/studio_state.js";

const source = readFileSync(new URL("../web/main.js", import.meta.url), "utf8");
function functions(names, context) {
  for (const name of names) {
    const code = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))[0];
    vm.runInContext(code.replaceAll("import.meta.url", JSON.stringify(new URL("../web/main.js", import.meta.url).href)), context);
  }
}
const escapeHtml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

test("API sampling form saves zero, resets, and excludes unsupported fields", () => {
  const window = new Window();
  const model = { sampling_parameters: ["temperature", "top_k"] };
  const studio = { root: window.document.body, apiProviderConfig: { preset: "custom", model_id: "test", sampling: {} } };
  const context = vm.createContext({ studio, API_SAMPLING_FIELDS, safeApiSampling, escapeHtml, localStorage: window.localStorage,
    saveApiProviderConfig, showToast() {}, apiProviderModelForSettings: () => model,
    renderInferenceSettings: () => { studio.root.innerHTML = context.apiSamplingMarkup(model, studio.apiProviderConfig); } });
  functions(["apiSamplingMarkup", "saveApiSampling"], context);
  context.renderInferenceSettings();
  let form = studio.root.querySelector("form");
  assert.equal(form.elements.top_p.disabled, true);
  form.elements.temperature.value = "0";
  form.elements.top_k.value = "24";
  context.saveApiSampling(form);
  assert.deepEqual(JSON.parse(JSON.stringify(studio.apiProviderConfig.sampling)), { temperature: 0, top_k: 24 });
  assert.deepEqual(loadApiProviderConfig(window.localStorage).sampling, { temperature: 0, top_k: 24 });
  form = studio.root.querySelector("form");
  form.elements.temperature.value = "3";
  context.saveApiSampling(form);
  assert.equal(studio.apiProviderConfig.sampling.temperature, 0);
  context.saveApiSampling(form, true);
  assert.deepEqual(Object.keys(studio.apiProviderConfig.sampling), []);
  assert.equal(studio.root.querySelector('[name="temperature"]').value, "");
  window.happyDOM.abort();
});

test("all API request types carry saved supported samplers and local backends do not", () => {
  const state = createStudioState({ getItem: () => null });
  state.selectedModel = { id: "api::test::model", family: "api", api_connection_id: "test", remote_model: "model", sampling_parameters: ["temperature"] };
  state.apiProviderConfig.sampling = { temperature: 0, top_k: 50, injected: 123 };
  for (const build of [buildGeneratePayload, buildRefinePayload, buildLyricsRefinePayload]) {
    assert.deepEqual(build(state, { creativeBrief: "quiet scene", currentPrompt: "scene", instruction: "shorter" }).api_sampling, { temperature: 0 });
  }
  state.selectedModel = { id: "local", family: "gguf" };
  assert.equal(Object.hasOwn(buildGeneratePayload(state, {}), "api_sampling"), false);
  assert.deepEqual(safeApiSampling({ top_k: 1.1, temperature: NaN, top_p: "0.4", presence_penalty: true }), {});
});
