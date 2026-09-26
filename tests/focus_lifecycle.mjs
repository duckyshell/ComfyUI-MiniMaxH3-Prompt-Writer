import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Window } from "happy-dom";

const source = readFileSync(new URL("../web/main.js", import.meta.url), "utf8");
function fixture() {
  const window = new Window(),
    document = window.document,
    frames = [];
  document.body.innerHTML =
    '<canvas tabindex="0"></canvas><button id="opener"></button><div class="h3ps-root" aria-hidden="true"><section class="h3ps-modal" hidden><button data-close-studio></button><div class="h3ps-output-panel"></div><div data-refine-panel hidden><textarea></textarea></div><div data-lyrics-refine-panel hidden><textarea></textarea></div><button data-other-models-toggle></button></section><div data-other-models-popover role="dialog" hidden><button data-other-models-close></button></div><div data-other-models-backdrop hidden></div></div>';
  const root = document.querySelector(".h3ps-root"),
    modal = root.querySelector(".h3ps-modal"),
    canvas = document.querySelector("canvas"),
    opener = document.querySelector("#opener");
  // happy-dom has no layout engine; model visibility while exercising real DOM focus.
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden], [inert], [aria-hidden="true"]') ? [] : [{}];
  };
  const studio = {
    root,
    mode: "Reference",
    sequence: {
      leave() {
        studio.left = true;
      },
    },
  };
  const api = vm.createContext({
    document,
    HTMLElement: window.HTMLElement,
    studio,
    createStudio: () => studio,
    app: { canvas: { canvas } },
    HOST_CAPABILITIES: { windowed: true },
    mediaPanelRequest: 0,
    studioFocusEpoch: 0,
    studioReturnFocus: null,
    requestAnimationFrame: (fn) => frames.push(fn),
    setMusicSystemPromptExpanded() {},
    syncMusicSystemPromptSummary() {},
    updateBriefLayout() {},
    setSettingsOpen() {},
  });
  for (const name of [
    "focusAvailableControl",
    "scheduleStudioFocus",
    "setOtherModelsPopover",
    "toggleRefine",
    "toggleLyricsRefine",
    "openStudio",
    "closeStudio",
  ]) {
    const declaration = source.match(
      new RegExp(`^function ${name}\\([^]*?^}`, "m"),
    );
    assert.ok(declaration, name);
    vm.runInContext(declaration[0], api);
  }
  return {
    api,
    document,
    root,
    modal,
    canvas,
    opener,
    studio,
    flush: () => frames.splice(0).forEach((fn) => fn()),
  };
}

test("reopening Writer does not replace the external return target with its own input", () => {
  const f = fixture();
  f.opener.focus();
  f.api.openStudio();
  f.flush();
  f.api.toggleRefine(true);
  f.flush();
  f.api.openStudio();
  f.flush();
  f.api.closeStudio();
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.document.querySelector('[aria-modal="true"]'), null);
  assert.equal(f.modal.hidden, true);
});

test("closing Writer invalidates delayed focus even after another opening", () => {
  const f = fixture();
  f.opener.focus();
  f.api.openStudio();
  f.api.toggleRefine(true);
  f.api.setOtherModelsPopover(true);
  f.api.closeStudio();
  f.api.openStudio();
  f.flush();
  assert.equal(
    f.document.activeElement,
    f.root.querySelector("[data-close-studio]"),
  );
  f.api.closeStudio();
  f.flush();
  assert.equal(f.document.activeElement, f.opener);
});

test("unavailable return target falls back to canvas, including a detached opener", () => {
  for (const invalidate of [
    (e) => e.remove(),
    (e) => {
      e.hidden = true;
    },
    (e) => {
      e.disabled = true;
    },
  ]) {
    const f = fixture();
    f.opener.focus();
    f.api.openStudio();
    f.flush();
    invalidate(f.opener);
    f.api.closeStudio();
    assert.equal(f.document.activeElement, f.canvas);
  }
});

test("a refused media-editor close keeps Writer modal and its workspace active", () => {
  const f = fixture();
  f.api.openStudio();
  f.flush();
  f.studio.mediaEditor = { close: () => false };
  assert.equal(f.api.closeStudio(), false);
  assert.equal(f.root.classList.contains("is-open"), true);
  assert.equal(f.modal.getAttribute("aria-modal"), "true");
  assert.equal(f.studio.left, undefined);
});

test("verified-model popover declares modality only while open and cancels delayed focus", () => {
  const f = fixture();
  f.opener.focus();
  f.api.openStudio();
  f.flush();
  f.api.setOtherModelsPopover(true);
  f.api.setOtherModelsPopover(false);
  f.flush();
  assert.equal(
    f.root
      .querySelector("[data-other-models-popover]")
      .hasAttribute("aria-modal"),
    false,
  );
  assert.equal(
    f.document.activeElement,
    f.root.querySelector("[data-close-studio]"),
  );
});

test("Composer releases modal state and cancels delayed opening focus on close", () => {
  const source = readFileSync(
    new URL("../web/media_composer.js", import.meta.url),
    "utf8",
  );
  const window = new Window(),
    document = window.document,
    frames = [];
  document.body.innerHTML =
    '<button id="opener"></button><div id="shell"><button data-close></button></div><div id="overlay"><div role="dialog" tabindex="-1"></div></div>';
  const dom = { dialog: document.querySelector('[role="dialog"]') },
    el = document.querySelector("#overlay"),
    opener = document.querySelector("#opener"),
    state = { open: false, openGeneration: 0 };
  const api = vm.createContext({
    state,
    dom,
    el,
    document,
    shellHomes: [],
    root: { querySelector: () => null },
    $: (s) =>
      s === "[data-shell-controls]" ? document.querySelector("#shell") : null,
    setAssets: (assets) => {
      state.assets = assets;
    },
    onOpenChange() {},
    normalizeCanvas() {},
    renderAll() {},
    clearDragGhost() {},
    endCaption() {},
    requestAnimationFrame: (fn) => frames.push(fn),
  });
  vm.runInContext(
    source.slice(
      source.indexOf("  function open("),
      source.indexOf("  function destroy("),
    ),
    api,
  );
  opener.focus();
  api.open();
  assert.equal(dom.dialog.getAttribute("aria-modal"), "true");
  api.close();
  frames.splice(0).forEach((fn) => fn());
  assert.equal(dom.dialog.hasAttribute("aria-modal"), false);
  assert.equal(document.activeElement, opener);
  api.open();
  frames.splice(0).forEach((fn) => fn());
  assert.equal(document.activeElement, dom.dialog);
  api.close();
  assert.equal(document.activeElement, opener);
});
