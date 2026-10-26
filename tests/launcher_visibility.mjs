import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Window } from "happy-dom";

const source = readFileSync(new URL("../web/main.js", import.meta.url), "utf8");
function fixture(storage = new Map(), open = true) {
  const { document } = new Window();
  document.body.innerHTML = '<button data-h3ps-launcher></button><div id="writer"><input type="checkbox" data-hide-launcher></div>';
  const root = document.querySelector("#writer"), notices = [], options = [], removed = [];
  root.classList.toggle("is-open", open);
  const context = vm.createContext({
    document, studio: { root }, HOST_CAPABILITIES: { windowed: true },
    HIDE_LAUNCHER_SETTING: "hide",
    app: { extensionManager: { setting: { get: () => storage.get("hide") }, toast: {
      add: message => { notices.push(message.detail); options.push(message); },
      remove: message => removed.push(message),
    } } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    showToast: (_, message, _details, _action, config) => { notices.push(message); options.push(config); },
  });
  for (const name of ["syncLauncherVisibility", "onLauncherVisibilityChange"]) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))[0], context);
  }
  return { context, notices, options, removed, document, launcher: document.querySelector("button"), toggle: root.querySelector("input") };
}

test("launcher hides immediately, reappears and explains every user hide", () => {
  const storage = new Map(), f = fixture(storage);
  f.context.onLauncherVisibilityChange(false, undefined);
  assert.equal(f.launcher.hidden, false);
  assert.equal(f.notices.length, 0);
  f.context.onLauncherVisibilityChange(true, false);
  assert.equal(f.launcher.hidden, true);
  assert.equal(f.toggle.checked, true);
  assert.match(f.notices[0], /Comfy menu → Extensions → H3 Prompt Writer → Open H3 Prompt Writer/);
  assert.equal(f.options[0].dismissOnWorkspaceClick, true);
  assert.equal(f.options[0].durationMs, undefined);
  f.context.onLauncherVisibilityChange(false, true);
  assert.equal(f.launcher.hidden, false);
  f.context.onLauncherVisibilityChange(true, false);
  assert.equal(f.notices.length, 2);
  storage.set("hide", true);
  const reloaded = fixture(storage);
  reloaded.context.syncLauncherVisibility();
  assert.equal(reloaded.launcher.hidden, true);
  reloaded.context.onLauncherVisibilityChange(true, undefined);
  assert.equal(reloaded.notices.length, 0);
  reloaded.context.onLauncherVisibilityChange(false, true);
  reloaded.context.onLauncherVisibilityChange(true, false);
  assert.equal(reloaded.notices.length, 1);
});

test("Comfy settings explain hiding while Writer is closed, but registration stays silent", () => {
  const f = fixture(new Map(), false);
  f.context.onLauncherVisibilityChange(true, undefined);
  assert.equal(f.notices.length, 0);
  f.context.onLauncherVisibilityChange(false, true);
  f.context.onLauncherVisibilityChange(true, false);
  assert.equal(f.notices.length, 1);
  assert.equal(f.launcher.hidden, true);
  assert.equal(f.options[0].life, 0);
  assert.equal(f.removed.length, 0);
  f.document.dispatchEvent(new f.document.defaultView.Event("pointerdown"));
  assert.equal(f.removed[0], f.options[0]);
  f.document.dispatchEvent(new f.document.defaultView.Event("pointerdown"));
  assert.equal(f.removed.length, 1);
});
