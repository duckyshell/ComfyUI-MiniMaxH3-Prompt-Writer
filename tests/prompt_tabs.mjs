import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { TABS_STORAGE_KEY, blankModeDrafts, createPromptTabs, loadTabs, tabLabel, tabsBarMarkup } from "../web/prompt_tabs.js";

const icon = (name) => `<i data-icon="${name}"></i>`;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}

function fixture({ storage = memoryStorage(), locked = null } = {}) {
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = `<div id="root">${tabsBarMarkup()}<textarea data-video-brief>first brief</textarea></div>`;
  const root = document.querySelector("#root");
  let ids = 0;
  // A tiny stand-in for the Writer's live workspace state.
  const live = { mode: "T2VA", sessionId: "session-0", assets: [], durationSeconds: 10, aspectRatio: "16:9", modeDrafts: { T2VA: { brief: "first brief", prompt: "" } } };
  const calls = { applied: [], changes: [], notify: [] };
  const state = { locked };
  const tabs = createPromptTabs({
    root, icon, storage,
    newId: () => `id-${++ids}`,
    initial: { ...live, modeDrafts: { ...live.modeDrafts } },
    getActive: () => ({ mode: live.mode, brief: root.querySelector("[data-video-brief]").value }),
    capture: () => ({ ...live, modeDrafts: { ...live.modeDrafts, [live.mode]: { brief: root.querySelector("[data-video-brief]").value, prompt: "" } } }),
    apply: async (tab) => {
      calls.applied.push(tab.id);
      Object.assign(live, { mode: tab.mode, sessionId: tab.sessionId, modeDrafts: tab.modeDrafts });
      root.querySelector("[data-video-brief]").value = tab.modeDrafts[tab.mode]?.brief ?? "";
    },
    canSwitch: () => state.locked,
    onChange: (options) => calls.changes.push(options || {}),
    notify: (title, message, action) => calls.notify.push({ title, message, action }),
  });
  return { window, root, tabs, live, calls, state, storage };
}

const click = (root, selector) => root.querySelector(selector).click();

test("tab labels come from the name or the brief", () => {
  assert.equal(tabLabel({ name: "Hero shot", mode: "T2VA", modeDrafts: {} }), "Hero shot");
  assert.equal(tabLabel({ name: null, mode: "T2VA", modeDrafts: {} }), "New prompt");
  assert.equal(tabLabel({ name: null, mode: "T2VA", modeDrafts: { T2VA: { brief: "  A   short brief " } } }), "A short brief");
  assert.ok(tabLabel({ name: null, mode: "T2VA", modeDrafts: {} }, "x".repeat(80)).endsWith("…"));
});

test("new tabs get their own media session and blank drafts, and switching keeps each tab's text", async () => {
  const { root, tabs, live, calls } = fixture();
  assert.equal(tabs.tabs.length, 1);
  assert.equal(root.querySelector(".h3ps-tab-label").textContent, "first brief");
  click(root, "[data-tab-add]");
  await Promise.resolve();
  assert.equal(tabs.tabs.length, 2);
  const second = tabs.active;
  assert.notEqual(second.sessionId, "session-0");
  assert.deepEqual(second.modeDrafts, blankModeDrafts());
  assert.equal(live.sessionId, second.sessionId);
  root.querySelector("[data-video-brief]").value = "second brief";
  await tabs.select(tabs.tabs[0].id);
  assert.equal(root.querySelector("[data-video-brief]").value, "first brief");
  assert.equal(tabs.find(second.id).modeDrafts.T2VA.brief, "second brief");
  assert.deepEqual(calls.applied, [second.id, tabs.tabs[0].id]);
});

test("locked tabs cannot switch, add or close", async () => {
  const { root, tabs, state, calls } = fixture();
  click(root, "[data-tab-add]");
  state.locked = "Wait for the current request to finish.";
  tabs.render();
  assert.equal(await tabs.select(tabs.tabs[0].id), false);
  assert.equal(calls.notify.at(-1).message, state.locked);
  assert.equal(root.querySelector("[data-tab-add]").disabled, true);
  assert.equal(tabs.add(), null);
});

