import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  BUILT_IN_PREFILLS,
  createPromptLibrary,
  filterHistory,
  firstBlankOffset,
  historyButtonMarkup,
  historyPanelMarkup,
  prefillPickerMarkup,
  prefillsForMode,
} from "../web/prompt_library.js";

const icon = (name) => `<i data-icon="${name}"></i>`;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}

function fixture({ entries = [], storage = memoryStorage(), mode = "T2VA" } = {}) {
  const window = new Window();
  const { document } = window;
  globalThis.requestAnimationFrame = (callback) => callback();
  document.body.innerHTML = `<div id="root">
    ${historyButtonMarkup(icon)}
    <div class="h3ps-brief">${prefillPickerMarkup(icon)}<textarea data-video-brief>old brief</textarea></div>
    ${historyPanelMarkup(icon)}
  </div>`;
  const root = document.querySelector("#root");
  const calls = { notify: [], loaded: [], copied: [], deleted: [], changed: 0 };
  const api = {
    listHistory: async () => ({ entries }),
    addHistory: async (payload) => ({ entry: { id: "new", created_at: 1, assets: [], ...payload } }),
    deleteHistory: async (id) => { calls.deleted.push(id); return { deleted: id }; },
    clearHistory: async () => ({ removed: entries.length }),
  };
  const library = createPromptLibrary({
    root, icon, storage, api,
    getMode: () => mode,
    getBriefField: () => root.querySelector("[data-video-brief]"),
    onBriefChanged: () => { calls.changed++; },
    onLoadEntry: async (entry, options) => { calls.loaded.push([entry.id, options.withMedia]); return true; },
    onCopy: (text) => calls.copied.push(text),
    notify: (title, message, action) => calls.notify.push({ title, message, action }),
    isBusy: () => false,
  });
  return { window, document, root, library, calls, storage };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("prefills are filtered by mode and built-ins exist for every video mode", () => {
  for (const mode of ["T2VA", "I2VA", "FL2VA", "L2VA", "Reference"]) {
    assert.ok(prefillsForMode(mode).builtIn.length >= 4, mode);
  }
  const user = [{ id: "a", name: "A", text: "x", modes: ["I2VA"] }, { id: "b", name: "B", text: "y", modes: null }];
  assert.deepEqual(prefillsForMode("T2VA", user).user.map((item) => item.id), ["b"]);
  assert.deepEqual(prefillsForMode("I2VA", user).user.map((item) => item.id), ["a", "b"]);
  assert.ok(!prefillsForMode("T2VA").builtIn.some((item) => item.id === "builtin-reference-roles"));
});

test("caret lands in the first empty slot of a prefill", () => {
  assert.equal(firstBlankOffset("Setting: \nMood: "), "Setting: ".length);
  assert.equal(firstBlankOffset('He says: "" now'), 'He says: "'.length);
  assert.equal(firstBlankOffset("No blanks here."), "No blanks here.".length);
  for (const item of BUILT_IN_PREFILLS) assert.ok(firstBlankOffset(item.text) <= item.text.length);
});

test("history filter matches mode and search text", () => {
  const entries = [
    { id: "1", mode: "T2VA", brief: "Rainy tram stop", prompt: "p1" },
    { id: "2", mode: "Reference", brief: "Coffee shop", prompt: "Samoyed lunges" },
  ];
  assert.deepEqual(filterHistory(entries, { mode: "Reference" }).map((e) => e.id), ["2"]);
  assert.deepEqual(filterHistory(entries, { query: "samoyed" }).map((e) => e.id), ["2"]);
  assert.deepEqual(filterHistory(entries, { mode: "T2VA", query: "coffee" }), []);
});

test("applying a prefill replaces the brief and offers undo", () => {
  const { root, calls } = fixture();
  root.querySelector("[data-prefill-toggle]").click();
  assert.equal(root.querySelector("[data-prefill-menu]").hidden, false);
  root.querySelector('[data-prefill-apply="builtin-cinematic"]').click();
  const brief = root.querySelector("[data-video-brief]");
  assert.equal(brief.value, BUILT_IN_PREFILLS[0].text);
  assert.equal(root.querySelector("[data-prefill-menu]").hidden, true);
  assert.equal(calls.changed, 1);
  const undo = calls.notify.at(-1).action;
  undo.onClick();
  assert.equal(brief.value, "old brief");
});

test("saving the current brief creates a removable user prefill", () => {
  const storage = memoryStorage();
  const { root } = fixture({ storage, mode: "I2VA" });
  root.querySelector("[data-prefill-toggle]").click();
  root.querySelector("[data-prefill-name]").value = "My opener";
  root.querySelector("[data-prefill-mode-only]").checked = true;
  root.querySelector("[data-prefill-save]").dispatchEvent(new root.ownerDocument.defaultView.Event("submit", { bubbles: true, cancelable: true }));
  const saved = JSON.parse(storage.data.get("h3ps.briefPrefills.v1"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "My opener");
  assert.deepEqual(saved[0].modes, ["I2VA"]);
  root.querySelector(`[data-prefill-remove="${saved[0].id}"]`).click();
  assert.equal(JSON.parse(storage.data.get("h3ps.briefPrefills.v1")).length, 0);
});

test("history panel lists entries with thumbnails and routes actions", async () => {
  const entries = [{
    id: "e1", created_at: 1_700_000_000, mode: "Reference", brief: "Brief text", prompt: "Prompt text",
    duration: 10, aspect_ratio: "16:9", model: "gemma",
    assets: [
      { type: "image", reference: "<Picture 1>", filename: "a.png", thumb_url: "/t/0", media_url: "/m/0" },
      { type: "video", reference: "<Video 1>", filename: "b.mp4", thumb_url: "/t/1" },
    ],
  }];
  const { root, library, calls } = fixture({ entries });
  root.querySelector("[data-history-open]").click();
  await flush();
  assert.equal(library.historyOpen, true);
  const card = root.querySelector('[data-history-entry="e1"]');
  assert.equal(card.querySelectorAll("img").length, 2);
  assert.match(card.textContent, /<Picture 1>/);
  card.querySelector('[data-history-action="copy"]').click();
  assert.deepEqual(calls.copied, ["Prompt text"]);
  card.querySelector('[data-history-action="load-media"]').click();
  await flush();
  assert.deepEqual(calls.loaded, [["e1", true]]);
  assert.equal(library.historyOpen, false);
});

test("closeTopmost closes the prefill menu before the history panel", async () => {
  const { root, library } = fixture();
  root.querySelector("[data-history-open]").click();
  await flush();
  root.querySelector("[data-prefill-toggle]").click();
  assert.equal(library.closeTopmost(), true);
  assert.equal(root.querySelector("[data-prefill-menu]").hidden, true);
  assert.equal(library.historyOpen, true);
  assert.equal(library.closeTopmost(), true);
  assert.equal(library.historyOpen, false);
  assert.equal(library.closeTopmost(), false);
});

test("recorded prompts appear without reloading the list", async () => {
  const { root, library } = fixture();
  root.querySelector("[data-history-open]").click();
  await flush();
  await library.record({ mode: "T2VA", brief: "b", prompt: "fresh prompt" });
  assert.ok(root.querySelector('[data-history-entry="new"]'));
});