test("queue keeps order, numbers waiting tabs and can be stopped", async () => {
  const { root, tabs, calls } = fixture();
  click(root, "[data-tab-add]");
  click(root, "[data-tab-add]");
  const [a, b, c] = tabs.tabs;
  assert.equal(tabs.enqueue(c.id), true);
  assert.equal(tabs.enqueue(a.id), true);
  assert.equal(tabs.enqueue(a.id), false);
  assert.deepEqual(tabs.queued.map((tab) => tab.id), [c.id, a.id]);
  assert.equal(root.querySelector(`[data-tab="${a.id}"] .h3ps-tab-status`).textContent, "2");
  assert.match(root.querySelector("[data-queue-summary]").textContent, /2 waiting/);
  tabs.setStatus(c.id, "running");
  assert.equal(tabs.running, c);
  assert.equal(root.querySelector(`[data-tab="${c.id}"] [data-tab-close]`).disabled, true);
  assert.equal(tabs.dequeue(b.id), false);
  click(root, "[data-queue-stop]");
  assert.deepEqual(tabs.queued, []);
  assert.deepEqual(calls.changes.at(-1), { stop: true });
});

test("finished background tabs show a badge until visited", async () => {
  const { root, tabs } = fixture();
  click(root, "[data-tab-add]");
  const first = tabs.tabs[0];
  tabs.setStatus(first.id, "done");
  assert.ok(root.querySelector(`[data-tab="${first.id}"] .h3ps-tab-status.is-done`));
  await tabs.select(first.id);
  assert.equal(first.status, "idle");
});

test("closing a tab activates a neighbour and can be undone", async () => {
  const { root, tabs, calls } = fixture();
  click(root, "[data-tab-add]");
  const closed = tabs.active;
  click(root, `[data-tab-close="${closed.id}"]`);
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.active, tabs.tabs[0]);
  assert.equal(root.querySelector("[data-tab-close]"), null);
  calls.notify.at(-1).action.onClick();
  await Promise.resolve();
  assert.equal(tabs.tabs.length, 2);
  assert.equal(tabs.active.id, closed.id);
});

test("double-click renames the active tab", () => {
  const { window, root, tabs } = fixture();
  root.querySelector("[data-tab-select]").dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  const input = root.querySelector("[data-tab-rename]");
  input.value = "Rooftop courier";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(tabs.active.name, "Rooftop courier");
  assert.equal(root.querySelector(".h3ps-tab-label").textContent, "Rooftop courier");
});

test("tabs persist without runtime state and the Writer's drafts win for the active tab", async () => {
  const storage = memoryStorage();
  const { root, tabs } = fixture({ storage });
  click(root, "[data-tab-add]");
  await Promise.resolve();
  tabs.enqueue(tabs.tabs[0].id);
  tabs.save();
  const saved = JSON.parse(storage.data.get(TABS_STORAGE_KEY));
  assert.equal(saved.tabs.length, 2);
  assert.equal("status" in saved.tabs[0] || "assets" in saved.tabs[0], false);
  const loaded = loadTabs(storage);
  assert.equal(loaded.activeId, tabs.active.id);
  assert.ok(loaded.tabs.every((tab) => tab.status === "idle" && tab.assets === null));

  const restored = fixture({ storage });
  assert.equal(restored.tabs.tabs.length, 2);
  assert.equal(restored.tabs.active.id, tabs.active.id);
  assert.equal(restored.tabs.active.sessionId, tabs.active.sessionId, "keeps the media session");
  assert.deepEqual(restored.tabs.active.modeDrafts, { T2VA: { brief: "first brief", prompt: "" } });
  assert.equal(loadTabs(memoryStorage({ [TABS_STORAGE_KEY]: "{broken" })), null);
});
